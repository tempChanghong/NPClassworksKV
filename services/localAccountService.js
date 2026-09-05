import {lockSchoolManagement, assertOwnerTargetChange} from "./schoolOwnerPolicy.js";
import bcrypt from "bcrypt";
import crypto from "node:crypto";
import {prisma} from "../utils/prisma.js";
import {generateTokenPair} from "../utils/jwt.js";
import {
    localProviderId,
    normalizeLocalUsername,
    normalizeSchoolCode,
    validateLocalTeacherImport,
    validateLocalUsername,
    validateTeacherPin,
} from "../domain/localAccount.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";

const LOCAL_PROVIDER = "school-local";
const BCRYPT_ROUNDS = Math.min(14, Math.max(10, Number(process.env.LOCAL_AUTH_BCRYPT_ROUNDS) || 10));
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.5l4KJg7jL7vY4PZwXH0mD7tZKX8zXn2";

function safeSecretEquals(actual, expected) {
    if (!actual || !expected) return false;
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function loginError(message = "学校代码、教师账号或口令不正确", code = "LOCAL_LOGIN_FAILED", statusCode = 401) {
    return authorizationError(message, code, statusCode);
}

export async function getLocalAuthStatus() {
    const schoolCount = await prisma.school.count();
    const bootstrapAccountCount = schoolCount === 0
        ? await prisma.account.count({where: {provider: LOCAL_PROVIDER}})
        : 0;
    return {
        bootstrapRequired: schoolCount === 0,
        bootstrapAvailable: schoolCount === 0 && bootstrapAccountCount === 0 && Boolean(process.env.BOOTSTRAP_SETUP_KEY),
    };
}

export async function bootstrapLocalAdministrator({setupKey, schoolCode, username, name, pin}) {
    const expectedKey = process.env.BOOTSTRAP_SETUP_KEY;
    if (!safeSecretEquals(setupKey, expectedKey)) throw loginError("初始化密钥不正确", "INVALID_BOOTSTRAP_KEY");
    if (await prisma.school.count() > 0 || await prisma.account.count({where: {provider: LOCAL_PROVIDER}}) > 0) {
        throw authorizationError("实例已经创建过首位管理员", "INSTANCE_ALREADY_BOOTSTRAPPED", 409);
    }

    const normalizedSchoolCode = normalizeSchoolCode(schoolCode);
    const normalizedUsername = normalizeLocalUsername(username);
    const displayName = typeof name === "string" ? name.trim() : "";
    if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(normalizedSchoolCode)) {
        throw authorizationError("学校代码需为2至32位字母、数字、横线或下划线", "INVALID_SCHOOL_CODE", 400);
    }
    if (!validateLocalUsername(normalizedUsername)) {
        throw authorizationError("管理员短账号格式无效", "INVALID_LOCAL_USERNAME", 400);
    }
    if (!displayName || displayName.length > 64) {
        throw authorizationError("管理员姓名需为1至64个字符", "INVALID_ACCOUNT_NAME", 400);
    }
    if (!validateTeacherPin(pin)) {
        throw authorizationError("管理员 PIN 需为4至8位数字", "INVALID_TEACHER_PIN", 400);
    }

    const account = await prisma.account.create({
        data: {
            provider: LOCAL_PROVIDER,
            providerId: localProviderId(normalizedSchoolCode, normalizedUsername),
            name: displayName,
            localUsername: normalizedUsername,
            localPasswordHash: await bcrypt.hash(pin, BCRYPT_ROUNDS),
            providerData: {schoolCode: normalizedSchoolCode, bootstrapAdministrator: true},
        },
    });
    const tokens = await generateTokenPair(account);
    return {account: publicLocalAccount(account), ...tokens};
}

