import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";
import {
    normalizeSourceClassIds,
    normalizeSubjectRules,
    normalizeWorkspaceCode,
    validateAdministrativeClassFields,
    validateCourseGroupFields,
    validateGradeFields,
    validateSubjectFields,
} from "../domain/academicStructureManagement.js";
import {updateVersionedRecord} from "./optimisticConcurrencyService.js";

const managedWorkspaceInclude = {
    grade: {select: {id: true, code: true, name: true}},
    subject: {select: {id: true, code: true, name: true, category: true, sortOrder: true}},
    subjectRules: {
        include: {subject: {select: {id: true, code: true, name: true, category: true, sortOrder: true}}},
        orderBy: {subject: {sortOrder: "asc"}},
    },
    sourceClasses: {
        include: {administrativeClass: {select: {id: true, code: true, name: true, isActive: true}}},
        orderBy: {administrativeClass: {code: "asc"}},
    },
    _count: {select: {members: true, publicationTargets: true}},
};

function structureError(message, code, statusCode = 422, details = null) {
    return authorizationError(message, code, statusCode, details);
}

async function requireManagedTerm(client, schoolId, termId) {
    const term = await client.academicTerm.findFirst({where: {id: termId, schoolId}});
    if (!term) throw structureError("学期不存在或不属于该学校", "TERM_NOT_FOUND", 404);
    return term;
}

async function requireAdministrativeClass(client, schoolId, classId) {
    const administrativeClass = await client.workspace.findFirst({
        where: {id: classId, type: "ADMIN_CLASS", term: {schoolId}},
        include: {term: true, grade: true, subjectRules: true},
    });
    if (!administrativeClass) {
        throw structureError("行政班不存在或不属于该学校", "ADMIN_CLASS_NOT_FOUND", 404);
    }
    return administrativeClass;
}

async function validateSubjects(client, schoolId, subjectIds) {
    const subjects = await client.subject.findMany({where: {schoolId, id: {in: subjectIds}}});
    if (subjects.length !== new Set(subjectIds).size) {
        throw structureError("授课规则包含不属于该学校的科目", "SUBJECT_INVALID");
    }
    return subjects;
}

async function validateCourseGroupSources(client, {schoolId, termId, gradeId, subjectId, sourceClassIds}) {
    const ids = normalizeSourceClassIds(sourceClassIds);
    const sourceClasses = await client.workspace.findMany({
        where: {
            id: {in: ids},
            termId,
            gradeId,
            type: "ADMIN_CLASS",
            term: {schoolId},
        },
        include: {subjectRules: true},
    });
    if (sourceClasses.length !== ids.length) {
        throw structureError("来源行政班必须属于同一学校、学期和年级", "SOURCE_CLASS_INVALID");
    }
    const conflicts = sourceClasses.filter((source) => !source.subjectRules.some(
        (rule) => rule.subjectId === subjectId && rule.deliveryMode === "COURSE_GROUP",
    ));
    if (conflicts.length) {
        throw structureError(
            "部分来源行政班没有将该科设置为走班",
            "SOURCE_CLASS_DELIVERY_CONFLICT",
            409,
            {administrativeClasses: conflicts.map((item) => ({id: item.id, code: item.code, name: item.name}))},
        );
    }
    return sourceClasses;
}

