import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";

const SCHOOL_ROLES = new Set(["OWNER", "ADMIN", "MANAGER", "VIEWER"]);

async function resolveAccount({accountId, email}) {
    if (accountId) return prisma.account.findUnique({where: {id: accountId}});
    if (email) return prisma.account.findFirst({where: {email}});
    return null;
}

export async function listMySchools(accountId) {
    return prisma.schoolMember.findMany({
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
    const managerMembership = await assertSchoolManager(managerAccountId, schoolId);
    if (!SCHOOL_ROLES.has(role)) {
        throw authorizationError("无效的学校成员角色", "INVALID_SCHOOL_ROLE", 400, {role});
    }
    if (role === "OWNER" && managerMembership.role !== "OWNER") {
        throw authorizationError("只有学校所有者可以授予 OWNER 角色", "SCHOOL_OWNER_REQUIRED");
    }

    const account = await resolveAccount({accountId, email});
    if (!account) throw authorizationError("未找到需要添加的账户", "ACCOUNT_NOT_FOUND", 404);

    return prisma.schoolMember.upsert({
        where: {schoolId_accountId: {schoolId, accountId: account.id}},
        update: {role},
        create: {schoolId, accountId: account.id, role},
        include: {
            account: {select: {id: true, name: true, email: true, localUsername: true, provider: true, avatarUrl: true}},
        },
    });
}

export async function removeSchoolMember({managerAccountId, schoolId, accountId}) {
    const managerMembership = await assertSchoolManager(managerAccountId, schoolId);
    const target = await prisma.schoolMember.findUnique({
        where: {schoolId_accountId: {schoolId, accountId}},
    });
    if (!target) throw authorizationError("学校成员不存在", "SCHOOL_MEMBER_NOT_FOUND", 404);
    if (target.role === "OWNER") {
        if (managerMembership.role !== "OWNER") {
            throw authorizationError("只有学校所有者可以移除 OWNER", "SCHOOL_OWNER_REQUIRED");
        }
        const ownerCount = await prisma.schoolMember.count({where: {schoolId, role: "OWNER"}});
        if (ownerCount <= 1) {
            throw authorizationError("不能移除学校最后一个 OWNER", "LAST_SCHOOL_OWNER", 409);
        }
    }
    await prisma.schoolMember.delete({where: {schoolId_accountId: {schoolId, accountId}}});
}