export async function loginLocalAccount({schoolCode, username, password}) {
    const normalizedSchoolCode = normalizeSchoolCode(schoolCode);
    const normalizedUsername = normalizeLocalUsername(username);
    const account = await prisma.account.findUnique({
        where: {provider_providerId: {provider: LOCAL_PROVIDER, providerId: localProviderId(normalizedSchoolCode, normalizedUsername)}},
    });

    if (account?.localDisabled) throw loginError("该教师账号已停用", "LOCAL_ACCOUNT_DISABLED", 403);
    const school = await prisma.school.findUnique({where: {code: normalizedSchoolCode}});
    const membership = account && school
        ? await prisma.schoolMember.findUnique({where: {schoolId_accountId: {schoolId: school.id, accountId: account.id}}})
        : null;
    const isManager = membership && new Set(["OWNER", "ADMIN"]).has(membership.role);

    let hash = account?.localPasswordHash || DUMMY_HASH;
    if (school && !isManager) {
        if (school.teacherAuthMode === "OAUTH_EMAIL") {
            await bcrypt.compare(String(password || ""), hash);
            throw loginError("该学校当前仅启用 OAuth 邮箱登录", "LOCAL_LOGIN_DISABLED", 403);
        }
        if (school.teacherAuthMode === "SHARED_PASSWORD") {
            hash = school.teacherSharedPasswordHash || DUMMY_HASH;
        }
    }

    const passwordMatches = await bcrypt.compare(String(password || ""), hash);
    if (!account || !passwordMatches) {
        throw loginError();
    }

    const updated = await prisma.account.update({
        where: {id: account.id},
        data: {localLoginFailures: 0, localLockedUntil: null, lastLoginAt: new Date()},
    });
    const tokens = await generateTokenPair(updated);
    return {account: publicLocalAccount(updated), ...tokens};
}

export async function importLocalTeachers({managerAccountId, schoolId, termId, document, dryRun = false, requireWorkspaces = true}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const school = await prisma.school.findUnique({where: {id: schoolId}});
    if (!school) throw authorizationError("学校不存在", "SCHOOL_NOT_FOUND", 404);
    const validation = validateLocalTeacherImport(document, school.teacherAuthMode, {requireWorkspaces});
    if (!validation.valid) return {...validation, imported: false, dryRun};

    const term = termId
        ? await prisma.academicTerm.findFirst({where: {id: termId, schoolId}})
        : await prisma.academicTerm.findFirst({where: {schoolId, status: "ACTIVE"}});
    if (!term) throw authorizationError("未找到需要分配教师的学期", "TERM_NOT_FOUND", 404);

    const codes = [...new Set(validation.normalized.assignments.flatMap((item) => item.workspaceCodes))];
    const workspaces = await prisma.workspace.findMany({
        where: {termId: term.id, code: {in: codes}, isActive: true},
        select: {id: true, code: true},
    });
    const workspaceByCode = new Map(workspaces.map((workspace) => [workspace.code, workspace]));
    const unknownCodes = codes.filter((code) => !workspaceByCode.has(code));
    if (unknownCodes.length > 0) {
        return {
            ...validation,
            valid: false,
            imported: false,
            dryRun,
            errors: unknownCodes.map((code) => ({
                path: "assignments.workspaceCodes",
                code: "UNKNOWN_WORKSPACE",
                message: `当前学期不存在教学空间：${code}`,
            })),
        };
    }

    const preview = {
        ...validation,
        normalized: undefined,
        imported: false,
        dryRun: true,
        term: {id: term.id, name: term.name},
    };
    if (dryRun) return preview;

    const result = await prisma.$transaction(async (tx) => {
        const manager = await lockSchoolManagement(tx, managerAccountId, schoolId);
        let createdAccounts = 0;
        let memberships = 0;
        for (const assignment of validation.normalized.assignments) {
            const providerId = localProviderId(school.code, assignment.username);
            const existing = await tx.account.findUnique({
                where: {provider_providerId: {provider: LOCAL_PROVIDER, providerId}},
            });
            await assertOwnerTargetChange(tx, {manager, schoolId, accountId: existing?.id});
            const passwordHash = assignment.pin
                ? await bcrypt.hash(assignment.pin, BCRYPT_ROUNDS)
                : existing?.localPasswordHash || null;
            const account = await tx.account.upsert({
                where: {provider_providerId: {provider: LOCAL_PROVIDER, providerId}},
                update: {
                    name: assignment.name,
                    localUsername: assignment.username,
                    ...(passwordHash ? {localPasswordHash: passwordHash} : {}),
                    localDisabled: false,
                    localLoginFailures: 0,
                    localLockedUntil: null,
                },
                create: {
                    provider: LOCAL_PROVIDER,
                    providerId,
                    name: assignment.name,
                    localUsername: assignment.username,
                    localPasswordHash: passwordHash,
                    providerData: {schoolCode: school.code},
                },
            });
            if (!existing) createdAccounts += 1;
            for (const code of assignment.workspaceCodes) {
                await tx.workspaceMember.upsert({
                    where: {workspaceId_accountId: {workspaceId: workspaceByCode.get(code).id, accountId: account.id}},
                    update: {role: assignment.role},
                    create: {workspaceId: workspaceByCode.get(code).id, accountId: account.id, role: assignment.role},
                });
                memberships += 1;
            }
        }
        return {createdAccounts, memberships};
    }, {timeout: 30000});

    return {...preview, imported: true, dryRun: false, result};
}

