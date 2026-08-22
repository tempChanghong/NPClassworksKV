import {prisma} from "../utils/prisma.js";
import bcrypt from "bcrypt";
import {validateOrganizationImport} from "../domain/organizationImport.js";
import {
    assertCanBootstrapSchool,
    assertSchoolManager,
    authorizationError,
} from "./academicAuthorizationService.js";

function toDateOrNull(value) {
    return value ? new Date(value) : null;
}

/**
 * Validate an organization document and optionally import it transactionally.
 * Existing rows with the same stable code are updated. Omitted workspaces are
 * left untouched, while subject rules and source-class links for imported
 * workspaces are replaced by the document.
 */
export async function importOrganization({accountId, document, dryRun = false}) {
    const validation = validateOrganizationImport(document);
    if (!validation.valid) return {...validation, imported: false, dryRun};

    const {normalized} = validation;
    const teacherSharedPassword = typeof document?.school?.teacherAuth?.sharedPassword === "string"
        ? document.school.teacherAuth.sharedPassword
        : "";
    const existingSchool = await prisma.school.findUnique({
        where: {code: normalized.school.code},
    });

    if (existingSchool) {
        await assertSchoolManager(accountId, existingSchool.id);
    } else {
        await assertCanBootstrapSchool(accountId);
        const bootstrapAccount = await prisma.account.findUnique({where: {id: accountId}});
        const expectedSchoolCode = bootstrapAccount?.provider === "school-local"
            ? bootstrapAccount.providerData?.schoolCode
            : null;
        if (expectedSchoolCode && expectedSchoolCode !== normalized.school.code) {
            throw authorizationError(
                `首位管理员创建时使用的学校代码为 ${expectedSchoolCode}，组织配置必须使用相同代码`,
                "BOOTSTRAP_SCHOOL_CODE_MISMATCH",
                409,
            );
        }
    }

    if (
        normalized.school.teacherAuthMode === "SHARED_PASSWORD" &&
        !teacherSharedPassword &&
        !existingSchool?.teacherSharedPasswordHash
    ) {
        throw authorizationError(
            "选择学校通用口令模式时，首次导入必须设置通用教师口令",
            "SHARED_TEACHER_PASSWORD_REQUIRED",
            400,
        );
    }

    if (dryRun) {
        return {
            ...validation,
            imported: false,
            dryRun: true,
            existingSchool: existingSchool
                ? {id: existingSchool.id, code: existingSchool.code, name: existingSchool.name}
                : null,
        };
    }

    const sharedPasswordHash = teacherSharedPassword
        ? await bcrypt.hash(teacherSharedPassword, 12)
        : null;
    const result = await prisma.$transaction(async (tx) => {
        const school = await tx.school.upsert({
            where: {code: normalized.school.code},
            update: {
                name: normalized.school.name,
                teacherAuthMode: normalized.school.teacherAuthMode,
                allowOAuthTeacherLogin: normalized.school.allowOAuthTeacherLogin,
                ...(sharedPasswordHash ? {teacherSharedPasswordHash: sharedPasswordHash} : {}),
            },
            create: {
                code: normalized.school.code,
                name: normalized.school.name,
                teacherAuthMode: normalized.school.teacherAuthMode,
                allowOAuthTeacherLogin: normalized.school.allowOAuthTeacherLogin,
                teacherSharedPasswordHash: sharedPasswordHash,
            },
        });

        if (!existingSchool) {
            await tx.schoolMember.create({
                data: {schoolId: school.id, accountId, role: "OWNER"},
            });
        }

        if (normalized.term.status === "ACTIVE") {
            await tx.academicTerm.updateMany({
                where: {schoolId: school.id, status: "ACTIVE"},
                data: {status: "ARCHIVED"},
            });
        }

        const term = await tx.academicTerm.upsert({
            where: {
                schoolId_academicYear_semester: {
                    schoolId: school.id,
                    academicYear: normalized.term.academicYear,
                    semester: normalized.term.semester,
                },
            },
            update: {
                name: normalized.term.name,
                startsAt: toDateOrNull(normalized.term.startsAt),
                endsAt: toDateOrNull(normalized.term.endsAt),
                status: normalized.term.status,
            },
            create: {
                schoolId: school.id,
                name: normalized.term.name,
                academicYear: normalized.term.academicYear,
                semester: normalized.term.semester,
                startsAt: toDateOrNull(normalized.term.startsAt),
                endsAt: toDateOrNull(normalized.term.endsAt),
                status: normalized.term.status,
            },
        });

        const grade = await tx.grade.upsert({
            where: {termId_code: {termId: term.id, code: normalized.grade.code}},
            update: {name: normalized.grade.name, sortOrder: normalized.grade.sortOrder},
            create: {termId: term.id, ...normalized.grade},
        });

        const subjectByCode = new Map();
        for (const subjectData of normalized.subjects) {
            const subject = await tx.subject.upsert({
                where: {schoolId_code: {schoolId: school.id, code: subjectData.code}},
                update: {
                    name: subjectData.name,
                    category: subjectData.category,
                    sortOrder: subjectData.sortOrder,
                },
                create: {schoolId: school.id, ...subjectData},
            });
            subjectByCode.set(subject.code, subject);
        }

        const workspaceByCode = new Map();
        for (const adminClassData of normalized.administrativeClasses) {
            const workspace = await tx.workspace.upsert({
                where: {termId_code: {termId: term.id, code: adminClassData.code}},
                update: {
                    name: adminClassData.name,
                    gradeId: grade.id,
                    subjectId: null,
                    type: "ADMIN_CLASS",
                    isActive: true,
                },
                create: {
                    termId: term.id,
                    gradeId: grade.id,
                    name: adminClassData.name,
                    code: adminClassData.code,
                    type: "ADMIN_CLASS",
                },
            });
            workspaceByCode.set(workspace.code, workspace);

            await tx.administrativeClassSubject.deleteMany({
                where: {administrativeClassId: workspace.id},
            });
            if (adminClassData.subjectRules.length > 0) {
                await tx.administrativeClassSubject.createMany({
                    data: adminClassData.subjectRules.map((rule) => ({
                        administrativeClassId: workspace.id,
                        subjectId: subjectByCode.get(rule.subjectCode).id,
                        deliveryMode: rule.deliveryMode,
                        isCompulsory: rule.isCompulsory,
                    })),
                });
            }
        }

        for (const groupData of normalized.courseGroups) {
            const subject = subjectByCode.get(groupData.subjectCode);
            const workspace = await tx.workspace.upsert({
                where: {termId_code: {termId: term.id, code: groupData.code}},
                update: {
                    name: groupData.name,
                    gradeId: grade.id,
                    subjectId: subject.id,
                    type: "COURSE_GROUP",
                    isActive: true,
                    isStudentSelectable: groupData.isStudentSelectable,
                },
                create: {
                    termId: term.id,
                    gradeId: grade.id,
                    subjectId: subject.id,
                    name: groupData.name,
                    code: groupData.code,
                    type: "COURSE_GROUP",
                    isStudentSelectable: groupData.isStudentSelectable,
                },
            });
            workspaceByCode.set(workspace.code, workspace);
        }

        for (const groupData of normalized.courseGroups) {
            const group = workspaceByCode.get(groupData.code);
            await tx.workspaceSourceClass.deleteMany({where: {workspaceId: group.id}});
            await tx.workspaceSourceClass.createMany({
                data: groupData.sourceClasses.map((adminCode) => ({
                    workspaceId: group.id,
                    administrativeClassId: workspaceByCode.get(adminCode).id,
                })),
            });
        }

        return {
            school: {id: school.id, code: school.code, name: school.name},
            term: {id: term.id, name: term.name, status: term.status},
            grade: {id: grade.id, code: grade.code, name: grade.name},
        };
    }, {timeout: 30000});

    return {
        ...validation,
        normalized: undefined,
        imported: true,
        dryRun: false,
        result,
    };
}

