import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";

// All school role/provisioning mutations take the same row lock. This keeps
// concurrent demotion/removal from independently observing two remaining owners.
export async function lockSchoolManagement(tx, managerAccountId, schoolId) {
    await tx.$queryRaw`SELECT "id" FROM "School" WHERE "id" = ${schoolId} FOR UPDATE`;
    return assertSchoolManager(managerAccountId, schoolId, tx);
}

export async function assertOwnerTargetChange(tx, {manager, schoolId, accountId, nextRole}) {
    const target = accountId ? await tx.schoolMember.findUnique({
        where: {schoolId_accountId: {schoolId, accountId}},
    }) : null;
    if ((target?.role === "OWNER" || nextRole === "OWNER") && manager.role !== "OWNER") {
        throw authorizationError("只有学校所有者可以管理 OWNER", "SCHOOL_OWNER_REQUIRED");
    }
    if (target?.role === "OWNER" && nextRole !== undefined && nextRole !== "OWNER") {
        const count = await tx.schoolMember.count({where: {schoolId, role: "OWNER"}});
        if (count <= 1) throw authorizationError("不能移除或降级学校最后一个 OWNER", "LAST_SCHOOL_OWNER", 409);
    }
    return target;
}
