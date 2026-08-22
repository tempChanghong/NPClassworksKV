import bcrypt from "bcrypt";
import crypto from "node:crypto";
import {prisma} from "../utils/prisma.js";
import {localProviderId} from "../domain/localAccount.js";
import {validateStaffConfigurationImport} from "../domain/staffConfigurationImport.js";
import {mapWithConcurrency} from "../utils/asyncPool.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";

const LOCAL_PROVIDER = "school-local";
const BCRYPT_ROUNDS = Math.min(14, Math.max(10, Number(process.env.LOCAL_AUTH_BCRYPT_ROUNDS) || 10));
const HASH_CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.STAFF_IMPORT_HASH_CONCURRENCY) || 4));
const TRANSACTION_TIMEOUT_MS = Math.min(180000, Math.max(60000, Number(process.env.STAFF_IMPORT_TRANSACTION_TIMEOUT_MS) || 120000));

function importError(message, code, statusCode = 422, details = null) {
    return authorizationError(message, code, statusCode, details);
}

function contextualValidation(validation, errors, warnings = []) {
    return {
        ...validation,
        valid: validation.valid && errors.length === 0,
        errors: [...validation.errors, ...errors],
        warnings: [...validation.warnings, ...warnings],
    };
}

function generateUniquePin(usedPins) {
    let pin;
    do pin = String(crypto.randomInt(100000, 1000000)); while (usedPins.has(pin));
    usedPins.add(pin);
    return pin;
}

