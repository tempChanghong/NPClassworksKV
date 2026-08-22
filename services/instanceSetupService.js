import bcrypt from "bcrypt";
import {prisma} from "../utils/prisma.js";
import {generateTokenPair} from "../utils/jwt.js";
import {
    localProviderId,
    normalizeLocalUsername,
    normalizeSchoolCode,
    validateLocalUsername,
    validateSharedTeacherPassword,
    validateTeacherPin,
} from "../domain/localAccount.js";
import {authorizationError} from "./academicAuthorizationService.js";
import {importLocalTeachers, publicLocalAccount} from "./localAccountService.js";
import {importOrganization} from "./organizationAdminService.js";
import {createClassroomScreenAccount} from "./classroomScreenService.js";
import {importStaffConfiguration} from "./staffConfigurationImportService.js";

const SETUP_ID = "default";
const SETUP_VERSION = 2;
const AUTH_MODES = new Set(["LOCAL_PIN", "SHARED_PASSWORD", "OAUTH_EMAIL"]);
const BCRYPT_ROUNDS = Math.min(14, Math.max(10, Number(process.env.LOCAL_AUTH_BCRYPT_ROUNDS) || 10));
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.5l4KJg7jL7vY4PZwXH0mD7tZKX8zXn2";
const DEFAULT_SUBJECTS = [
    {code: "CHINESE", name: "语文", category: "CORE", sortOrder: 10},
    {code: "MATH", name: "数学", category: "CORE", sortOrder: 20},
    {code: "ENGLISH", name: "英语", category: "CORE", sortOrder: 30},
    {code: "PHYSICS", name: "物理", category: "ELECTIVE", sortOrder: 40},
    {code: "CHEMISTRY", name: "化学", category: "ELECTIVE", sortOrder: 50},
    {code: "BIOLOGY", name: "生物", category: "ELECTIVE", sortOrder: 60},
    {code: "HISTORY", name: "历史", category: "ELECTIVE", sortOrder: 70},
    {code: "GEOGRAPHY", name: "地理", category: "ELECTIVE", sortOrder: 80},
    {code: "POLITICS", name: "政治", category: "ELECTIVE", sortOrder: 90},
];

function setupError(message, code, statusCode = 400, details = null) {
    return authorizationError(message, code, statusCode, details);
}

function strongSecret(value) {
    return typeof value === "string" && value.length >= 32 && !value.includes("change-this");
}

function runtimeChecks() {
    const production = process.env.NODE_ENV === "production";
    const publicUrl = process.env.BASE_URL || "";
    const frontendUrl = process.env.FRONTEND_URL || "";
    return [
        {
            code: "SETUP_KEY",
            ok: strongSecret(process.env.BOOTSTRAP_SETUP_KEY),
            severity: "ERROR",
            message: "一次性初始化密钥已配置",
        },
        {
            code: "JWT_SECRET",
            ok: process.env.JWT_ALG === "RS256" || strongSecret(process.env.JWT_SECRET),
            severity: "ERROR",
            message: "访问令牌签名密钥已配置",
        },
        {
            code: "REFRESH_SECRET",
            ok: process.env.JWT_ALG === "RS256" || strongSecret(process.env.REFRESH_TOKEN_SECRET),
            severity: "ERROR",
            message: "刷新令牌签名密钥已配置",
        },
        {
            code: "PUBLIC_HTTPS",
            ok: !production || publicUrl.startsWith("https://"),
            severity: "WARNING",
            message: production ? "后端公网地址使用 HTTPS" : "开发环境允许 HTTP",
        },
        {
            code: "FRONTEND_HTTPS",
            ok: !production || frontendUrl.startsWith("https://"),
            severity: "WARNING",
            message: production ? "前端公网地址使用 HTTPS" : "开发环境允许 HTTP",
        },
    ];
}

