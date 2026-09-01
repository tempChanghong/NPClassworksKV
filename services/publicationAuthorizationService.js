import {prisma} from "../utils/prisma.js";
import {authorizationError} from "./academicAuthorizationService.js";
import {getResponsibilityAccessForWorkspaces} from "./staffAuthorizationService.js";
import {isPublicationWithinActionScope} from "../domain/publicationActionCenter.js";

const WORKSPACE_WRITE_ROLES = new Set(["OWNER", "TEACHER", "ASSISTANT"]);
const SCHOOL_WRITE_ROLES = new Set(["OWNER", "ADMIN"]);

export const publicationWorkspaceInclude = {
    term: {
        include: {school: {select: {
            id: true,
            code: true,
            name: true,
            teacherAuthMode: true,
            allowOAuthTeacherLogin: true,
        }}},
    },
    subject: {select: {id: true, code: true, name: true, category: true}},
    subjectRules: true,
    sourceClasses: {select: {administrativeClassId: true}},
};

export async function loadPublicationWorkspaces(workspaceIds, client = prisma) {
    return client.workspace.findMany({
        where: {id: {in: workspaceIds}, isActive: true},
        include: publicationWorkspaceInclude,
    });
}

async function loadAccessMaps(accountId, workspaces, client = prisma) {
    const workspaceIds = workspaces.map((workspace) => workspace.id);
    const schoolIds = [...new Set(workspaces.map((workspace) => workspace.term.schoolId))];
    const [account, workspaceMemberships, schoolMemberships, responsibilityAccess] = await Promise.all([
        client.account.findUnique({where: {id: accountId}, select: {provider: true}}),
        client.workspaceMember.findMany({
            where: {accountId, workspaceId: {in: workspaceIds}},
        }),
        client.schoolMember.findMany({
            where: {accountId, schoolId: {in: schoolIds}},
        }),
        getResponsibilityAccessForWorkspaces(accountId, workspaces, client),
    ]);
    const schoolById = new Map(workspaces.map((workspace) => [workspace.term.schoolId, workspace.term.school]));
    const schoolRoles = new Map(schoolMemberships.map((item) => [item.schoolId, item.role]));
    const permittedSchoolIds = new Set(schoolIds.filter((schoolId) => {
        if (SCHOOL_WRITE_ROLES.has(schoolRoles.get(schoolId))) return true;
        const school = schoolById.get(schoolId);
        if (account?.provider === "school-local") return school?.teacherAuthMode !== "OAUTH_EMAIL";
        return school?.teacherAuthMode === "OAUTH_EMAIL" || school?.allowOAuthTeacherLogin;
    }));
    return {
        workspaceRoles: new Map(workspaceMemberships.map((item) => [item.workspaceId, item.role])),
        schoolRoles,
        permittedSchoolIds,
        responsibilityAccess,
    };
}

export async function assertCanWriteWorkspaces(accountId, workspaces, client = prisma) {
    const writableIds = await getWritableWorkspaceIds(accountId, workspaces, client);
    const writableSet = new Set(writableIds);
    const denied = workspaces.filter((workspace) => !writableSet.has(workspace.id));
    if (denied.length > 0) {
        throw authorizationError(
            "没有部分教学空间的发布权限",
            "WORKSPACE_WRITE_FORBIDDEN",
            403,
            {workspaceIds: denied.map((workspace) => workspace.id)},
        );
    }
}

export async function getWritableWorkspaceIds(accountId, workspaces, client = prisma) {
    const access = await loadAccessMaps(accountId, workspaces, client);
    return workspaces.filter((workspace) => {
        const workspaceRole = access.workspaceRoles.get(workspace.id);
        const schoolRole = access.schoolRoles.get(workspace.term.schoolId);
        return SCHOOL_WRITE_ROLES.has(schoolRole) || (
            access.permittedSchoolIds.has(workspace.term.schoolId) && (
                WORKSPACE_WRITE_ROLES.has(workspaceRole) || access.responsibilityAccess.writableIds.has(workspace.id)
            )
        );
    }).map((workspace) => workspace.id);
}

