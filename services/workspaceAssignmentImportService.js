import {prisma} from "../utils/prisma.js";
import {
    normalizeAssignmentEmail,
    validateWorkspaceAssignmentImport,
} from "../domain/workspaceAssignmentImport.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";

async function resolveManagedTerm({managerAccountId, schoolId, termId}) {
    if (!schoolId) throw authorizationError("需要提供学校", "SCHOOL_REQUIRED", 400);
    await assertSchoolManager(managerAccountId, schoolId);
    const term = termId
        ? await prisma.academicTerm.findFirst({where: {id: termId, schoolId}})
        : await prisma.academicTerm.findFirst({
            where: {schoolId, status: "ACTIVE"},
            orderBy: [{academicYear: "desc"}, {semester: "desc"}],
        });
    if (!term) throw authorizationError("未找到需要分配教师的学期", "TERM_NOT_FOUND", 404);
    return term;
}

async function findAccountsByNormalizedEmail(emails) {
    if (emails.length === 0) return new Map();
    const accounts = await prisma.account.findMany({
        where: {email: {in: emails, mode: "insensitive"}},
        select: {id: true, email: true, name: true, avatarUrl: true},
    });
    const result = new Map();
    for (const account of accounts) {
        const email = normalizeAssignmentEmail(account.email);
        if (!result.has(email)) result.set(email, []);
        result.get(email).push(account);
    }
    return result;
}

export async function importWorkspaceAssignments({
    managerAccountId,
    schoolId,
    termId,
    document,
    dryRun = false,
}) {
    const validation = validateWorkspaceAssignmentImport(document);
    if (!validation.valid) return {...validation, imported: false, dryRun};

    const term = await resolveManagedTerm({managerAccountId, schoolId, termId});
    const codes = [...new Set(validation.normalized.assignments.flatMap((item) => item.workspaceCodes))];
    const workspaces = await prisma.workspace.findMany({
        where: {termId: term.id, code: {in: codes}, isActive: true},
        select: {id: true, code: true, name: true, type: true},
    });
    const workspaceByCode = new Map(workspaces.map((workspace) => [workspace.code, workspace]));
    const unknownCodes = codes.filter((code) => !workspaceByCode.has(code));
    if (unknownCodes.length > 0) {
        return {
            ...validation,
            valid: false,
            imported: false,
            dryRun,
            errors: [
                ...validation.errors,
                ...unknownCodes.map((code) => ({
                    path: "assignments.workspaceCodes",
                    code: "UNKNOWN_WORKSPACE",
                    message: `当前学期不存在教学空间：${code}`,
                })),
            ],
        };
    }

    const emails = [...new Set(validation.normalized.assignments.map((item) => item.email))];
    const accountsByEmail = await findAccountsByNormalizedEmail(emails);
    const ambiguousEmails = [...accountsByEmail]
        .filter(([, accounts]) => accounts.length > 1)
        .map(([email]) => email);
    if (ambiguousEmails.length > 0) {
        return {
            ...validation,
            valid: false,
            imported: false,
            dryRun,
            errors: ambiguousEmails.map((email) => ({
                path: "assignments.email",
                code: "AMBIGUOUS_ACCOUNT_EMAIL",
                message: `${email} 对应多个登录账户，请先统一教师登录方式`,
            })),
        };
    }

    const resolvedTeachers = emails.filter((email) => accountsByEmail.get(email)?.length === 1).length;
    const pendingTeachers = emails.length - resolvedTeachers;
    const preview = {
        ...validation,
        normalized: undefined,
        imported: false,
        dryRun: true,
        term: {id: term.id, name: term.name},
        summary: {...validation.summary, resolvedTeachers, pendingTeachers},
    };
    if (dryRun) return preview;

    const counters = await prisma.$transaction(async (tx) => {
        let memberships = 0;
        let invitations = 0;
        for (const assignment of validation.normalized.assignments) {
            const account = accountsByEmail.get(assignment.email)?.[0] || null;
            for (const code of assignment.workspaceCodes) {
                const workspaceId = workspaceByCode.get(code).id;
                if (account) {
                    await tx.workspaceMember.upsert({
                        where: {workspaceId_accountId: {workspaceId, accountId: account.id}},
                        update: {role: assignment.role},
                        create: {workspaceId, accountId: account.id, role: assignment.role},
                    });
                    await tx.workspaceMemberInvite.updateMany({
                        where: {workspaceId, normalizedEmail: assignment.email, claimedAt: null},
                        data: {claimedAt: new Date(), claimedByAccountId: account.id},
                    });
                    memberships += 1;
                } else {
                    await tx.workspaceMemberInvite.upsert({
                        where: {workspaceId_normalizedEmail: {workspaceId, normalizedEmail: assignment.email}},
                        update: {
                            email: assignment.email,
                            role: assignment.role,
                            invitedByAccountId: managerAccountId,
                            claimedAt: null,
                            claimedByAccountId: null,
                        },
                        create: {
                            workspaceId,
                            email: assignment.email,
                            normalizedEmail: assignment.email,
                            role: assignment.role,
                            invitedByAccountId: managerAccountId,
                        },
                    });
                    invitations += 1;
                }
            }
        }
        return {memberships, invitations};
    }, {timeout: 30000});

    return {
        ...preview,
        imported: true,
        dryRun: false,
        result: counters,
    };
}

