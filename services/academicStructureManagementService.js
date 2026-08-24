import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";
import {
    normalizeSourceClassIds,
    normalizeSubjectRules,
    normalizeWorkspaceCode,
    validateAdministrativeClassFields,
    validateCourseGroupFields,
    validateGradeFields,
} from "../domain/academicStructureManagement.js";

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

export async function updateManagedGrade({managerAccountId, schoolId, gradeId, code, name, sortOrder}) {
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
    return prisma.grade.update({where: {id: existing.id}, data: input});
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

export async function updateManagedAdministrativeClass({
    managerAccountId,
    schoolId,
    administrativeClassId,
    code,
    name,
    isStudentSelectable,
    isActive,
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const existing = await prisma.workspace.findFirst({
        where: {id: administrativeClassId, type: "ADMIN_CLASS", term: {schoolId}},
    });
    if (!existing) throw structureError("行政班不存在或不属于该学校", "ADMIN_CLASS_NOT_FOUND", 404);
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
    await prisma.workspace.update({
        where: {id: existing.id},
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
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const existing = await prisma.workspace.findFirst({
        where: {id: courseGroupId, type: "COURSE_GROUP", term: {schoolId}},
        include: {sourceClasses: true, _count: {select: {publicationTargets: true}}},
    });
    if (!existing) throw structureError("走班教学班不存在", "COURSE_GROUP_NOT_FOUND", 404);
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
        await tx.workspace.update({
            where: {id: existing.id},
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
