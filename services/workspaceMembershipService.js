import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";
import {getResponsibilityWorkspaceIds} from "./staffAuthorizationService.js";

const WORKSPACE_ROLES = new Set(["OWNER", "TEACHER", "ASSISTANT", "VIEWER"]);

const myWorkspaceInclude = {
    subject: {select: {id: true, code: true, name: true, category: true}},
    subjectRules: {
        include: {
            subject: {select: {id: true, code: true, name: true, category: true}},
        },
    },
    grade: {select: {id: true, code: true, name: true}},
    term: {
        include: {school: {select: {
            id: true,
            code: true,
            name: true,
            teacherAuthMode: true,
            allowOAuthTeacherLogin: true,
        }}},
    },
    sourceClasses: {
        include: {
            administrativeClass: {select: {id: true, code: true, name: true}},
        },
    },
};

async function getManagedWorkspace(accountId, workspaceId) {
    const workspace = await prisma.workspace.findUnique({
        where: {id: workspaceId},
        include: {term: {select: {schoolId: true}}},
    });
    if (!workspace) throw authorizationError("教学空间不存在", "WORKSPACE_NOT_FOUND", 404);
    await assertSchoolManager(accountId, workspace.term.schoolId);
    return workspace;
}

async function resolveAccount({accountId, email}) {
    if (accountId) return prisma.account.findUnique({where: {id: accountId}});
    if (email) return prisma.account.findFirst({where: {email: {equals: email.trim(), mode: "insensitive"}}});
    return null;
}

export async function upsertWorkspaceMember({managerAccountId, workspaceId, accountId, email, role}) {
    await getManagedWorkspace(managerAccountId, workspaceId);
    if (!WORKSPACE_ROLES.has(role)) {
        throw authorizationError("无效的教学空间角色", "INVALID_WORKSPACE_ROLE", 400, {role});
    }
    const account = await resolveAccount({accountId, email});
    if (!account) throw authorizationError("未找到需要添加的教师账户", "ACCOUNT_NOT_FOUND", 404);

    const membership = await prisma.workspaceMember.upsert({
        where: {workspaceId_accountId: {workspaceId, accountId: account.id}},
        update: {role},
        create: {workspaceId, accountId: account.id, role},
        include: {
            account: {select: {id: true, name: true, email: true, avatarUrl: true}},
        },
    });
    return membership;
}

export async function removeWorkspaceMember({managerAccountId, workspaceId, accountId}) {
    await getManagedWorkspace(managerAccountId, workspaceId);
    const existing = await prisma.workspaceMember.findUnique({
        where: {workspaceId_accountId: {workspaceId, accountId}},
    });
    if (!existing) throw authorizationError("教学空间成员不存在", "WORKSPACE_MEMBER_NOT_FOUND", 404);
    await prisma.workspaceMember.delete({
        where: {workspaceId_accountId: {workspaceId, accountId}},
    });
}

export async function listMyWorkspaces({accountId, termId}) {
    const [account, schoolManagerMemberships, memberships, responsibilityAccess] = await Promise.all([
        prisma.account.findUnique({where: {id: accountId}, select: {provider: true}}),
        prisma.schoolMember.findMany({
            where: {accountId, role: {in: ["OWNER", "ADMIN"]}},
            select: {schoolId: true},
        }),
        prisma.workspaceMember.findMany({
        where: {
            accountId,
            workspace: {
                isActive: true,
                ...(termId ? {termId} : {term: {status: "ACTIVE"}}),
            },
        },
        orderBy: {workspace: {name: "asc"}},
        include: {workspace: {include: myWorkspaceInclude}},
        }),
        getResponsibilityWorkspaceIds(accountId, {termId}),
    ]);

    const managedSchoolIds = new Set(schoolManagerMemberships.map((membership) => membership.schoolId));
    const managedWorkspaces = managedSchoolIds.size ? await prisma.workspace.findMany({
        where: {
            isActive: true,
            term: {
                schoolId: {in: [...managedSchoolIds]},
                ...(termId ? {id: termId} : {status: "ACTIVE"}),
            },
        },
        include: myWorkspaceInclude,
        orderBy: {name: "asc"},
    }) : [];
    const permittedMemberships = memberships.filter((membership) => {
        const school = membership.workspace.term.school;
        if (managedSchoolIds.has(school.id)) return true;
        if (account?.provider === "school-local") return school.teacherAuthMode !== "OAUTH_EMAIL";
        return school.teacherAuthMode === "OAUTH_EMAIL" || school.allowOAuthTeacherLogin;
    });

    const writableSet = new Set(responsibilityAccess.writableIds);
    const readableSet = new Set(responsibilityAccess.readableIds);
    const membershipResults = permittedMemberships.map((membership) => {
        const schoolManagerDerived = managedSchoolIds.has(membership.workspace.term.school.id);
        return {
            role: schoolManagerDerived
                ? "OWNER"
                : (writableSet.has(membership.workspace.id) && membership.role === "VIEWER"
                    ? "TEACHER"
                    : membership.role),
            joinedAt: membership.createdAt,
            ...(schoolManagerDerived ? {schoolManagerDerived: true} : {}),
            ...(readableSet.has(membership.workspace.id) ? {responsibilityDerived: true} : {}),
            workspace: membership.workspace,
        };
    });
    const existingIds = new Set(membershipResults.map((item) => item.workspace.id));
    const managedResults = managedWorkspaces
        .filter((workspace) => !existingIds.has(workspace.id))
        .map((workspace) => ({
            role: "OWNER",
            joinedAt: null,
            schoolManagerDerived: true,
            workspace,
        }));
    for (const item of managedResults) existingIds.add(item.workspace.id);
    const responsibilityIds = responsibilityAccess.readableIds.filter((id) => !existingIds.has(id));
    const responsibilityWorkspaces = responsibilityIds.length ? await prisma.workspace.findMany({
        where: {id: {in: responsibilityIds}},
        include: myWorkspaceInclude,
        orderBy: {name: "asc"},
    }) : [];
    return [
        ...membershipResults,
        ...managedResults,
        ...responsibilityWorkspaces.map((workspace) => ({
            role: writableSet.has(workspace.id) ? "TEACHER" : "VIEWER",
            joinedAt: null,
            responsibilityDerived: true,
            workspace,
        })),
    ].sort((left, right) => left.workspace.name.localeCompare(right.workspace.name, "zh-CN"));
}