function validateAccountName(name) {
    const displayName = typeof name === "string" ? name.trim() : "";
    if (!displayName || displayName.length > 64) {
        throw authorizationError("姓名需为1至64个字符", "INVALID_ACCOUNT_NAME", 400);
    }
    return displayName;
}

async function loadManagedLocalAccount({managerAccountId, schoolId, accountId}) {
    const managerMembership = await assertSchoolManager(managerAccountId, schoolId);
    const [school, account, targetMembership] = await Promise.all([
        prisma.school.findUnique({where: {id: schoolId}}),
        prisma.account.findUnique({where: {id: accountId}}),
        prisma.schoolMember.findUnique({where: {schoolId_accountId: {schoolId, accountId}}}),
    ]);
    if (!school) throw authorizationError("学校不存在", "SCHOOL_NOT_FOUND", 404);
    if (
        !account ||
        account.provider !== LOCAL_PROVIDER ||
        !account.providerId.startsWith(`${school.code}:`)
    ) {
        throw authorizationError("本地账号不存在或不属于该学校", "LOCAL_ACCOUNT_NOT_FOUND", 404);
    }
    if (targetMembership?.role === "OWNER" && managerMembership.role !== "OWNER") {
        throw authorizationError("只有学校所有者可以管理 OWNER 账号", "SCHOOL_OWNER_REQUIRED", 403);
    }
    return {managerMembership, school, account, targetMembership};
}