async function loadSetupSnapshot(client = prisma) {
    const [setup, schoolCount, localAccountCount, managerAccountCount, ownerCount, activeTermCount, gradeCount, subjectCount,
        workspaceCount, teacherMembershipCount, screenCount] =
        await Promise.all([
            client.instanceSetup.findUnique({where: {id: SETUP_ID}}),
            client.school.count(),
            client.account.count({where: {provider: "school-local"}}),
            client.schoolMember.count({where: {role: {in: ["OWNER", "ADMIN"]}}}),
            client.schoolMember.count({where: {role: "OWNER"}}),
            client.academicTerm.count({where: {status: "ACTIVE"}}),
            client.grade.count(),
            client.subject.count(),
            client.workspace.count({where: {isActive: true}}),
            client.workspaceMember.count({where: {role: {in: ["OWNER", "TEACHER", "ASSISTANT"]}}}),
            client.classroomScreenBinding.count(),
        ]);
    const legacyCompleted = !setup && schoolCount > 0;
    const completed = Boolean(setup?.completedAt) || legacyCompleted;
    const state = completed ? "COMPLETED" : schoolCount || localAccountCount ? "CONFIGURING" : "NEW";
    return {
        setup,
        state,
        completed,
        legacyCompleted,
        counts: {schools: schoolCount, localAccounts: localAccountCount,
            teacherAccounts: Math.max(0, localAccountCount - managerAccountCount), owners: ownerCount,
            activeTerms: activeTermCount, grades: gradeCount, subjects: subjectCount,
            workspaces: workspaceCount, teacherMemberships: teacherMembershipCount, screens: screenCount},
    };
}

export async function getInstanceSetupStatus() {
    const snapshot = await loadSetupSnapshot();
    const checks = runtimeChecks();
    const steps = [
        {id: "runtime", title: "服务与密钥", complete: checks.every((item) => item.ok || item.severity !== "ERROR")},
        {id: "core", title: "管理员、学校与学期", complete: snapshot.counts.owners > 0 && snapshot.counts.activeTerms > 0},
        {id: "organization", title: "组织与班级（可稍后处理）", complete: snapshot.counts.grades > 0 && snapshot.counts.workspaces > 0, optional: true},
        {id: "teachers", title: "首批教师（可稍后处理）", complete: snapshot.counts.teacherAccounts > 0, optional: true},
        {id: "screens", title: "班级大屏（可稍后处理）", complete: snapshot.counts.screens > 0, optional: true},
        {id: "complete", title: "完成初始化", complete: snapshot.completed},
    ];
    const nextStep = steps.find((item) => !item.complete && !item.optional)?.id ||
        steps.find((item) => !item.complete)?.id || "complete";
    return {
        setupVersion: snapshot.setup?.setupVersion || SETUP_VERSION,
        state: snapshot.state,
        completedAt: snapshot.setup?.completedAt || null,
        legacyCompleted: snapshot.legacyCompleted,
        canStart: !snapshot.completed && checks.filter((item) => item.severity === "ERROR").every((item) => item.ok),
        checks,
        counts: snapshot.counts,
        steps,
        nextStep,
    };
}

async function requireSetupContext() {
    const snapshot = await loadSetupSnapshot();
    if (snapshot.completed) throw setupError("实例已经完成初始化", "SETUP_ALREADY_COMPLETED", 409);
    const membership = await prisma.schoolMember.findFirst({
        where: {role: "OWNER"},
        include: {
            account: {select: {id: true, name: true}},
            school: {
                include: {
                    subjects: {orderBy: [{sortOrder: "asc"}, {name: "asc"}]},
                    terms: {
                        where: {status: "ACTIVE"},
                        take: 1,
                        include: {
                            grades: {orderBy: [{sortOrder: "asc"}, {name: "asc"}]},
                            workspaces: {
                                where: {isActive: true},
                                orderBy: [{type: "asc"}, {name: "asc"}],
                                select: {id: true, code: true, name: true, type: true, gradeId: true, subjectId: true},
                            },
                        },
                    },
                },
            },
        },
    });
    const term = membership?.school?.terms?.[0];
    if (!membership || !term) throw setupError("请先完成管理员、学校与学期初始化", "SETUP_CORE_INCOMPLETE", 409);
    return {membership, school: membership.school, term};
}

