import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";
import {
    buildStaffResponsibilityDiagnostics,
    normalizeClassLeadershipInput,
    normalizeGradeLeadershipInput,
} from "../domain/staffResponsibilities.js";

const accountSelect = {
    id: true,
    name: true,
    email: true,
    localUsername: true,
    localDisabled: true,
    avatarUrl: true,
};

function staffError(message, code, statusCode = 422, details = null) {
    return authorizationError(message, code, statusCode, details);
}

async function requireSchoolAccount(client, schoolId, accountId) {
    const account = await client.account.findFirst({
        where: {
            id: accountId,
            OR: [
                {schoolMemberships: {some: {schoolId}}},
                {workspaceMemberships: {some: {workspace: {term: {schoolId}}}}},
                {teachingAssignments: {some: {workspace: {term: {schoolId}}}}},
            ],
        },
        select: accountSelect,
    });
    if (!account) throw staffError("教师账号不存在或尚未加入该学校", "STAFF_ACCOUNT_NOT_FOUND", 404);
    return account;
}

export async function getStaffResponsibilityOverview({managerAccountId, schoolId, termId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const [school, term] = await Promise.all([
        prisma.school.findUnique({
            where: {id: schoolId},
            select: {
                id: true,
                code: true,
                name: true,
                gradeLeaderMustBeHomeroom: true,
                gradeLeaderMustTeach: true,
                homeroomMustTeach: true,
            },
        }),
        prisma.academicTerm.findFirst({where: {id: termId, schoolId}}),
    ]);
    if (!school || !term) throw staffError("学校或学期不存在", "STAFF_SCOPE_NOT_FOUND", 404);

    const [teacherAccounts, grades, administrativeClasses, teachingAssignments] = await Promise.all([
        prisma.account.findMany({
            where: {
                OR: [
                    {schoolMemberships: {some: {schoolId}}},
                    {workspaceMemberships: {some: {workspace: {termId}}}},
                    {teachingAssignments: {some: {workspace: {termId}}}},
                ],
            },
            select: accountSelect,
            orderBy: [{localDisabled: "asc"}, {name: "asc"}, {localUsername: "asc"}],
        }),
        prisma.grade.findMany({
            where: {termId},
            include: {
                leaderships: {
                    where: {isActive: true},
                    include: {account: {select: accountSelect}},
                    orderBy: [{position: "asc"}, {account: {name: "asc"}}],
                },
            },
            orderBy: [{sortOrder: "asc"}, {code: "asc"}],
        }),
        prisma.workspace.findMany({
            where: {termId, type: "ADMIN_CLASS"},
            include: {
                leaderships: {
                    where: {isActive: true},
                    include: {account: {select: accountSelect}},
                    orderBy: [{position: "asc"}, {account: {name: "asc"}}],
                },
            },
            orderBy: {code: "asc"},
        }),
        prisma.teachingAssignment.findMany({
            where: {isActive: true, workspace: {termId}},
            include: {
                account: {select: accountSelect},
                subject: {select: {id: true, code: true, name: true, sortOrder: true}},
                workspace: {select: {id: true, code: true, name: true, type: true, gradeId: true}},
            },
            orderBy: [{subject: {sortOrder: "asc"}}, {workspace: {code: "asc"}}],
        }),
    ]);
    const gradesWithAssignments = grades.map((grade) => ({
        ...grade,
        teachingAssignments: teachingAssignments.filter((item) => item.workspace.gradeId === grade.id),
    }));
    const diagnostics = buildStaffResponsibilityDiagnostics({
        school,
        grades: gradesWithAssignments,
        administrativeClasses,
    });
    const people = teacherAccounts.map((account) => ({
        account,
        gradeLeaderships: grades.flatMap((grade) => grade.leaderships
            .filter((item) => item.accountId === account.id)
            .map((item) => ({...item, grade: {id: grade.id, code: grade.code, name: grade.name}}))),
        classLeaderships: administrativeClasses.flatMap((administrativeClass) => administrativeClass.leaderships
            .filter((item) => item.accountId === account.id)
            .map((item) => ({
                ...item,
                administrativeClass: {
                    id: administrativeClass.id,
                    code: administrativeClass.code,
                    name: administrativeClass.name,
                    gradeId: administrativeClass.gradeId,
                },
            }))),
        teachingAssignments: teachingAssignments.filter((item) => item.accountId === account.id),
    }));
    return {
        school,
        term,
        teacherAccounts,
        grades: gradesWithAssignments,
        administrativeClasses,
        teachingAssignments,
        people,
        diagnostics,
        summary: {
            people: teacherAccounts.length,
            gradeLeaderships: grades.reduce((sum, grade) => sum + grade.leaderships.length, 0),
            classLeaderships: administrativeClasses.reduce((sum, item) => sum + item.leaderships.length, 0),
            teachingAssignments: teachingAssignments.length,
            errors: diagnostics.filter((item) => item.severity === "ERROR").length,
            warnings: diagnostics.filter((item) => item.severity === "WARNING").length,
        },
    };
}

export async function upsertGradeLeadership({managerAccountId, schoolId, input}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const normalized = normalizeGradeLeadershipInput(input);
    if (!normalized.valid) {
        throw staffError("年级职责配置无效", "GRADE_LEADERSHIP_INVALID", 422, {errors: normalized.errors});
    }
    const {gradeId, accountId, position} = normalized.value;
    const [grade] = await Promise.all([
        prisma.grade.findFirst({where: {id: gradeId, term: {schoolId}}}),
        requireSchoolAccount(prisma, schoolId, accountId),
    ]);
    if (!grade) throw staffError("年级不存在或不属于该学校", "GRADE_NOT_FOUND", 404);
    return prisma.gradeLeadership.upsert({
        where: {gradeId_accountId: {gradeId, accountId}},
        update: {position, isActive: true},
        create: {gradeId, accountId, position},
        include: {account: {select: accountSelect}},
    });
}

export async function upsertClassLeadership({managerAccountId, schoolId, input}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const normalized = normalizeClassLeadershipInput(input);
    if (!normalized.valid) {
        throw staffError("班主任职责配置无效", "CLASS_LEADERSHIP_INVALID", 422, {errors: normalized.errors});
    }
    const {administrativeClassId, accountId, position} = normalized.value;
    const [administrativeClass] = await Promise.all([
        prisma.workspace.findFirst({where: {id: administrativeClassId, type: "ADMIN_CLASS", term: {schoolId}}}),
        requireSchoolAccount(prisma, schoolId, accountId),
    ]);
    if (!administrativeClass) throw staffError("行政班不存在或不属于该学校", "ADMIN_CLASS_NOT_FOUND", 404);
    return prisma.administrativeClassLeadership.upsert({
        where: {administrativeClassId_accountId: {administrativeClassId, accountId}},
        update: {position, isActive: true},
        create: {administrativeClassId, accountId, position},
        include: {account: {select: accountSelect}},
    });
}

export async function removeGradeLeadership({managerAccountId, schoolId, leadershipId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const leadership = await prisma.gradeLeadership.findFirst({
        where: {id: leadershipId, grade: {term: {schoolId}}},
    });
    if (!leadership) throw staffError("年级职责不存在", "GRADE_LEADERSHIP_NOT_FOUND", 404);
    await prisma.gradeLeadership.delete({where: {id: leadership.id}});
    return {id: leadership.id};
}

export async function removeClassLeadership({managerAccountId, schoolId, leadershipId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const leadership = await prisma.administrativeClassLeadership.findFirst({
        where: {id: leadershipId, administrativeClass: {term: {schoolId}}},
    });
    if (!leadership) throw staffError("班主任职责不存在", "CLASS_LEADERSHIP_NOT_FOUND", 404);
    await prisma.administrativeClassLeadership.delete({where: {id: leadership.id}});
    return {id: leadership.id};
}

export async function updateStaffResponsibilityPolicy({managerAccountId, schoolId, input}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const data = {};
    for (const key of ["gradeLeaderMustBeHomeroom", "gradeLeaderMustTeach", "homeroomMustTeach"]) {
        if (typeof input?.[key] === "boolean") data[key] = input[key];
    }
    if (!Object.keys(data).length) throw staffError("没有可更新的岗位联动规则", "STAFF_POLICY_EMPTY", 400);
    return prisma.school.update({
        where: {id: schoolId},
        data,
        select: {
            gradeLeaderMustBeHomeroom: true,
            gradeLeaderMustTeach: true,
            homeroomMustTeach: true,
        },
    });
}