export async function setAcademicTermStatus({accountId, termId, status}) {
    if (!new Set(["DRAFT", "ACTIVE", "ARCHIVED"]).has(status)) {
        throw authorizationError("无效的学期状态", "INVALID_TERM_STATUS", 400, {status});
    }
    const term = await prisma.academicTerm.findUnique({where: {id: termId}});
    if (!term) throw authorizationError("学期不存在", "TERM_NOT_FOUND", 404);
    await assertSchoolManager(accountId, term.schoolId);

    return prisma.$transaction(async (tx) => {
        if (status === "ACTIVE") {
            await tx.academicTerm.updateMany({
                where: {schoolId: term.schoolId, status: "ACTIVE", id: {not: term.id}},
                data: {status: "ARCHIVED"},
            });
        }
        return tx.academicTerm.update({where: {id: term.id}, data: {status}});
    });
}

export async function cloneAcademicTerm({accountId, sourceTermId, target}) {
    const source = await prisma.academicTerm.findUnique({
        where: {id: sourceTermId},
        include: {
            grades: {include: {leaderships: {where: {isActive: true}}}},
            workspaces: {
                include: {
                    subjectRules: true,
                    sourceClasses: true,
                    members: true,
                    teachingAssignments: {where: {isActive: true}},
                    leaderships: {where: {isActive: true}},
                    pendingInvitations: {where: {claimedAt: null}},
                },
            },
        },
    });
    if (!source) throw authorizationError("源学期不存在", "TERM_NOT_FOUND", 404);
    await assertSchoolManager(accountId, source.schoolId);

    const academicYear = Number(target?.academicYear);
    const semester = Number(target?.semester);
    const name = typeof target?.name === "string" ? target.name.trim() : "";
    if (
        !name ||
        !Number.isInteger(academicYear) || academicYear < 2000 || academicYear > 2200 ||
        !Number.isInteger(semester) || semester < 1 || semester > 3
    ) {
        throw authorizationError("需要有效的目标学期名称、学年和学期序号", "INVALID_TARGET_TERM", 400);
    }
    for (const field of ["startsAt", "endsAt"]) {
        if (target?.[field] && Number.isNaN(Date.parse(target[field]))) {
            throw authorizationError(`${field}不是有效日期`, "INVALID_TARGET_TERM_DATE", 400, {field});
        }
    }

    const existing = await prisma.academicTerm.findUnique({
        where: {schoolId_academicYear_semester: {schoolId: source.schoolId, academicYear, semester}},
    });
    if (existing) {
        throw authorizationError("目标学期已经存在", "TARGET_TERM_EXISTS", 409, {termId: existing.id});
    }

    const transitionMode = target?.transitionMode === true;
    const carry = {
        workspaceMembers: target?.carryWorkspaceMembers !== false,
        teachingAssignments: transitionMode ? target?.carryTeachingAssignments !== false : true,
        leaderships: transitionMode ? target?.carryLeaderships !== false : true,
        pendingInvitations: transitionMode ? target?.carryPendingInvitations === true : true,
    };

    return prisma.$transaction(async (tx) => {
        const newTerm = await tx.academicTerm.create({
            data: {
                schoolId: source.schoolId,
                name,
                academicYear,
                semester,
                startsAt: toDateOrNull(target.startsAt),
                endsAt: toDateOrNull(target.endsAt),
                status: "DRAFT",
            },
        });

        const gradeIdMap = new Map();
        for (const grade of source.grades) {
            const cloned = await tx.grade.create({
                data: {
                    termId: newTerm.id,
                    code: grade.code,
                    name: grade.name,
                    sortOrder: grade.sortOrder,
                },
            });
            gradeIdMap.set(grade.id, cloned.id);
            if (carry.leaderships && grade.leaderships.length > 0) {
                await tx.gradeLeadership.createMany({
                    data: grade.leaderships.map((leadership) => ({
                        gradeId: cloned.id,
                        accountId: leadership.accountId,
                        position: leadership.position,
                        isActive: leadership.isActive,
                    })),
                });
            }
        }

        const workspaceIdMap = new Map();
        for (const workspace of source.workspaces) {
            const cloned = await tx.workspace.create({
                data: {
                    termId: newTerm.id,
                    gradeId: workspace.gradeId ? gradeIdMap.get(workspace.gradeId) : null,
                    subjectId: workspace.subjectId,
                    name: workspace.name,
                    code: workspace.code,
                    type: workspace.type,
                    isActive: workspace.isActive,
                    isStudentSelectable: workspace.isStudentSelectable,
                },
            });
            workspaceIdMap.set(workspace.id, cloned.id);
        }

        for (const workspace of source.workspaces) {
            const clonedWorkspaceId = workspaceIdMap.get(workspace.id);
            if (workspace.subjectRules.length > 0) {
                await tx.administrativeClassSubject.createMany({
                    data: workspace.subjectRules.map((rule) => ({
                        administrativeClassId: clonedWorkspaceId,
                        subjectId: rule.subjectId,
                        deliveryMode: rule.deliveryMode,
                        isCompulsory: rule.isCompulsory,
                    })),
                });
            }
            if (workspace.sourceClasses.length > 0) {
                await tx.workspaceSourceClass.createMany({
                    data: workspace.sourceClasses.map((relation) => ({
                        workspaceId: clonedWorkspaceId,
                        administrativeClassId: workspaceIdMap.get(relation.administrativeClassId),
                    })),
                });
            }
            if (carry.workspaceMembers && workspace.members.length > 0) {
                await tx.workspaceMember.createMany({
                    data: workspace.members.map((member) => ({
                        workspaceId: clonedWorkspaceId,
                        accountId: member.accountId,
                        role: member.role,
                    })),
                });
            }
            if (carry.teachingAssignments && workspace.teachingAssignments.length > 0) {
                await tx.teachingAssignment.createMany({
                    data: workspace.teachingAssignments.map((assignment) => ({
                        workspaceId: clonedWorkspaceId,
                        subjectId: assignment.subjectId,
                        accountId: assignment.accountId,
                        position: assignment.position,
                        isActive: assignment.isActive,
                    })),
                });
            }
            if (carry.leaderships && workspace.type === "ADMIN_CLASS" && workspace.leaderships.length > 0) {
                await tx.administrativeClassLeadership.createMany({
                    data: workspace.leaderships.map((leadership) => ({
                        administrativeClassId: clonedWorkspaceId,
                        accountId: leadership.accountId,
                        position: leadership.position,
                        isActive: leadership.isActive,
                    })),
                });
            }
            if (carry.pendingInvitations && workspace.pendingInvitations.length > 0) {
                await tx.workspaceMemberInvite.createMany({
                    data: workspace.pendingInvitations.map((invitation) => ({
                        workspaceId: clonedWorkspaceId,
                        email: invitation.email,
                        normalizedEmail: invitation.normalizedEmail,
                        role: invitation.role,
                        invitedByAccountId: invitation.invitedByAccountId,
                    })),
                });
            }
        }

        return {
            id: newTerm.id,
            name: newTerm.name,
            status: newTerm.status,
            grades: gradeIdMap.size,
            workspaces: workspaceIdMap.size,
            pendingInvitations: source.workspaces.reduce(
                (total, workspace) => total + (carry.pendingInvitations ? workspace.pendingInvitations.length : 0),
                0,
            ),
            teachingAssignments: source.workspaces.reduce(
                (total, workspace) => total + (carry.teachingAssignments ? workspace.teachingAssignments.length : 0),
                0,
            ),
            leaderships: carry.leaderships
                ? source.grades.reduce((sum, grade) => sum + grade.leaderships.length, 0) +
                    source.workspaces.reduce((sum, workspace) => sum + workspace.leaderships.length, 0)
                : 0,
            carry,
        };
    }, {timeout: 30000});
}