export async function getInstanceSetupContext() {
    const {membership, school, term} = await requireSetupContext();
    return {
        owner: membership.account,
        school: {
            id: school.id,
            code: school.code,
            name: school.name,
            teacherAuthMode: school.teacherAuthMode,
            allowOAuthTeacherLogin: school.allowOAuthTeacherLogin,
        },
        term: {
            id: term.id,
            name: term.name,
            academicYear: term.academicYear,
            semester: term.semester,
            startsAt: term.startsAt,
            endsAt: term.endsAt,
            status: term.status,
        },
        subjects: school.subjects,
        grades: term.grades,
        workspaces: term.workspaces,
    };
}

export async function importInstanceSetupOrganization(document, dryRun = false) {
    const {membership} = await requireSetupContext();
    return importOrganization({accountId: membership.accountId, document, dryRun});
}

export async function importInstanceSetupTeachers(document, dryRun = false) {
    const {membership, school, term} = await requireSetupContext();
    return importLocalTeachers({
        managerAccountId: membership.accountId,
        schoolId: school.id,
        termId: term.id,
        document,
        dryRun,
        requireWorkspaces: false,
    });
}

export async function importInstanceSetupStaffConfiguration(document, dryRun = false) {
    const {membership, school, term} = await requireSetupContext();
    return importStaffConfiguration({
        managerAccountId: membership.accountId,
        schoolId: school.id,
        termId: term.id,
        document,
        dryRun,
    });
}

export async function createInstanceSetupScreen(input) {
    const {membership, school} = await requireSetupContext();
    return createClassroomScreenAccount({
        managerAccountId: membership.accountId,
        schoolId: school.id,
        administrativeClassId: input?.administrativeClassId,
        loginCode: input?.loginCode,
        pin: input?.pin,
        name: input?.name,
    });
}

export async function verifyInstanceSetupLogin(input = {}) {
    const {school} = await requireSetupContext();
    const kind = String(input.kind || "").trim().toUpperCase();
    const schoolCode = normalizeSchoolCode(input.schoolCode);
    if (schoolCode !== school.code) {
        throw setupError("学校代码、账号或凭据不正确", "SETUP_LOGIN_TEST_FAILED", 401);
    }

    if (kind === "SCREEN") {
        const loginCode = String(input.username || "").trim().toUpperCase();
        const binding = await prisma.classroomScreenBinding.findUnique({
            where: {schoolId_loginCode: {schoolId: school.id, loginCode}},
            include: {administrativeClass: {include: {term: true}}},
        });
        const matches = await bcrypt.compare(String(input.password || ""), binding?.pinHash || DUMMY_HASH);
        if (!binding || !binding.isActive || !matches) {
            throw setupError("学校代码、大屏账号或 PIN 不正确", "SETUP_LOGIN_TEST_FAILED", 401);
        }
        if (!binding.administrativeClass?.isActive || binding.administrativeClass.term?.status !== "ACTIVE") {
            throw setupError("大屏绑定的班级或学期未启用", "SETUP_SCREEN_INACTIVE", 409);
        }
        return {
            kind,
            account: binding.loginCode,
            name: binding.name,
            target: binding.administrativeClass.name,
        };
    }

    if (!new Set(["OWNER", "TEACHER"]).has(kind)) {
        throw setupError("请选择需要测试的账号类型", "SETUP_LOGIN_TEST_KIND_INVALID", 422);
    }
    const username = normalizeLocalUsername(input.username);
    const account = await prisma.account.findUnique({
        where: {
            provider_providerId: {
                provider: "school-local",
                providerId: localProviderId(school.code, username),
            },
        },
    });
    const schoolMembership = account
        ? await prisma.schoolMember.findUnique({
            where: {schoolId_accountId: {schoolId: school.id, accountId: account.id}},
        })
        : null;
    const isManager = new Set(["OWNER", "ADMIN"]).has(schoolMembership?.role);
    const expectedKind = kind === "OWNER" ? isManager : !isManager;
    let hash = account?.localPasswordHash || DUMMY_HASH;
    if (kind === "TEACHER") {
        if (school.teacherAuthMode === "OAUTH_EMAIL") {
            await bcrypt.compare(String(input.password || ""), hash);
            throw setupError("当前教师只使用 OAuth 登录，无法测试本地凭据", "SETUP_LOCAL_TEACHER_LOGIN_DISABLED", 409);
        }
        if (school.teacherAuthMode === "SHARED_PASSWORD") {
            hash = school.teacherSharedPasswordHash || DUMMY_HASH;
        }
    }
    const matches = await bcrypt.compare(String(input.password || ""), hash);
    if (!account || account.localDisabled || !expectedKind || !matches) {
        throw setupError("学校代码、账号或凭据不正确", "SETUP_LOGIN_TEST_FAILED", 401);
    }
    return {
        kind,
        account: account.localUsername,
        name: account.name,
        role: schoolMembership?.role || "TEACHER",
    };
}