export async function claimWorkspaceInvitations({accountId, email}) {
    const normalizedEmail = normalizeAssignmentEmail(email);
    if (!normalizedEmail) return {claimed: 0};
    const invitations = await prisma.workspaceMemberInvite.findMany({
        where: {normalizedEmail, claimedAt: null},
    });
    if (invitations.length === 0) return {claimed: 0};

    await prisma.$transaction(async (tx) => {
        for (const invitation of invitations) {
            await tx.workspaceMember.upsert({
                where: {
                    workspaceId_accountId: {workspaceId: invitation.workspaceId, accountId},
                },
                update: {role: invitation.role},
                create: {workspaceId: invitation.workspaceId, accountId, role: invitation.role},
            });
            await tx.workspaceMemberInvite.update({
                where: {id: invitation.id},
                data: {claimedAt: new Date(), claimedByAccountId: accountId},
            });
        }
    });
    return {claimed: invitations.length};
}

export async function listWorkspaceAssignments({managerAccountId, schoolId, termId}) {
    const term = await resolveManagedTerm({managerAccountId, schoolId, termId});
    const workspaces = await prisma.workspace.findMany({
        where: {termId: term.id, isActive: true},
        orderBy: [{type: "asc"}, {code: "asc"}],
        include: {
            subject: {select: {id: true, code: true, name: true}},
            members: {
                orderBy: {createdAt: "asc"},
                include: {account: {select: {id: true, email: true, localUsername: true, provider: true, name: true, avatarUrl: true}}},
            },
            pendingInvitations: {
                where: {claimedAt: null},
                orderBy: {createdAt: "asc"},
                select: {id: true, email: true, role: true, createdAt: true},
            },
        },
    });
    return {term: {id: term.id, name: term.name, status: term.status}, workspaces};
}

export async function removeWorkspaceInvitation({managerAccountId, workspaceId, invitationId}) {
    const invitation = await prisma.workspaceMemberInvite.findFirst({
        where: {id: invitationId, workspaceId, claimedAt: null},
        include: {workspace: {include: {term: {select: {schoolId: true}}}}},
    });
    if (!invitation) {
        throw authorizationError("待认领教师分配不存在", "WORKSPACE_INVITATION_NOT_FOUND", 404);
    }
    await assertSchoolManager(managerAccountId, invitation.workspace.term.schoolId);
    await prisma.workspaceMemberInvite.delete({where: {id: invitation.id}});
}
