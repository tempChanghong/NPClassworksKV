import {prisma} from "../utils/prisma.js";

const SCHOOL_MANAGEMENT_ROLES = new Set(["OWNER", "ADMIN"]);

function authorizationError(message, code, statusCode = 403, details = null) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    error.details = details;
    return error;
}

export async function assertSchoolManager(accountId, schoolId, client = prisma) {
    const membership = await client.schoolMember.findUnique({
        where: {schoolId_accountId: {schoolId, accountId}},
    });
    if (!membership || !SCHOOL_MANAGEMENT_ROLES.has(membership.role)) {
        throw authorizationError("需要学校管理员权限", "SCHOOL_ADMIN_REQUIRED");
    }
    return membership;
}

export async function assertCanBootstrapSchool(accountId, client = prisma) {
    const schoolCount = await client.school.count();
    if (schoolCount > 0) {
        throw authorizationError(
            "系统已经完成学校初始化，请由现有学校管理员执行导入",
            "SCHOOL_ALREADY_BOOTSTRAPPED",
            409,
        );
    }
    if (!accountId) {
        throw authorizationError("需要登录账户完成初始化", "ACCOUNT_REQUIRED", 401);
    }
    const account = await client.account.findUnique({where: {id: accountId}});
    const isLocalBootstrapAdministrator = account?.provider === "school-local" &&
        account.providerData?.bootstrapAdministrator === true;
    if (!isLocalBootstrapAdministrator && process.env.ALLOW_OAUTH_BOOTSTRAP !== "true") {
        throw authorizationError(
            "请先使用服务器一次性初始化密钥创建首位管理员",
            "LOCAL_BOOTSTRAP_REQUIRED",
            403,
        );
    }
}

export {authorizationError};