function normalizeCoreInput(input = {}) {
    const currentYear = new Date().getFullYear();
    const value = {
        schoolCode: normalizeSchoolCode(input.schoolCode),
        schoolName: typeof input.schoolName === "string" ? input.schoolName.trim() : "",
        username: normalizeLocalUsername(input.username),
        administratorName: typeof input.administratorName === "string" ? input.administratorName.trim() : "",
        pin: typeof input.pin === "string" ? input.pin : "",
        teacherAuthMode: String(input.teacherAuthMode || "LOCAL_PIN").trim().toUpperCase(),
        sharedPassword: typeof input.sharedPassword === "string" ? input.sharedPassword : "",
        allowOAuthTeacherLogin: input.allowOAuthTeacherLogin === true,
        termName: typeof input.termName === "string" ? input.termName.trim() : "",
        academicYear: Number(input.academicYear || currentYear),
        semester: Number(input.semester || 1),
        startsAt: input.startsAt ? new Date(input.startsAt) : null,
        endsAt: input.endsAt ? new Date(input.endsAt) : null,
        createDefaultSubjects: input.createDefaultSubjects !== false,
    };
    const errors = [];
    if (!/^[A-Z0-9][A-Z0-9_-]{1,31}$/.test(value.schoolCode)) errors.push({path: "schoolCode", message: "学校代码需为2至32位字母、数字、横线或下划线"});
    if (!value.schoolName || value.schoolName.length > 191) errors.push({path: "schoolName", message: "请填写学校名称"});
    if (!AUTH_MODES.has(value.teacherAuthMode)) errors.push({path: "teacherAuthMode", message: "教师登录方式无效"});
    if (value.teacherAuthMode === "SHARED_PASSWORD" && !validateSharedTeacherPassword(value.sharedPassword)) errors.push({path: "sharedPassword", message: "学校通用教师密码需为8至64个字符"});
    if (!value.termName || value.termName.length > 191) errors.push({path: "termName", message: "请填写学期名称"});
    if (!Number.isInteger(value.academicYear) || value.academicYear < 2020 || value.academicYear > 2100) errors.push({path: "academicYear", message: "学年应在2020至2100之间"});
    if (![1, 2].includes(value.semester)) errors.push({path: "semester", message: "学期只能为第一或第二学期"});
    if (value.startsAt && Number.isNaN(value.startsAt.getTime())) errors.push({path: "startsAt", message: "学期开始日期无效"});
    if (value.endsAt && Number.isNaN(value.endsAt.getTime())) errors.push({path: "endsAt", message: "学期结束日期无效"});
    if (value.startsAt && value.endsAt && value.startsAt > value.endsAt) errors.push({path: "endsAt", message: "结束日期不能早于开始日期"});
    return {value, errors};
}

