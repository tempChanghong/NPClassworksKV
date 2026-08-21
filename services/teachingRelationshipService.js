import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";
import {
    buildTeachingRelationshipDiagnostics,
    normalizeTeachingAssignmentBatchInput,
    normalizeTeachingAssignmentInput,
} from "../domain/teachingRelationships.js";

const accountSelect = {
    id: true,
    name: true,
    email: true,
    localUsername: true,
    localDisabled: true,
    avatarUrl: true,
};

function relationshipError(message, code, statusCode = 422, details = null) {
    return authorizationError(message, code, statusCode, details);
}

function decorateAssignment(assignment, memberAccountIds) {
    return {
        ...assignment,
        hasWorkspaceAccess: memberAccountIds.has(assignment.accountId),
    };
}

export async function getTeachingRelationshipOverview({managerAccountId, schoolId, termId, gradeId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const term = await prisma.academicTerm.findFirst({where: {id: termId, schoolId}});
    if (!term) throw relationshipError("学期不存在或不属于该学校", "TERM_NOT_FOUND", 404);

    const workspaceWhere = {
        termId,
        type: {in: ["ADMIN_CLASS", "COURSE_GROUP"]},
        ...(gradeId ? {gradeId} : {}),
    };
    const [subjects, grades, workspaces, teacherAccounts] = await Promise.all([
        prisma.subject.findMany({where: {schoolId}, orderBy: [{sortOrder: "asc"}, {code: "asc"}]}),
        prisma.grade.findMany({where: {termId}, orderBy: [{sortOrder: "asc"}, {code: "asc"}]}),
        prisma.workspace.findMany({
            where: workspaceWhere,
            include: {
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
                teachingAssignments: {
                    where: {isActive: true},
                    include: {account: {select: accountSelect}},
                    orderBy: [{position: "asc"}, {account: {name: "asc"}}],
                },
                members: {select: {accountId: true, role: true}},
                _count: {select: {classroomScreens: true}},
            },
            orderBy: [{type: "asc"}, {code: "asc"}],
        }),
        prisma.account.findMany({
            where: {
                OR: [
                    {schoolMemberships: {some: {schoolId}}},
                    {workspaceMemberships: {some: {workspace: {termId}}}},
                ],
            },
            select: accountSelect,
            orderBy: [{localDisabled: "asc"}, {name: "asc"}, {localUsername: "asc"}],
        }),
    ]);

    const prepared = workspaces.map((workspace) => {
        const memberAccountIds = new Set(workspace.members.map((item) => item.accountId));
        const assignments = workspace.teachingAssignments.map((item) => decorateAssignment(item, memberAccountIds));
        return {
            ...workspace,
            members: undefined,
            teachingAssignments: undefined,
            assignments,
            subjectRules: workspace.subjectRules.map((rule) => ({
                ...rule,
                assignments: assignments.filter((assignment) => assignment.subjectId === rule.subjectId),
            })),
            sourceClasses: workspace.sourceClasses.map((source) => ({
                administrativeClassId: source.administrativeClassId,
                administrativeClass: source.administrativeClass,
            })),
        };
    });
    const administrativeClasses = prepared.filter((item) => item.type === "ADMIN_CLASS");
    const courseGroups = prepared.filter((item) => item.type === "COURSE_GROUP");
    const diagnostics = buildTeachingRelationshipDiagnostics({administrativeClasses, courseGroups});
    const summary = {
        administrativeClasses: administrativeClasses.filter((item) => item.isActive).length,
        courseGroups: courseGroups.filter((item) => item.isActive).length,
        teachingAssignments: prepared.reduce((sum, item) => sum + item.assignments.length, 0),
        errors: diagnostics.filter((item) => item.severity === "ERROR").length,
        warnings: diagnostics.filter((item) => item.severity === "WARNING").length,
    };
    return {term, subjects, grades, teacherAccounts, administrativeClasses, courseGroups, diagnostics, summary};
}

async function requireAssignmentContext(client, schoolId, {workspaceIds, subjectId, accountId}) {
    const [workspaces, subject, account] = await Promise.all([
        client.workspace.findMany({
            where: {id: {in: workspaceIds}, type: {in: ["ADMIN_CLASS", "COURSE_GROUP"]}, term: {schoolId}},
            include: {subjectRules: true},
        }),
        client.subject.findFirst({where: {id: subjectId, schoolId}}),
        client.account.findFirst({
            where: {
                id: accountId,
                OR: [
                    {schoolMemberships: {some: {schoolId}}},
                    {workspaceMemberships: {some: {workspace: {term: {schoolId}}}}},
                ],
            },
        }),
    ]);
    if (workspaces.length !== workspaceIds.length) {
        throw relationshipError("部分教学空间不存在或不属于该学校", "WORKSPACE_NOT_FOUND", 404);
    }
    if (!subject) throw relationshipError("科目不存在或不属于该学校", "SUBJECT_NOT_FOUND", 404);
    if (!account) throw relationshipError("教师账号不存在或尚未加入该学校", "TEACHER_NOT_FOUND", 404);
    for (const workspace of workspaces) {
        if (workspace.type === "COURSE_GROUP" && workspace.subjectId !== subjectId) {
            throw relationshipError(`${workspace.name}的科目与本次任课科目不一致`, "COURSE_GROUP_SUBJECT_MISMATCH", 409);
        }
        if (workspace.type === "ADMIN_CLASS" && !workspace.subjectRules.some(
            (rule) => rule.subjectId === subjectId && rule.deliveryMode === "ADMIN_CLASS",
        )) {
            throw relationshipError(`${workspace.name}没有将此科目设置为随行政班授课`, "ADMIN_CLASS_SUBJECT_MISMATCH", 409);
        }
    }
    return {workspaces, subject, account};
}

async function upsertAssignmentRecords(client, {workspaceIds, subjectId, accountId, position}) {
    const membershipRole = position === "PRIMARY" ? "TEACHER" : "ASSISTANT";
    const results = [];
    for (const workspaceId of workspaceIds) {
        const existingMembership = await client.workspaceMember.findUnique({
            where: {workspaceId_accountId: {workspaceId, accountId}},
        });
        if (!existingMembership) {
            await client.workspaceMember.create({data: {workspaceId, accountId, role: membershipRole}});
        } else {
            const shouldUpgrade = existingMembership.role === "VIEWER" ||
                (position === "PRIMARY" && existingMembership.role === "ASSISTANT");
            if (shouldUpgrade) {
                await client.workspaceMember.update({
                    where: {workspaceId_accountId: {workspaceId, accountId}},
                    data: {role: membershipRole},
                });
            }
        }
        results.push(await client.teachingAssignment.upsert({
            where: {workspaceId_subjectId_accountId: {workspaceId, subjectId, accountId}},
            update: {position, isActive: true},
            create: {workspaceId, subjectId, accountId, position},
            include: {account: {select: accountSelect}},
        }));
    }
    return results;
}

export async function upsertTeachingAssignment({managerAccountId, schoolId, input}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const normalized = normalizeTeachingAssignmentInput(input);
    if (!normalized.valid) {
        throw relationshipError("任课关系配置无效", "TEACHING_ASSIGNMENT_INVALID", 422, {errors: normalized.errors});
    }
    const batch = {...normalized.value, workspaceIds: [normalized.value.workspaceId]};
    await requireAssignmentContext(prisma, schoolId, batch);
    const assignments = await prisma.$transaction((tx) => upsertAssignmentRecords(tx, batch));
    return assignments[0];
}

export async function upsertTeachingAssignmentBatch({managerAccountId, schoolId, input}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const normalized = normalizeTeachingAssignmentBatchInput(input);
    if (!normalized.valid) {
        throw relationshipError("批量任课配置无效", "TEACHING_ASSIGNMENT_BATCH_INVALID", 422, {errors: normalized.errors});
    }
    await requireAssignmentContext(prisma, schoolId, normalized.value);
    const assignments = await prisma.$transaction(
        (tx) => upsertAssignmentRecords(tx, normalized.value),
        {timeout: 30000},
    );
    return {assignments, count: assignments.length};
}

export async function removeTeachingAssignment({managerAccountId, schoolId, assignmentId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const assignment = await prisma.teachingAssignment.findFirst({
        where: {id: assignmentId, workspace: {term: {schoolId}}},
    });
    if (!assignment) throw relationshipError("任课关系不存在", "TEACHING_ASSIGNMENT_NOT_FOUND", 404);
    await prisma.teachingAssignment.delete({where: {id: assignment.id}});
    return {id: assignment.id};
}
