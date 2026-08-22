import {prisma} from "../utils/prisma.js";
import {
    buildAdministrativeClassCourseOptions,
    validateStudentCourseSelection,
    WORKSPACE_TYPES,
} from "../domain/academicCatalog.js";

export async function listSchools() {
    return prisma.school.findMany({
        orderBy: {name: "asc"},
        select: {
            id: true,
            code: true,
            name: true,
            teacherAuthMode: true,
            allowOAuthTeacherLogin: true,
        },
    });
}

export async function validateAdministrativeClassStudentSelection(administrativeClassId, input) {
    const options = await getAdministrativeClassCourseOptions(administrativeClassId);
    if (!options) return null;
    const validation = validateStudentCourseSelection(options, input);
    return {
        ...validation,
        administrativeClass: options.administrativeClass,
        confirmedAt: validation.valid ? new Date() : null,
    };
}

export async function findCurrentTerm({schoolId, schoolCode}) {
    const schoolWhere = schoolId ? {id: schoolId} : {code: schoolCode};
    return prisma.academicTerm.findFirst({
        where: {
            status: "ACTIVE",
            school: schoolWhere,
        },
        orderBy: [{academicYear: "desc"}, {semester: "desc"}],
        include: {
            school: {select: {id: true, code: true, name: true}},
        },
    });
}

export async function listGrades(termId) {
    return prisma.grade.findMany({
        where: {termId},
        orderBy: [{sortOrder: "asc"}, {name: "asc"}],
    });
}

export async function listSubjects(schoolId) {
    return prisma.subject.findMany({
        where: {schoolId},
        orderBy: [{sortOrder: "asc"}, {name: "asc"}],
    });
}

export async function listWorkspaces({termId, gradeId, type}) {
    return prisma.workspace.findMany({
        where: {
            termId,
            isActive: true,
            ...(gradeId ? {gradeId} : {}),
            ...(type ? {type} : {}),
        },
        orderBy: [{type: "asc"}, {name: "asc"}],
        include: {
            subject: {
                select: {id: true, code: true, name: true, category: true, sortOrder: true},
            },
        },
    });
}

export async function getAdministrativeClassCourseOptions(administrativeClassId) {
    const administrativeClass = await prisma.workspace.findUnique({
        where: {id: administrativeClassId},
        include: {
            subjectRules: {
                include: {subject: true},
            },
            sourcedCourseGroups: {
                include: {
                    workspace: {
                        include: {subject: true},
                    },
                },
            },
        },
    });

    if (!administrativeClass) return null;
    if (administrativeClass.type !== WORKSPACE_TYPES.ADMIN_CLASS) {
        const error = new Error("指定的教学空间不是行政班");
        error.code = "NOT_ADMINISTRATIVE_CLASS";
        throw error;
    }

    return buildAdministrativeClassCourseOptions({
        administrativeClass,
        subjectRules: administrativeClass.subjectRules,
        sourcedCourseGroups: administrativeClass.sourcedCourseGroups,
    });
}
