import bcrypt from "bcrypt";
import {prisma} from "../utils/prisma.js";
import {validateSharedTeacherPassword} from "../domain/localAccount.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";
import {updateVersionedRecord} from "./optimisticConcurrencyService.js";

const AUTH_MODES = new Set(["LOCAL_PIN", "SHARED_PASSWORD", "OAUTH_EMAIL"]);

export async function getManagedSchoolProfile({managerAccountId, schoolId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const school = await prisma.school.findUnique({
        where: {id: schoolId},
        select: {
            id: true,
            code: true,
            name: true,
            teacherAuthMode: true,
            allowOAuthTeacherLogin: true,
            teacherSharedPasswordHash: true,
            updatedAt: true,
        },
    });
    if (!school) throw authorizationError("学校不存在", "SCHOOL_NOT_FOUND", 404);
    return {
        id: school.id,
        code: school.code,
        name: school.name,
        teacherAuthMode: school.teacherAuthMode,
        allowOAuthTeacherLogin: school.allowOAuthTeacherLogin,
        hasSharedTeacherPassword: Boolean(school.teacherSharedPasswordHash),
        updatedAt: school.updatedAt,
    };
}

export async function updateManagedSchoolProfile({
    managerAccountId,
    schoolId,
    name,
    teacherAuthMode,
    allowOAuthTeacherLogin,
    sharedPassword,
    expectedUpdatedAt,
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const existing = await prisma.school.findUnique({where: {id: schoolId}});
    if (!existing) throw authorizationError("学校不存在", "SCHOOL_NOT_FOUND", 404);
    const nextName = name === undefined ? existing.name : String(name).trim();
    const nextMode = teacherAuthMode === undefined
        ? existing.teacherAuthMode
        : String(teacherAuthMode).trim().toUpperCase();
    if (!nextName || nextName.length > 191) {
        throw authorizationError("学校名称不能为空且不能超过191个字符", "SCHOOL_NAME_INVALID", 422);
    }
    if (!AUTH_MODES.has(nextMode)) {
        throw authorizationError("教师登录方式无效", "TEACHER_AUTH_MODE_INVALID", 422);
    }
    if (sharedPassword && !validateSharedTeacherPassword(sharedPassword)) {
        throw authorizationError("学校通用教师密码需为8至64个字符", "SHARED_TEACHER_PASSWORD_INVALID", 422);
    }
    if (nextMode === "SHARED_PASSWORD" && !sharedPassword && !existing.teacherSharedPasswordHash) {
        throw authorizationError("首次启用通用密码模式时必须设置通用教师密码", "SHARED_TEACHER_PASSWORD_REQUIRED", 422);
    }
    const passwordHash = sharedPassword ? await bcrypt.hash(sharedPassword, 12) : null;
    await updateVersionedRecord({
        client: prisma,
        model: "school",
        id: schoolId,
        expectedUpdatedAt,
        data: {
            name: nextName,
            teacherAuthMode: nextMode,
            ...(allowOAuthTeacherLogin === undefined ? {} : {allowOAuthTeacherLogin: Boolean(allowOAuthTeacherLogin)}),
            ...(passwordHash ? {teacherSharedPasswordHash: passwordHash} : {}),
        },
    });
    return getManagedSchoolProfile({managerAccountId, schoolId});
}
