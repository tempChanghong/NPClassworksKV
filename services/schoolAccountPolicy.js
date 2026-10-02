import {prisma} from "../utils/prisma.js";
import {authorizationError} from "./academicAuthorizationService.js";

export function isSchoolLocalAccount(account, school) {
    return account?.provider === "school-local" && typeof school?.code === "string"
        && typeof account.providerId === "string" && account.providerId.startsWith(`${school.code}:`);
}

// Federated accounts can belong to multiple schools; local credentials cannot.
export async function assertAccountSchoolScope(account, schoolId, client = prisma) {
    if (account.provider !== "school-local") return;
    const school = await client.school.findUnique({where: {id: schoolId}, select: {code: true}});
    if (!isSchoolLocalAccount(account, school)) {
        throw authorizationError("本地账户不属于该学校", "LOCAL_ACCOUNT_SCHOOL_MISMATCH", 403);
    }
}
