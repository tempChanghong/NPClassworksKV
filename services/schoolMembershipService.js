import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";

import {lockSchoolManagement, assertOwnerTargetChange} from "./schoolOwnerPolicy.js";

const SCHOOL_ROLES = new Set(["OWNER", "ADMIN", "MANAGER", "VIEWER"]);

async function resolveAccount({accountId, email}, client = prisma) {
    if (accountId) return client.account.findUnique({where: {id: accountId}});
    if (email) return client.account.findFirst({where: {email}});
    return null;
}

export async function listMySchools(accountId) {
    const memberships = await prisma.schoolMember.findMany({
        where: {accountId},
        orderBy: {school: {name: "asc"}},
        include: {
            school: {
                include: {
                    terms: {
                        orderBy: [{academicYear: "desc"}, {semester: "desc"}],
                    },
                },
            },
        },
    });
    return memberships.map(({school: {teacherSharedPasswordHash: _secret, ...school}, ...membership}) => ({...membership, school}));
}

export async function listSchoolMembers({managerAccountId, schoolId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    return prisma.schoolMember.findMany({
        where: {schoolId},
        orderBy: [{role: "asc"}, {createdAt: "asc"}],
        include: {
            account: {select: {id: true, name: true, email: true, localUsername: true, provider: true, avatarUrl: true}},
        },
    });
}

export async function upsertSchoolMember({managerAccountId, schoolId, accountId, email, role}) {
    if (!SCHOOL_ROLES.has(role)) throw authorizationError("无效的学校成员角色", "INVALID_SCHOOL_ROLE", 400, {role});
    return prisma.$transaction(async (tx) => {
        const manager = await lockSchoolManagement(tx, managerAccountId, schoolId);
        const account = await resolveAccount({accountId, email}, tx);
        if (!account) throw authorizationError("未找到需要添加的账户", "ACCOUNT_NOT_FOUND", 404);
        await assertOwnerTargetChange(tx, {manager, schoolId, accountId: account.id, nextRole: role});
        return tx.schoolMember.upsert({
            where: {schoolId_accountId: {schoolId, accountId: account.id}},
            update: {role},
            create: {schoolId, accountId: account.id, role},
            include: {account: {select: {id: true, name: true, email: true, localUsername: true, provider: true, avatarUrl: true}}},
        });
    });
}

export async function removeSchoolMember({managerAccountId, schoolId, accountId}) {
    return prisma.$transaction(async (tx) => {
        const manager = await lockSchoolManagement(tx, managerAccountId, schoolId);
        const target = await assertOwnerTargetChange(tx, {manager, schoolId, accountId, nextRole: null});
        if (!target) throw authorizationError("学校成员不存在", "SCHOOL_MEMBER_NOT_FOUND", 404);
        await tx.schoolMember.delete({where: {schoolId_accountId: {schoolId, accountId}}});
    });
}
