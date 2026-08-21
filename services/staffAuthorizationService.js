import {prisma} from "../utils/prisma.js";
import {authorizationError} from "./academicAuthorizationService.js";

const SCHOOL_MANAGEMENT_ROLES = new Set(["OWNER", "ADMIN"]);

export async function getResponsibilityAccessForWorkspaces(accountId, workspaces, client = prisma) {
    const gradeIds = [...new Set(workspaces.map((item) => item.gradeId).filter(Boolean))];
    const directAdministrativeClassIds = workspaces
        .filter((item) => item.type === "ADMIN_CLASS")
        .map((item) => item.id);
    const sourceAdministrativeClassIds = [...new Set(workspaces.flatMap((item) =>
        (item.sourceClasses || []).map((source) => source.administrativeClassId)))];
    const allAdministrativeClassIds = [...new Set([...directAdministrativeClassIds, ...sourceAdministrativeClassIds])];
    const [gradeLeaderships, classLeaderships] = await Promise.all([
        gradeIds.length ? client.gradeLeadership.findMany({
            where: {accountId, gradeId: {in: gradeIds}, isActive: true},
            select: {gradeId: true},
        }) : [],
        allAdministrativeClassIds.length ? client.administrativeClassLeadership.findMany({
            where: {accountId, administrativeClassId: {in: allAdministrativeClassIds}, isActive: true},
            select: {administrativeClassId: true},
        }) : [],
    ]);
    const ledGradeIds = new Set(gradeLeaderships.map((item) => item.gradeId));
    const ledClassIds = new Set(classLeaderships.map((item) => item.administrativeClassId));
    const writableIds = new Set();
    const readableIds = new Set();
    for (const workspace of workspaces) {
        const gradeManaged = workspace.gradeId && ledGradeIds.has(workspace.gradeId);
        const classManaged = workspace.type === "ADMIN_CLASS" && ledClassIds.has(workspace.id);
        const relatedWalkingClass = workspace.type === "COURSE_GROUP" && (workspace.sourceClasses || [])
            .some((source) => ledClassIds.has(source.administrativeClassId));
        if (gradeManaged || classManaged) writableIds.add(workspace.id);
        if (gradeManaged || classManaged || relatedWalkingClass) readableIds.add(workspace.id);
    }
    return {writableIds, readableIds, ledGradeIds, ledClassIds};
}

export async function getResponsibilityWorkspaceIds(accountId, {
    termId,
    schoolIds = [],
} = {}, client = prisma) {
    const scope = {
        ...(termId ? {id: termId} : {}),
        ...(schoolIds.length ? {schoolId: {in: schoolIds}} : {}),
    };
    const [gradeLeaderships, classLeaderships] = await Promise.all([
        client.gradeLeadership.findMany({
            where: {accountId, isActive: true, grade: {term: scope}},
            select: {gradeId: true},
        }),
        client.administrativeClassLeadership.findMany({
            where: {accountId, isActive: true, administrativeClass: {term: scope}},
            select: {administrativeClassId: true},
        }),
    ]);
    const gradeIds = gradeLeaderships.map((item) => item.gradeId);
    const classIds = classLeaderships.map((item) => item.administrativeClassId);
    if (!gradeIds.length && !classIds.length) return {readableIds: [], writableIds: []};
    const workspaces = await client.workspace.findMany({
        where: {
            isActive: true,
            ...(termId ? {termId} : {}),
            ...(schoolIds.length ? {term: {schoolId: {in: schoolIds}}} : {}),
            OR: [
                ...(gradeIds.length ? [{gradeId: {in: gradeIds}}] : []),
                ...(classIds.length ? [
                    {id: {in: classIds}},
                    {sourceClasses: {some: {administrativeClassId: {in: classIds}}}},
                ] : []),
            ],
        },
        include: {sourceClasses: {select: {administrativeClassId: true}}},
    });
    const access = await getResponsibilityAccessForWorkspaces(accountId, workspaces, client);
    return {readableIds: [...access.readableIds], writableIds: [...access.writableIds]};
}

export async function assertCanManageTeachingWorkspaces(accountId, schoolId, workspaceIds, client = prisma) {
    const schoolMembership = await client.schoolMember.findUnique({
        where: {schoolId_accountId: {schoolId, accountId}},
    });
    if (SCHOOL_MANAGEMENT_ROLES.has(schoolMembership?.role)) return;
    const workspaces = await client.workspace.findMany({
        where: {id: {in: workspaceIds}, term: {schoolId}},
        include: {sourceClasses: {select: {administrativeClassId: true}}},
    });
    if (workspaces.length !== new Set(workspaceIds).size) {
        throw authorizationError("部分教学空间不存在", "WORKSPACE_NOT_FOUND", 404);
    }
    const access = await getResponsibilityAccessForWorkspaces(accountId, workspaces, client);
    if (workspaces.every((workspace) => access.ledGradeIds.has(workspace.gradeId))) return;
    throw authorizationError("需要学校管理员或相应年级组长权限", "GRADE_MANAGEMENT_REQUIRED", 403);
}