export async function getManagedAcademicStructure({managerAccountId, schoolId, termId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const term = await requireManagedTerm(prisma, schoolId, termId);
    const [subjects, grades, workspaces] = await Promise.all([
        prisma.subject.findMany({where: {schoolId}, orderBy: [{sortOrder: "asc"}, {code: "asc"}]}),
        prisma.grade.findMany({where: {termId}, orderBy: [{sortOrder: "asc"}, {code: "asc"}]}),
        prisma.workspace.findMany({
            where: {termId, type: {in: ["ADMIN_CLASS", "COURSE_GROUP"]}},
            include: managedWorkspaceInclude,
            orderBy: [{type: "asc"}, {code: "asc"}],
        }),
    ]);
    return {
        term,
        subjects,
        grades,
        administrativeClasses: workspaces.filter((item) => item.type === "ADMIN_CLASS"),
        courseGroups: workspaces.filter((item) => item.type === "COURSE_GROUP"),
    };
}

export async function createManagedGrade({managerAccountId, schoolId, termId, code, name, sortOrder = 0}) {
    await assertSchoolManager(managerAccountId, schoolId);
    await requireManagedTerm(prisma, schoolId, termId);
    const input = {
        code: normalizeWorkspaceCode(code),
        name: typeof name === "string" ? name.trim() : "",
        sortOrder: Number(sortOrder),
    };
    const validationErrors = validateGradeFields(input);
    if (validationErrors.length) throw structureError("年级配置无效", "GRADE_INVALID", 422, {errors: validationErrors});
    const duplicate = await prisma.grade.findUnique({where: {termId_code: {termId, code: input.code}}});
    if (duplicate) throw structureError("该年级代码已存在", "GRADE_CODE_EXISTS", 409);
    return prisma.grade.create({data: {termId, ...input}});
}

export async function updateManagedGrade({managerAccountId, schoolId, gradeId, code, name, sortOrder, expectedUpdatedAt}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const existing = await prisma.grade.findFirst({where: {id: gradeId, term: {schoolId}}});
    if (!existing) throw structureError("年级不存在或不属于该学校", "GRADE_NOT_FOUND", 404);
    const input = {
        code: code === undefined ? existing.code : normalizeWorkspaceCode(code),
        name: name === undefined ? existing.name : String(name).trim(),
        sortOrder: sortOrder === undefined ? existing.sortOrder : Number(sortOrder),
    };
    const validationErrors = validateGradeFields(input);
    if (validationErrors.length) throw structureError("年级配置无效", "GRADE_INVALID", 422, {errors: validationErrors});
    const duplicate = await prisma.grade.findFirst({
        where: {termId: existing.termId, code: input.code, NOT: {id: existing.id}},
    });
    if (duplicate) throw structureError("该年级代码已存在", "GRADE_CODE_EXISTS", 409);
    return updateVersionedRecord({
        client: prisma, model: "grade", id: existing.id, expectedUpdatedAt, data: input,
    });
}

export async function createManagedSubject({managerAccountId, schoolId, code, name, category = "OTHER", sortOrder = 0}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const input = {
        code: normalizeWorkspaceCode(code),
        name: typeof name === "string" ? name.trim() : "",
        category: String(category || "OTHER").trim().toUpperCase(),
        sortOrder: Number(sortOrder),
    };
    const validationErrors = validateSubjectFields(input);
    if (validationErrors.length) throw structureError("学科配置无效", "SUBJECT_INVALID", 422, {errors: validationErrors});
    const duplicate = await prisma.subject.findUnique({where: {schoolId_code: {schoolId, code: input.code}}});
    if (duplicate) throw structureError("该学科代码已存在", "SUBJECT_CODE_EXISTS", 409);
    return prisma.subject.create({data: {schoolId, ...input}});
}

export async function updateManagedSubject({
    managerAccountId, schoolId, subjectId, code, name, category, sortOrder, expectedUpdatedAt,
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const existing = await prisma.subject.findFirst({where: {id: subjectId, schoolId}});
    if (!existing) throw structureError("学科不存在或不属于该学校", "SUBJECT_NOT_FOUND", 404);
    const input = {
        code: code === undefined ? existing.code : normalizeWorkspaceCode(code),
        name: name === undefined ? existing.name : String(name).trim(),
        category: category === undefined ? existing.category : String(category).trim().toUpperCase(),
        sortOrder: sortOrder === undefined ? existing.sortOrder : Number(sortOrder),
    };
    const validationErrors = validateSubjectFields(input);
    if (validationErrors.length) throw structureError("学科配置无效", "SUBJECT_INVALID", 422, {errors: validationErrors});
    const duplicate = await prisma.subject.findFirst({where: {schoolId, code: input.code, NOT: {id: existing.id}}});
    if (duplicate) throw structureError("该学科代码已存在", "SUBJECT_CODE_EXISTS", 409);
    return updateVersionedRecord({
        client: prisma, model: "subject", id: existing.id, expectedUpdatedAt, data: input,
    });
}

export async function createManagedAdministrativeClass({
    managerAccountId,
    schoolId,
    termId,
    gradeId,
    code,
    name,
    isStudentSelectable = true,
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    await requireManagedTerm(prisma, schoolId, termId);
    const input = {
        code: normalizeWorkspaceCode(code),
        name: typeof name === "string" ? name.trim() : "",
        gradeId,
    };
    const validationErrors = validateAdministrativeClassFields(input);
    if (validationErrors.length) {
        throw structureError("行政班配置无效", "ADMIN_CLASS_INVALID", 422, {errors: validationErrors});
    }
    const [grade, duplicate] = await Promise.all([
        prisma.grade.findFirst({where: {id: gradeId, termId}}),
        prisma.workspace.findUnique({where: {termId_code: {termId, code: input.code}}}),
    ]);
    if (!grade) throw structureError("年级不存在或不属于该学期", "GRADE_INVALID", 404);
    if (duplicate) throw structureError("该教学空间代码已存在", "WORKSPACE_CODE_EXISTS", 409);
    return prisma.workspace.create({
        data: {
            termId,
            gradeId,
            code: input.code,
            name: input.name,
            type: "ADMIN_CLASS",
            isStudentSelectable: Boolean(isStudentSelectable),
        },
        include: managedWorkspaceInclude,
    });
}

export async function createManagedAdministrativeClassesBatch({managerAccountId, schoolId, termId, classes}) {
    await assertSchoolManager(managerAccountId, schoolId);
    await requireManagedTerm(prisma, schoolId, termId);
    if (!Array.isArray(classes) || classes.length < 1 || classes.length > 100) {
        throw structureError("批量行政班数量必须为1至100个", "ADMIN_CLASS_BATCH_INVALID");
    }
    const normalized = classes.map((item) => ({
        gradeId: item?.gradeId,
        code: normalizeWorkspaceCode(item?.code),
        name: typeof item?.name === "string" ? item.name.trim() : "",
        isStudentSelectable: item?.isStudentSelectable !== false,
    }));
    const validationErrors = normalized.flatMap((item, index) =>
        validateAdministrativeClassFields(item).map((message) => `第${index + 1}个班级：${message}`));
    const duplicateCodes = normalized.map((item) => item.code)
        .filter((code, index, all) => all.indexOf(code) !== index);
    if (duplicateCodes.length) validationErrors.push(`批次内代码重复：${[...new Set(duplicateCodes)].join("、")}`);
    if (validationErrors.length) {
        throw structureError("批量行政班配置无效", "ADMIN_CLASS_BATCH_INVALID", 422, {errors: validationErrors});
    }
    const gradeIds = [...new Set(normalized.map((item) => item.gradeId))];
    const [gradeCount, existingWorkspaces] = await Promise.all([
        prisma.grade.count({where: {id: {in: gradeIds}, termId}}),
        prisma.workspace.findMany({where: {termId, code: {in: normalized.map((item) => item.code)}}, select: {code: true}}),
    ]);
    if (gradeCount !== gradeIds.length) throw structureError("部分年级不存在或不属于该学期", "GRADE_INVALID", 404);
    if (existingWorkspaces.length) {
        throw structureError(
            `教学空间代码已存在：${existingWorkspaces.map((item) => item.code).join("、")}`,
            "WORKSPACE_CODE_EXISTS",
            409,
        );
    }
    return prisma.$transaction(async (tx) => {
        const created = [];
        for (const item of normalized) {
            created.push(await tx.workspace.create({
                data: {termId, ...item, type: "ADMIN_CLASS"},
                include: managedWorkspaceInclude,
            }));
        }
        return {count: created.length, classes: created};
    }, {timeout: 30000});
}

export async function getWorkspaceChangeImpact({managerAccountId, schoolId, workspaceId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const workspace = await prisma.workspace.findFirst({
        where: {id: workspaceId, term: {schoolId}},
        select: {id: true, code: true, name: true, type: true, isActive: true},
    });
    if (!workspace) throw structureError("教学空间不存在或不属于该学校", "WORKSPACE_NOT_FOUND", 404);
    const now = new Date();
    const [workspaceMembers, teachingAssignments, pendingInvitations, publicationHistory, activePublications,
        screenBindings, students, leaderships, sourceLinks] = await Promise.all([
        prisma.workspaceMember.count({where: {workspaceId}}),
        prisma.teachingAssignment.count({where: {workspaceId, isActive: true}}),
        prisma.workspaceMemberInvite.count({where: {workspaceId, claimedAt: null}}),
        prisma.publicationTarget.count({where: {workspaceId}}),
        prisma.publicationTarget.count({where: {
            workspaceId,
            publication: {status: "PUBLISHED", OR: [{expiresAt: null}, {expiresAt: {gt: now}}]},
        }}),
        workspace.type === "ADMIN_CLASS"
            ? prisma.classroomScreenBinding.count({where: {administrativeClassId: workspaceId, isActive: true}})
            : 0,
        workspace.type === "ADMIN_CLASS"
            ? prisma.administrativeClassStudent.count({where: {administrativeClassId: workspaceId}})
            : 0,
        workspace.type === "ADMIN_CLASS"
            ? prisma.administrativeClassLeadership.count({where: {administrativeClassId: workspaceId, isActive: true}})
            : 0,
        workspace.type === "ADMIN_CLASS"
            ? prisma.workspaceSourceClass.count({where: {administrativeClassId: workspaceId}})
            : prisma.workspaceSourceClass.count({where: {workspaceId}}),
    ]);
    const counts = {workspaceMembers, teachingAssignments, pendingInvitations, publicationHistory,
        activePublications, screenBindings, students, leaderships, sourceLinks};
    const warnings = [];
    if (activePublications) warnings.push(`仍有 ${activePublications} 条正在生效的作业或通知`);
    if (screenBindings) warnings.push(`仍绑定 ${screenBindings} 台启用中的班级大屏`);
    if (students) warnings.push(`仍有 ${students} 条学生行政班归属记录`);
    if (teachingAssignments || workspaceMembers) warnings.push(`仍关联教师访问或任课关系`);
    if (leaderships) warnings.push(`仍有 ${leaderships} 条班主任职责记录`);
    if (sourceLinks) warnings.push(workspace.type === "ADMIN_CLASS"
        ? `仍被 ${sourceLinks} 个走班教学班作为来源`
        : `仍关联 ${sourceLinks} 个来源行政班`);
    return {workspace, counts, warnings, requiresConfirmation: warnings.length > 0};
}

export async function updateManagedAdministrativeClass({
    managerAccountId,
    schoolId,
    administrativeClassId,
    code,
    name,
    isStudentSelectable,
    isActive,
    confirmImpact = false,
    expectedUpdatedAt,
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const existing = await prisma.workspace.findFirst({
        where: {id: administrativeClassId, type: "ADMIN_CLASS", term: {schoolId}},
    });
    if (!existing) throw structureError("行政班不存在或不属于该学校", "ADMIN_CLASS_NOT_FOUND", 404);
    if (existing.isActive && isActive === false && !confirmImpact) {
        const impact = await getWorkspaceChangeImpact({managerAccountId, schoolId, workspaceId: existing.id});
        if (impact.requiresConfirmation) {
            throw structureError("停用行政班前需要确认影响", "ORGANIZATION_CHANGE_CONFIRMATION_REQUIRED", 409, impact);
        }
    }
    const input = {
        code: code === undefined ? existing.code : normalizeWorkspaceCode(code),
        name: name === undefined ? existing.name : String(name).trim(),
        gradeId: existing.gradeId,
    };
    const validationErrors = validateAdministrativeClassFields(input);
    if (validationErrors.length) {
        throw structureError("行政班配置无效", "ADMIN_CLASS_INVALID", 422, {errors: validationErrors});
    }
    const duplicate = await prisma.workspace.findFirst({
        where: {termId: existing.termId, code: input.code, NOT: {id: existing.id}},
    });
    if (duplicate) throw structureError("该教学空间代码已存在", "WORKSPACE_CODE_EXISTS", 409);
    await updateVersionedRecord({
        client: prisma,
        model: "workspace",
        id: existing.id,
        expectedUpdatedAt,
        data: {
            code: input.code,
            name: input.name,
            ...(isStudentSelectable === undefined ? {} : {isStudentSelectable: Boolean(isStudentSelectable)}),
            ...(isActive === undefined ? {} : {isActive: Boolean(isActive)}),
        },
    });
    return requireAdministrativeClass(prisma, schoolId, existing.id);
}

export async function replaceAdministrativeClassSubjectRules({
    managerAccountId,
    schoolId,
    administrativeClassId,
    subjectRules,
    removeConflictingSources = false,
    expectedUpdatedAt,
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const normalized = normalizeSubjectRules(subjectRules);
    if (!normalized.valid) {
        throw structureError("行政班授课规则无效", "SUBJECT_RULES_INVALID", 422, {errors: normalized.errors});
    }
    const administrativeClass = await requireAdministrativeClass(prisma, schoolId, administrativeClassId);
    await validateSubjects(prisma, schoolId, normalized.rules.map((item) => item.subjectId));
    const walkingSubjectIds = new Set(normalized.rules
        .filter((item) => item.deliveryMode === "COURSE_GROUP")
        .map((item) => item.subjectId));
    const conflictingSources = await prisma.workspaceSourceClass.findMany({
        where: {
            administrativeClassId,
            workspace: {
                type: "COURSE_GROUP",
                ...(walkingSubjectIds.size > 0 ? {subjectId: {notIn: [...walkingSubjectIds]}} : {}),
            },
        },
        include: {workspace: {select: {id: true, code: true, name: true, subjectId: true}}},
    });
    if (conflictingSources.length && !removeConflictingSources) {
        throw structureError(
            "新的授课规则与现有走班来源关系冲突",
            "SUBJECT_RULE_SOURCE_CONFLICT",
            409,
            {courseGroups: conflictingSources.map((item) => item.workspace)},
        );
    }
    await prisma.$transaction(async (tx) => {
        await updateVersionedRecord({
            client: tx,
            model: "workspace",
            id: administrativeClass.id,
            expectedUpdatedAt,
            data: {updatedAt: new Date()},
        });
        if (conflictingSources.length) {
            await tx.workspaceSourceClass.deleteMany({
                where: {
                    administrativeClassId,
                    workspaceId: {in: conflictingSources.map((item) => item.workspaceId)},
                },
            });
        }
        await tx.administrativeClassSubject.deleteMany({where: {administrativeClassId}});
        if (normalized.rules.length) {
            await tx.administrativeClassSubject.createMany({
                data: normalized.rules.map((rule) => ({administrativeClassId, ...rule})),
            });
        }
    });
    return requireAdministrativeClass(prisma, schoolId, administrativeClass.id);
}

export async function createManagedCourseGroup({
    managerAccountId,
    schoolId,
    termId,
    gradeId,
    code,
    name,
    subjectId,
    sourceClassIds,
    isStudentSelectable = true,
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    await requireManagedTerm(prisma, schoolId, termId);
    const cleanCode = normalizeWorkspaceCode(code);
    const cleanName = typeof name === "string" ? name.trim() : "";
    const sources = normalizeSourceClassIds(sourceClassIds);
    const errors = validateCourseGroupFields({code: cleanCode, name: cleanName, subjectId, sourceClassIds: sources});
    if (errors.length) throw structureError("走班教学班配置无效", "COURSE_GROUP_INVALID", 422, {errors});
    const [grade, subject, duplicate] = await Promise.all([
        prisma.grade.findFirst({where: {id: gradeId, termId}}),
        prisma.subject.findFirst({where: {id: subjectId, schoolId}}),
        prisma.workspace.findUnique({where: {termId_code: {termId, code: cleanCode}}}),
    ]);
    if (!grade) throw structureError("年级不存在或不属于该学期", "GRADE_INVALID");
    if (!subject) throw structureError("科目不存在或不属于该学校", "SUBJECT_INVALID");
    if (duplicate) throw structureError("该教学空间代码已存在", "WORKSPACE_CODE_EXISTS", 409);
    await validateCourseGroupSources(prisma, {schoolId, termId, gradeId, subjectId, sourceClassIds: sources});
    return prisma.$transaction(async (tx) => {
        const workspace = await tx.workspace.create({
            data: {
                termId,
                gradeId,
                subjectId,
                code: cleanCode,
                name: cleanName,
                type: "COURSE_GROUP",
                isStudentSelectable: Boolean(isStudentSelectable),
            },
        });
        await tx.workspaceSourceClass.createMany({
            data: sources.map((administrativeClassId) => ({workspaceId: workspace.id, administrativeClassId})),
        });
        return tx.workspace.findUnique({where: {id: workspace.id}, include: managedWorkspaceInclude});
    });
}

export async function updateManagedCourseGroup({
    managerAccountId,
    schoolId,
    courseGroupId,
    code,
    name,
    subjectId,
    sourceClassIds,
    isStudentSelectable,
    isActive,
    confirmImpact = false,
    expectedUpdatedAt,
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const existing = await prisma.workspace.findFirst({
        where: {id: courseGroupId, type: "COURSE_GROUP", term: {schoolId}},
        include: {sourceClasses: true, _count: {select: {publicationTargets: true}}},
    });
    if (!existing) throw structureError("走班教学班不存在", "COURSE_GROUP_NOT_FOUND", 404);
    if (existing.isActive && isActive === false && !confirmImpact) {
        const impact = await getWorkspaceChangeImpact({managerAccountId, schoolId, workspaceId: existing.id});
        if (impact.requiresConfirmation) {
            throw structureError("停用走班教学班前需要确认影响", "ORGANIZATION_CHANGE_CONFIRMATION_REQUIRED", 409, impact);
        }
    }
    const next = {
        code: code === undefined ? existing.code : normalizeWorkspaceCode(code),
        name: name === undefined ? existing.name : String(name).trim(),
        subjectId: subjectId === undefined ? existing.subjectId : subjectId,
        sourceClassIds: sourceClassIds === undefined
            ? existing.sourceClasses.map((item) => item.administrativeClassId)
            : normalizeSourceClassIds(sourceClassIds),
    };
    const errors = validateCourseGroupFields(next);
    if (errors.length) throw structureError("走班教学班配置无效", "COURSE_GROUP_INVALID", 422, {errors});
    if (next.subjectId !== existing.subjectId && existing._count.publicationTargets > 0) {
        throw structureError("已有作业历史的教学班不能更换科目，请新建教学班并停用旧教学班", "COURSE_GROUP_SUBJECT_LOCKED", 409);
    }
    const duplicate = await prisma.workspace.findFirst({
        where: {termId: existing.termId, code: next.code, NOT: {id: existing.id}},
    });
    if (duplicate) throw structureError("该教学空间代码已存在", "WORKSPACE_CODE_EXISTS", 409);
    const subject = await prisma.subject.findFirst({where: {id: next.subjectId, schoolId}});
    if (!subject) throw structureError("科目不存在或不属于该学校", "SUBJECT_INVALID");
    await validateCourseGroupSources(prisma, {
        schoolId,
        termId: existing.termId,
        gradeId: existing.gradeId,
        subjectId: next.subjectId,
        sourceClassIds: next.sourceClassIds,
    });
    return prisma.$transaction(async (tx) => {
        await updateVersionedRecord({
            client: tx,
            model: "workspace",
            id: existing.id,
            expectedUpdatedAt,
            data: {
                code: next.code,
                name: next.name,
                subjectId: next.subjectId,
                ...(isStudentSelectable === undefined ? {} : {isStudentSelectable: Boolean(isStudentSelectable)}),
                ...(isActive === undefined ? {} : {isActive: Boolean(isActive)}),
            },
        });
        if (sourceClassIds !== undefined) {
            await tx.workspaceSourceClass.deleteMany({where: {workspaceId: existing.id}});
            await tx.workspaceSourceClass.createMany({
                data: next.sourceClassIds.map((administrativeClassId) => ({
                    workspaceId: existing.id,
                    administrativeClassId,
                })),
            });
        }
        return tx.workspace.findUnique({where: {id: existing.id}, include: managedWorkspaceInclude});
    });
}