export async function getReadableWorkspaceIds(accountId, workspaceIds, client = prisma) {
    const workspaces = await loadPublicationWorkspaces(workspaceIds, client);
    const access = await loadAccessMaps(accountId, workspaces, client);
    return workspaces
        .filter((workspace) =>
            SCHOOL_WRITE_ROLES.has(access.schoolRoles.get(workspace.term.schoolId)) || (
                access.permittedSchoolIds.has(workspace.term.schoolId) && (
                    access.workspaceRoles.has(workspace.id) || access.responsibilityAccess.readableIds.has(workspace.id)
                )
            ),
        )
        .map((workspace) => workspace.id);
}

export async function assertCanReadWorkspace(accountId, workspace, client = prisma) {
    const readableIds = await getReadableWorkspaceIds(accountId, [workspace.id], client);
    if (!readableIds.includes(workspace.id)) {
        throw authorizationError("没有该教学空间的读取权限", "WORKSPACE_READ_FORBIDDEN");
    }
}

export async function assertCanManagePublication(accountId, publication, client = prisma) {
    if (publication.authorAccountId === accountId) return;
    const workspaces = publication.targets.map((target) => target.workspace);
    const writableIds = await getWritableWorkspaceIds(accountId, workspaces, client);
    if (writableIds.length === workspaces.length) return;
    throw authorizationError(
        "只能修改自己负责教学空间中的内容",
        "PUBLICATION_MANAGE_FORBIDDEN",
    );
}

export async function assertCanCertifyPublication(accountId, publication, client = prisma) {
    const workspaces = publication.targets.map((target) => target.workspace);
    const scope = await getPublicationCertificationScope(accountId, workspaces, client);
    if (isPublicationWithinActionScope(publication, scope)) return;
    throw authorizationError(
        "只能确认自己任教学科或管理职责范围内的内容",
        "PUBLICATION_CERTIFY_FORBIDDEN",
    );
}

export async function getPublicationCertificationScope(accountId, workspaces, client = prisma) {
    if (!workspaces.length) return {fullWorkspaceIds: [], teachingAssignments: []};
    const access = await loadAccessMaps(accountId, workspaces, client);
    const workspaceIds = workspaces.map((workspace) => workspace.id);
    const teachingAssignments = await client.teachingAssignment.findMany({
        where: {accountId, workspaceId: {in: workspaceIds}, isActive: true},
        select: {workspaceId: true, subjectId: true},
    });
    const fullWorkspaceIds = workspaces
        .filter((workspace) => {
            const schoolId = workspace.term.schoolId;
            return SCHOOL_WRITE_ROLES.has(access.schoolRoles.get(schoolId)) || (
                access.permittedSchoolIds.has(schoolId) &&
                access.responsibilityAccess.writableIds.has(workspace.id)
            );
        })
        .map((workspace) => workspace.id);
    const permittedTeachingAssignments = teachingAssignments.filter((assignment) => {
        const workspace = workspaces.find((item) => item.id === assignment.workspaceId);
        return workspace && access.permittedSchoolIds.has(workspace.term.schoolId);
    });
    return {fullWorkspaceIds, teachingAssignments: permittedTeachingAssignments};
}

export async function assertCanReadPublication(accountId, publication, client = prisma) {
    if (publication.authorAccountId === accountId) return;
    const workspaces = publication.targets.map((target) => target.workspace);
    const readableIds = await getReadableWorkspaceIds(
        accountId,
        publication.targets.map((target) => target.workspaceId),
        client,
    );
    if (readableIds.length === 0) {
        throw authorizationError("没有该发布内容的读取权限", "PUBLICATION_READ_FORBIDDEN");
    }
    if (publication.status !== "PUBLISHED") {
        const writableIds = await getWritableWorkspaceIds(accountId, workspaces, client);
        if (writableIds.length === 0) {
            throw authorizationError("没有该未发布内容的读取权限", "PUBLICATION_DRAFT_READ_FORBIDDEN");
        }
    }
}