export async function listSchoolLocalAccounts({managerAccountId, schoolId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const school = await prisma.school.findUnique({where: {id: schoolId}});
    if (!school) throw authorizationError("学校不存在", "SCHOOL_NOT_FOUND", 404);
    const accounts = await prisma.account.findMany({
        where: {
            provider: LOCAL_PROVIDER,
            providerId: {startsWith: `${school.code}:`},
            OR: [
                {schoolMemberships: {some: {schoolId}}},
                {workspaceMemberships: {some: {workspace: {term: {schoolId}}}}},
            ],
        },
        orderBy: [{localDisabled: "asc"}, {name: "asc"}, {localUsername: "asc"}],
        include: {
            schoolMemberships: {where: {schoolId}, select: {role: true}},
            workspaceMemberships: {
                where: {workspace: {term: {schoolId}}},
                include: {
                    workspace: {
                        select: {
                            id: true,
                            code: true,
                            name: true,
                            term: {select: {id: true, name: true, status: true}},
                        },
                    },
                },
            },
        },
    });
    return accounts.map((account) => ({
        id: account.id,
        username: account.localUsername,
        name: account.name,
        schoolRole: account.schoolMemberships[0]?.role || null,
        disabled: account.localDisabled,
        // 兼容旧客户端保留字段，但登录保护已改为设备与账号组合限流。
        lockedUntil: null,
        lastLoginAt: account.lastLoginAt,
        createdAt: account.createdAt,
        workspaces: account.workspaceMemberships.map((membership) => ({
            role: membership.role,
            ...membership.workspace,
        })),
    }));
}

export async function createLocalAdministrator({managerAccountId, schoolId, username, name, pin, role = "ADMIN"}) {
    const managerMembership = await assertSchoolManager(managerAccountId, schoolId);
    const school = await prisma.school.findUnique({where: {id: schoolId}});
    if (!school) throw authorizationError("学校不存在", "SCHOOL_NOT_FOUND", 404);
    const normalizedUsername = normalizeLocalUsername(username);
    const displayName = validateAccountName(name);
    const normalizedRole = String(role || "ADMIN").toUpperCase();
    if (!validateLocalUsername(normalizedUsername)) {
        throw authorizationError("管理员短账号格式无效", "INVALID_LOCAL_USERNAME", 400);
    }
    if (!validateTeacherPin(pin)) {
        throw authorizationError("管理员 PIN 需为4至8位数字", "INVALID_TEACHER_PIN", 400);
    }
    if (!new Set(["ADMIN", "OWNER"]).has(normalizedRole)) {
        throw authorizationError("本地管理员角色只能是 ADMIN 或 OWNER", "INVALID_SCHOOL_ROLE", 400);
    }
    if (normalizedRole === "OWNER" && managerMembership.role !== "OWNER") {
        throw authorizationError("只有学校所有者可以创建 OWNER", "SCHOOL_OWNER_REQUIRED", 403);
    }

    const providerId = localProviderId(school.code, normalizedUsername);
    const passwordHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
    return prisma.$transaction(async (tx) => {
        const manager = await lockSchoolManagement(tx, managerAccountId, schoolId);
        const existing = await tx.account.findUnique({where: {provider_providerId: {provider: LOCAL_PROVIDER, providerId}}});
        await assertOwnerTargetChange(tx, {manager, schoolId, accountId: existing?.id, nextRole: normalizedRole});
        const account = await tx.account.upsert({
            where: {provider_providerId: {provider: LOCAL_PROVIDER, providerId}},
            update: {
                name: displayName,
                localUsername: normalizedUsername,
                localPasswordHash: passwordHash,
                localDisabled: false,
                localLoginFailures: 0,
                localLockedUntil: null,
            },
            create: {
                provider: LOCAL_PROVIDER,
                providerId,
                name: displayName,
                localUsername: normalizedUsername,
                localPasswordHash: passwordHash,
                providerData: {schoolCode: school.code},
            },
        });
        const membership = await tx.schoolMember.upsert({
            where: {schoolId_accountId: {schoolId, accountId: account.id}},
            update: {role: normalizedRole},
            create: {schoolId, accountId: account.id, role: normalizedRole},
        });
        return {account: publicLocalAccount(account), role: membership.role};
    });
}

export async function updateManagedLocalAccount({managerAccountId, schoolId, accountId, name, pin, disabled}) {
    const context = await loadManagedLocalAccount({managerAccountId, schoolId, accountId});
    if (disabled === true && accountId === managerAccountId) {
        throw authorizationError("不能停用当前登录的管理员账号", "CANNOT_DISABLE_SELF", 409);
    }
    if (disabled === true && context.targetMembership?.role === "OWNER") {
        const ownerCount = await prisma.schoolMember.count({where: {schoolId, role: "OWNER"}});
        if (ownerCount <= 1) {
            throw authorizationError("不能停用学校最后一个 OWNER", "LAST_SCHOOL_OWNER", 409);
        }
    }

    const accountData = {
        ...(name !== undefined ? {name: validateAccountName(name)} : {}),
        ...(disabled !== undefined ? {localDisabled: disabled === true} : {}),
        localLoginFailures: 0,
        localLockedUntil: null,
    };
    if (pin !== undefined) {
        if (!validateTeacherPin(pin)) {
            throw authorizationError("新 PIN 需为4至8位数字", "INVALID_TEACHER_PIN", 400);
        }
        accountData.localPasswordHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
    }
    const shouldRevokeSessions = pin !== undefined || disabled === true;
    return prisma.$transaction(async (tx) => {
        const account = await tx.account.update({
            where: {id: accountId},
            data: {
                ...accountData,
                ...(shouldRevokeSessions ? {tokenVersion: {increment: 1}} : {}),
            },
        });
        if (shouldRevokeSessions) {
            await tx.accountSession.updateMany({
                where: {accountId, revokedAt: null},
                data: {revokedAt: new Date()},
            });
        }
        return publicLocalAccount(account);
    });
}

export async function deactivateLocalAccount({managerAccountId, schoolId, accountId}) {
    const context = await loadManagedLocalAccount({managerAccountId, schoolId, accountId});
    if (accountId === managerAccountId) {
        throw authorizationError("不能注销当前登录的管理员账号", "CANNOT_DISABLE_SELF", 409);
    }
    if (context.targetMembership?.role === "OWNER") {
        const ownerCount = await prisma.schoolMember.count({where: {schoolId, role: "OWNER"}});
        if (ownerCount <= 1) {
            throw authorizationError("不能注销学校最后一个 OWNER", "LAST_SCHOOL_OWNER", 409);
        }
    }
    return prisma.$transaction(async (tx) => {
        const removedWorkspaces = await tx.workspaceMember.deleteMany({
            where: {accountId, workspace: {term: {schoolId}}},
        });
        const removedSchoolMemberships = await tx.schoolMember.deleteMany({where: {schoolId, accountId}});
        await tx.accountSession.updateMany({
            where: {accountId, revokedAt: null},
            data: {revokedAt: new Date()},
        });
        await tx.account.update({
            where: {id: accountId},
            data: {
                localDisabled: true,
                localLoginFailures: 0,
                localLockedUntil: null,
                tokenVersion: {increment: 1},
            },
        });
        return {
            removedWorkspaceMemberships: removedWorkspaces.count,
            removedSchoolMemberships: removedSchoolMemberships.count,
        };
    });
}

export async function changeOwnLocalPin({accountId, currentPin, newPin}) {
    const account = await prisma.account.findUnique({where: {id: accountId}});
    if (account?.provider !== LOCAL_PROVIDER || !account.localPasswordHash) {
        throw authorizationError("当前账号不支持个人 PIN", "LOCAL_PIN_NOT_AVAILABLE", 400);
    }
    if (!validateTeacherPin(newPin)) {
        throw authorizationError("新 PIN 需为4至8位数字", "INVALID_TEACHER_PIN", 400);
    }
    if (!await bcrypt.compare(String(currentPin || ""), account.localPasswordHash)) {
        throw loginError("当前 PIN 不正确", "CURRENT_PIN_INCORRECT");
    }
    const passwordHash = await bcrypt.hash(newPin, BCRYPT_ROUNDS);
    await prisma.$transaction([
        prisma.account.update({
            where: {id: accountId},
            data: {
                localPasswordHash: passwordHash,
                localLoginFailures: 0,
                localLockedUntil: null,
                tokenVersion: {increment: 1},
            },
        }),
        prisma.accountSession.updateMany({
            where: {accountId, revokedAt: null},
            data: {revokedAt: new Date()},
        }),
    ]);
}

export async function recoverLocalOwner({setupKey, schoolCode, username, newPin}) {
    if (!safeSecretEquals(setupKey, process.env.BOOTSTRAP_SETUP_KEY)) {
        throw loginError("服务器恢复密钥不正确", "INVALID_RECOVERY_KEY");
    }
    if (!validateTeacherPin(newPin)) {
        throw authorizationError("新 PIN 需为4至8位数字", "INVALID_TEACHER_PIN", 400);
    }
    const normalizedSchoolCode = normalizeSchoolCode(schoolCode);
    const account = await prisma.account.findUnique({
        where: {
            provider_providerId: {
                provider: LOCAL_PROVIDER,
                providerId: localProviderId(normalizedSchoolCode, username),
            },
        },
    });
    const school = await prisma.school.findUnique({where: {code: normalizedSchoolCode}});
    const ownerMembership = account && school
        ? await prisma.schoolMember.findUnique({
            where: {schoolId_accountId: {schoolId: school.id, accountId: account.id}},
        })
        : null;
    if (!account || ownerMembership?.role !== "OWNER") {
        throw loginError("未找到对应的学校 OWNER", "LOCAL_OWNER_NOT_FOUND", 404);
    }
    const passwordHash = await bcrypt.hash(newPin, BCRYPT_ROUNDS);
    await prisma.$transaction([
        prisma.account.update({
            where: {id: account.id},
            data: {
                localPasswordHash: passwordHash,
                localDisabled: false,
                localLoginFailures: 0,
                localLockedUntil: null,
                tokenVersion: {increment: 1},
            },
        }),
        prisma.accountSession.updateMany({
            where: {accountId: account.id, revokedAt: null},
            data: {revokedAt: new Date()},
        }),
    ]);
}

export function publicLocalAccount(account) {
    return {
        id: account.id,
        provider: account.provider,
        username: account.localUsername,
        name: account.name,
        avatarUrl: account.avatarUrl,
    };
}

export {LOCAL_PROVIDER};