export async function initializeInstanceCore(input) {
    const status = await getInstanceSetupStatus();
    if (status.state === "COMPLETED") throw setupError("实例已经完成初始化", "SETUP_ALREADY_COMPLETED", 409);
    const normalized = normalizeCoreInput(input);
    if (normalized.errors.length) throw setupError("初始化信息不完整", "SETUP_INPUT_INVALID", 422, {errors: normalized.errors});
    const value = normalized.value;
    const existingBootstrapAccount = await prisma.account.findFirst({
        where: {provider: "school-local", providerData: {path: ["bootstrapAdministrator"], equals: true}},
    });
    if (!existingBootstrapAccount) {
        if (!validateLocalUsername(value.username)) normalized.errors.push({path: "username", message: "管理员短账号格式无效"});
        if (!value.administratorName || value.administratorName.length > 64) normalized.errors.push({path: "administratorName", message: "请填写管理员姓名"});
        if (!validateTeacherPin(value.pin)) normalized.errors.push({path: "pin", message: "管理员 PIN 需为4至8位数字"});
    } else if (existingBootstrapAccount.providerData?.schoolCode !== value.schoolCode) {
        throw setupError(`已创建管理员绑定的学校代码为 ${existingBootstrapAccount.providerData?.schoolCode}`, "SETUP_SCHOOL_CODE_MISMATCH", 409);
    }
    if (normalized.errors.length) throw setupError("初始化信息不完整", "SETUP_INPUT_INVALID", 422, {errors: normalized.errors});

    const [pinHash, sharedPasswordHash] = await Promise.all([
        existingBootstrapAccount ? null : bcrypt.hash(value.pin, BCRYPT_ROUNDS),
        value.teacherAuthMode === "SHARED_PASSWORD" ? bcrypt.hash(value.sharedPassword, 12) : null,
    ]);
    const result = await prisma.$transaction(async (tx) => {
        if (await tx.school.count()) throw setupError("实例已经存在学校", "SETUP_SCHOOL_EXISTS", 409);
        const account = existingBootstrapAccount || await tx.account.create({data: {
            provider: "school-local",
            providerId: localProviderId(value.schoolCode, value.username),
            name: value.administratorName,
            localUsername: value.username,
            localPasswordHash: pinHash,
            providerData: {schoolCode: value.schoolCode, bootstrapAdministrator: true},
        }});
        const school = await tx.school.create({data: {
            code: value.schoolCode,
            name: value.schoolName,
            teacherAuthMode: value.teacherAuthMode,
            allowOAuthTeacherLogin: value.allowOAuthTeacherLogin,
            teacherSharedPasswordHash: sharedPasswordHash,
        }});
        await tx.schoolMember.create({data: {schoolId: school.id, accountId: account.id, role: "OWNER"}});
        const term = await tx.academicTerm.create({data: {
            schoolId: school.id,
            name: value.termName,
            academicYear: value.academicYear,
            semester: value.semester,
            startsAt: value.startsAt,
            endsAt: value.endsAt,
            status: "ACTIVE",
        }});
        if (value.createDefaultSubjects) {
            await tx.subject.createMany({data: DEFAULT_SUBJECTS.map((subject) => ({...subject, schoolId: school.id}))});
        }
        await tx.instanceSetup.upsert({
            where: {id: SETUP_ID},
            update: {setupVersion: SETUP_VERSION},
            create: {id: SETUP_ID, setupVersion: SETUP_VERSION},
        });
        return {account, school, term};
    });
    const tokens = await generateTokenPair(result.account);
    return {
        account: publicLocalAccount(result.account),
        school: result.school,
        term: result.term,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        expires_in: tokens.accessTokenExpiresIn,
        refresh_expires_in: tokens.refreshTokenExpiresIn,
    };
}

export async function completeInstanceSetup() {
    const snapshot = await loadSetupSnapshot();
    if (snapshot.completed) return getInstanceSetupStatus();
    if (!snapshot.counts.owners || !snapshot.counts.activeTerms) {
        throw setupError("至少需要一位学校所有者和一个启用学期", "SETUP_CORE_INCOMPLETE", 409);
    }
    const owner = await prisma.schoolMember.findFirst({where: {role: "OWNER"}, select: {accountId: true}});
    await prisma.instanceSetup.upsert({
        where: {id: SETUP_ID},
        update: {setupVersion: SETUP_VERSION, completedAt: new Date(), completedByAccountId: owner?.accountId || null},
        create: {id: SETUP_ID, setupVersion: SETUP_VERSION, completedAt: new Date(), completedByAccountId: owner?.accountId || null},
    });
    return getInstanceSetupStatus();
}