export async function importStaffConfiguration({managerAccountId, schoolId, termId, document, dryRun = false}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const school = await prisma.school.findUnique({where: {id: schoolId}});
    if (!school) throw importError("学校不存在", "SCHOOL_NOT_FOUND", 404);
    const validation = validateStaffConfigurationImport(document, school.teacherAuthMode);
    if (!validation.valid) return {...validation, imported: false, dryRun};
    const normalized = validation.normalized;
    const scopeErrors = [];
    const scopeWarnings = [];
    if (normalized.schoolCode !== school.code) {
        scopeErrors.push({path: "schoolCode", code: "SCHOOL_CODE_MISMATCH", message: `教师配置属于 ${normalized.schoolCode}，当前学校为 ${school.code}`});
    }

    const term = await prisma.academicTerm.findFirst({
        where: {
            schoolId,
            ...(termId ? {id: termId} : {}),
            academicYear: normalized.term.academicYear,
            semester: normalized.term.semester,
        },
    });
    if (!term) {
        scopeErrors.push({path: "term", code: "TERM_MISMATCH", message: "教师配置指定的学期与当前 OOBE 学期不一致"});
    }
    if (!term) {
        const report = contextualValidation(validation, scopeErrors, scopeWarnings);
        return {...report, normalized: undefined, imported: false, dryRun};
    }

    const [grades, subjects, workspaces, existingAccounts] = await Promise.all([
        prisma.grade.findMany({where: {termId: term.id}}),
        prisma.subject.findMany({where: {schoolId}}),
        prisma.workspace.findMany({
            where: {termId: term.id, isActive: true},
            include: {subjectRules: true},
        }),
        prisma.account.findMany({
            where: {
                provider: LOCAL_PROVIDER,
                providerId: {in: normalized.teachers.map((teacher) => localProviderId(school.code, teacher.username))},
            },
        }),
    ]);
    const gradeByCode = new Map(grades.map((item) => [item.code, item]));
    const subjectByCode = new Map(subjects.map((item) => [item.code, item]));
    const workspaceByCode = new Map(workspaces.map((item) => [item.code, item]));
    const existingByProviderId = new Map(existingAccounts.map((item) => [item.providerId, item]));

    for (const [teacherIndex, teacher] of normalized.teachers.entries()) {
        for (const [index, assignment] of teacher.teachingAssignments.entries()) {
            const path = `teachers[${teacherIndex}].teachingAssignments[${index}]`;
            const workspace = workspaceByCode.get(assignment.workspaceCode);
            const subject = subjectByCode.get(assignment.subjectCode);
            if (!workspace) scopeErrors.push({path: `${path}.workspaceCode`, code: "UNKNOWN_WORKSPACE", message: `当前学期不存在教学空间：${assignment.workspaceCode}`});
            if (!subject) scopeErrors.push({path: `${path}.subjectCode`, code: "UNKNOWN_SUBJECT", message: `学校不存在科目：${assignment.subjectCode}`});
            if (!workspace || !subject) continue;
            if (workspace.type === "COURSE_GROUP" && workspace.subjectId !== subject.id) {
                scopeErrors.push({path, code: "COURSE_GROUP_SUBJECT_MISMATCH", message: `${workspace.name}不属于${subject.name}`});
            }
            if (workspace.type === "ADMIN_CLASS" && !workspace.subjectRules.some((rule) =>
                rule.subjectId === subject.id && rule.deliveryMode === "ADMIN_CLASS")) {
                scopeErrors.push({path, code: "ADMIN_CLASS_SUBJECT_MISMATCH", message: `${workspace.name}的${subject.name}不随行政班授课`});
            }
        }
        for (const [index, leadership] of teacher.responsibilities.gradeLeaderships.entries()) {
            if (!gradeByCode.has(leadership.gradeCode)) {
                scopeErrors.push({path: `teachers[${teacherIndex}].responsibilities.gradeLeaderships[${index}].gradeCode`, code: "UNKNOWN_GRADE", message: `当前学期不存在年级：${leadership.gradeCode}`});
            }
        }
        for (const [index, leadership] of teacher.responsibilities.classLeaderships.entries()) {
            const administrativeClass = workspaceByCode.get(leadership.classCode);
            if (!administrativeClass || administrativeClass.type !== "ADMIN_CLASS") {
                scopeErrors.push({path: `teachers[${teacherIndex}].responsibilities.classLeaderships[${index}].classCode`, code: "UNKNOWN_ADMIN_CLASS", message: `当前学期不存在行政班：${leadership.classCode}`});
            }
        }
        if (school.gradeLeaderMustTeach && teacher.responsibilities.gradeLeaderships.length && !teacher.teachingAssignments.length) {
            scopeWarnings.push({path: `teachers[${teacherIndex}]`, code: "GRADE_LEADER_NOT_TEACHING", message: `${teacher.name}是年级组长但没有任课关系`});
        }
        if (school.homeroomMustTeach && teacher.responsibilities.classLeaderships.length && !teacher.teachingAssignments.length) {
            scopeWarnings.push({path: `teachers[${teacherIndex}]`, code: "HOMEROOM_NOT_TEACHING", message: `${teacher.name}是班主任但没有任课关系`});
        }
    }

    const primaryGradeLeaders = new Map();
    const headTeachers = new Map();
    for (const teacher of normalized.teachers) {
        for (const item of teacher.responsibilities.gradeLeaderships.filter((entry) => entry.position === "PRIMARY")) {
            const names = primaryGradeLeaders.get(item.gradeCode) || [];
            names.push(teacher.name);
            primaryGradeLeaders.set(item.gradeCode, names);
        }
        for (const item of teacher.responsibilities.classLeaderships.filter((entry) => entry.position === "HEAD_TEACHER")) {
            const names = headTeachers.get(item.classCode) || [];
            names.push(teacher.name);
            headTeachers.set(item.classCode, names);
        }
    }
    for (const [code, names] of primaryGradeLeaders) {
        if (names.length > 1) scopeErrors.push({path: "teachers", code: "MULTIPLE_PRIMARY_GRADE_LEADERS", message: `${code}配置了多位主要年级组长：${names.join("、")}`});
    }
    for (const [code, names] of headTeachers) {
        if (names.length > 1) scopeErrors.push({path: "teachers", code: "MULTIPLE_HEAD_TEACHERS", message: `${code}配置了多位主班主任：${names.join("、")}`});
    }

    const report = contextualValidation(validation, scopeErrors, scopeWarnings);
    const preview = {
        ...report,
        normalized: undefined,
        imported: false,
        dryRun: true,
        term: {id: term.id, name: term.name},
        existingAccounts: existingAccounts.length,
    };
    if (!report.valid || dryRun) return preview;

    const usedPins = new Set(normalized.teachers
        .filter((teacher) => teacher.credential.mode === "FIXED_PIN")
        .map((teacher) => teacher.credential.pin));
    const credentialPlans = await mapWithConcurrency(normalized.teachers, HASH_CONCURRENCY, async (teacher) => {
        const providerId = localProviderId(school.code, teacher.username);
        const existing = existingByProviderId.get(providerId);
        let pin = "";
        if (teacher.credential.mode === "FIXED_PIN") pin = teacher.credential.pin;
        else if (teacher.credential.mode === "GENERATE_PIN" && !existing?.localPasswordHash) pin = generateUniquePin(usedPins);
        return {teacher, providerId, existing, pin, passwordHash: pin ? await bcrypt.hash(pin, BCRYPT_ROUNDS) : null};
    });

    const result = await prisma.$transaction(async (tx) => {
        const accountsByUsername = new Map();
        let createdAccounts = 0;
        for (const plan of credentialPlans) {
            const account = await tx.account.upsert({
                where: {provider_providerId: {provider: LOCAL_PROVIDER, providerId: plan.providerId}},
                update: {
                    name: plan.teacher.name,
                    localUsername: plan.teacher.username,
                    ...(plan.passwordHash ? {localPasswordHash: plan.passwordHash, tokenVersion: {increment: 1}} : {}),
                    localDisabled: false,
                    localLoginFailures: 0,
                    localLockedUntil: null,
                },
                create: {
                    provider: LOCAL_PROVIDER,
                    providerId: plan.providerId,
                    name: plan.teacher.name,
                    localUsername: plan.teacher.username,
                    localPasswordHash: plan.passwordHash,
                    providerData: {schoolCode: school.code},
                },
            });
            if (!plan.existing) createdAccounts += 1;
            accountsByUsername.set(plan.teacher.username, account);
            await tx.schoolMember.upsert({
                where: {schoolId_accountId: {schoolId, accountId: account.id}},
                update: {},
                create: {schoolId, accountId: account.id, role: "VIEWER"},
            });
        }

        let teachingAssignments = 0;
        let gradeLeaderships = 0;
        let classLeaderships = 0;
        for (const teacher of normalized.teachers) {
            const account = accountsByUsername.get(teacher.username);
            for (const assignment of teacher.teachingAssignments) {
                const workspace = workspaceByCode.get(assignment.workspaceCode);
                const subject = subjectByCode.get(assignment.subjectCode);
                const role = assignment.position === "PRIMARY" ? "TEACHER" : "ASSISTANT";
                const existingMembership = await tx.workspaceMember.findUnique({where: {workspaceId_accountId: {workspaceId: workspace.id, accountId: account.id}}});
                const shouldUpgrade = !existingMembership || existingMembership.role === "VIEWER" || (role === "TEACHER" && existingMembership.role === "ASSISTANT");
                if (!existingMembership) {
                    await tx.workspaceMember.create({data: {workspaceId: workspace.id, accountId: account.id, role}});
                } else if (shouldUpgrade) {
                    await tx.workspaceMember.update({where: {workspaceId_accountId: {workspaceId: workspace.id, accountId: account.id}}, data: {role}});
                }
                await tx.teachingAssignment.upsert({
                    where: {workspaceId_subjectId_accountId: {workspaceId: workspace.id, subjectId: subject.id, accountId: account.id}},
                    update: {position: assignment.position, isActive: true},
                    create: {workspaceId: workspace.id, subjectId: subject.id, accountId: account.id, position: assignment.position},
                });
                teachingAssignments += 1;
            }
            for (const leadership of teacher.responsibilities.gradeLeaderships) {
                const grade = gradeByCode.get(leadership.gradeCode);
                await tx.gradeLeadership.upsert({
                    where: {gradeId_accountId: {gradeId: grade.id, accountId: account.id}},
                    update: {position: leadership.position, isActive: true},
                    create: {gradeId: grade.id, accountId: account.id, position: leadership.position},
                });
                gradeLeaderships += 1;
            }
            for (const leadership of teacher.responsibilities.classLeaderships) {
                const administrativeClass = workspaceByCode.get(leadership.classCode);
                await tx.administrativeClassLeadership.upsert({
                    where: {administrativeClassId_accountId: {administrativeClassId: administrativeClass.id, accountId: account.id}},
                    update: {position: leadership.position, isActive: true},
                    create: {administrativeClassId: administrativeClass.id, accountId: account.id, position: leadership.position},
                });
                classLeaderships += 1;
            }
        }
        const importResult = {createdAccounts, updatedAccounts: normalized.teachers.length - createdAccounts, teachingAssignments, gradeLeaderships, classLeaderships};
        await tx.auditLog.create({
            data: {
                schoolId,
                actorAccountId: managerAccountId,
                actorType: "ACCOUNT",
                action: "STAFF_CONFIGURATION_IMPORT",
                entityType: "ACADEMIC_TERM",
                entityId: term.id,
                success: true,
                summary: `导入 ${normalized.teachers.length} 名教师的账号、任课与职责配置`,
                metadata: {schemaVersion: normalized.schemaVersion, summary: validation.summary, result: importResult},
            },
        });
        return importResult;
    }, {timeout: TRANSACTION_TIMEOUT_MS});

    const credentials = credentialPlans.filter((plan) => plan.pin).map((plan) => ({
        username: plan.teacher.username,
        name: plan.teacher.name,
        pin: plan.pin,
        generated: plan.teacher.credential.mode === "GENERATE_PIN",
    }));
    return {...preview, imported: true, dryRun: false, result, credentials};
}
