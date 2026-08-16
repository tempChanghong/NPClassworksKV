import {createHash, randomBytes} from "node:crypto";
import bcrypt from "bcrypt";
import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";
import {
    normalizeScreenLoginCode,
    validateDeviceFingerprint,
    validateScreenLoginCode,
    validateScreenPin,
} from "../domain/classroomScreenAccount.js";
import {sanitizeHomeworkQuickDeadlines, sanitizeHomeworkQuickInputs} from "../domain/schoolHomeworkSettings.js";

const MAX_LOGIN_FAILURES = 5;
const LOCK_MINUTES = 15;
const BCRYPT_ROUNDS = Math.min(14, Math.max(10, Number(process.env.LOCAL_AUTH_BCRYPT_ROUNDS) || 10));
const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEe.5l4KJg7jL7vY4PZwXH0mD7tZKX8zXn2";

const screenInclude = {
    school: {select: {id: true, code: true, name: true, homeworkQuickDeadlines: true, homeworkQuickInputs: true}},
    administrativeClass: {
        include: {
            term: {include: {school: {select: {id: true, code: true, name: true}}}},
            grade: {select: {id: true, code: true, name: true}},
            subjectRules: true,
        },
    },
};

function screenError(message, code, statusCode = 400, details = null) {
    return authorizationError(message, code, statusCode, details);
}

function cleanText(value) {
    return typeof value === "string" ? value.trim() : "";
}

function tokenHash(token) {
    return createHash("sha256").update(token).digest("hex");
}

function publicScreenBinding(binding) {
    if (!binding) return binding;
    const {tokenHash: _tokenHash, pinHash: _pinHash, ...safeBinding} = binding;
    return safeBinding;
}

async function requireAdministrativeClass(schoolId, administrativeClassId) {
    const administrativeClass = await prisma.workspace.findFirst({
        where: {
            id: administrativeClassId,
            type: "ADMIN_CLASS",
            isActive: true,
            term: {schoolId},
        },
        include: {term: true},
    });
    if (!administrativeClass) {
        throw screenError("行政班不存在或不属于该学校", "SCREEN_ADMIN_CLASS_INVALID", 422);
    }
    if (administrativeClass.term.status !== "ACTIVE") {
        throw screenError("只能绑定当前启用学期的行政班", "SCREEN_TERM_NOT_ACTIVE", 422);
    }
    return administrativeClass;
}

async function registerLoginFailure(binding) {
    if (!binding) return;
    const failures = binding.loginFailures + 1;
    await prisma.classroomScreenBinding.update({
        where: {id: binding.id},
        data: {
            loginFailures: failures >= MAX_LOGIN_FAILURES ? 0 : failures,
            lockedUntil: failures >= MAX_LOGIN_FAILURES
                ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
                : binding.lockedUntil,
        },
    });
}

export async function createClassroomScreenAccount({
    managerAccountId,
    schoolId,
    administrativeClassId,
    loginCode,
    pin,
    name,
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const cleanLoginCode = normalizeScreenLoginCode(loginCode);
    const cleanName = cleanText(name);
    if (!validateScreenLoginCode(cleanLoginCode)) {
        throw screenError("大屏账号需为3至32位字母、数字、点、横线或下划线", "SCREEN_LOGIN_CODE_INVALID", 422);
    }
    if (!validateScreenPin(pin)) {
        throw screenError("大屏 PIN 需为4至8位数字", "SCREEN_PIN_INVALID", 422);
    }
    if (!cleanName || cleanName.length > 191) {
        throw screenError("大屏名称不能为空且不能超过191个字符", "SCREEN_NAME_INVALID", 422);
    }
    await requireAdministrativeClass(schoolId, administrativeClassId);
    const existing = await prisma.classroomScreenBinding.findUnique({
        where: {schoolId_loginCode: {schoolId, loginCode: cleanLoginCode}},
    });
    if (existing) throw screenError("该大屏账号已存在", "SCREEN_LOGIN_CODE_EXISTS", 409);
    const binding = await prisma.classroomScreenBinding.create({
        data: {
            schoolId,
            administrativeClassId,
            deviceFingerprint: null,
            name: cleanName,
            loginCode: cleanLoginCode,
            pinHash: await bcrypt.hash(pin, BCRYPT_ROUNDS),
            tokenHash: tokenHash(randomBytes(32).toString("base64url")),
            createdByAccountId: managerAccountId,
        },
        include: screenInclude,
    });
    return publicScreenBinding(binding);
}

export async function configureClassroomScreenAccount({
    managerAccountId,
    schoolId,
    bindingId,
    loginCode,
    pin,
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const cleanLoginCode = normalizeScreenLoginCode(loginCode);
    if (!validateScreenLoginCode(cleanLoginCode)) {
        throw screenError("大屏账号需为3至32位字母、数字、点、横线或下划线", "SCREEN_LOGIN_CODE_INVALID", 422);
    }
    if (!validateScreenPin(pin)) {
        throw screenError("大屏 PIN 需为4至8位数字", "SCREEN_PIN_INVALID", 422);
    }
    const binding = await prisma.classroomScreenBinding.findFirst({where: {id: bindingId, schoolId}});
    if (!binding) throw screenError("大屏绑定不存在", "SCREEN_BINDING_NOT_FOUND", 404);
    const duplicate = await prisma.classroomScreenBinding.findFirst({
        where: {schoolId, loginCode: cleanLoginCode, NOT: {id: bindingId}},
    });
    if (duplicate) throw screenError("该大屏账号已存在", "SCREEN_LOGIN_CODE_EXISTS", 409);
    const updated = await prisma.classroomScreenBinding.update({
        where: {id: bindingId},
        data: {
            loginCode: cleanLoginCode,
            pinHash: await bcrypt.hash(pin, BCRYPT_ROUNDS),
            credentialVersion: {increment: 1},
            loginFailures: 0,
            lockedUntil: null,
        },
        include: screenInclude,
    });
    return publicScreenBinding(updated);
}

export async function updateClassroomScreenAccount({
    managerAccountId,
    schoolId,
    bindingId,
    administrativeClassId,
    loginCode,
    pin,
    name,
    isActive,
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const binding = await prisma.classroomScreenBinding.findFirst({where: {id: bindingId, schoolId}});
    if (!binding) throw screenError("大屏绑定不存在", "SCREEN_BINDING_NOT_FOUND", 404);

    const data = {};
    if (administrativeClassId !== undefined) {
        await requireAdministrativeClass(schoolId, administrativeClassId);
        data.administrativeClassId = administrativeClassId;
    }
    if (loginCode !== undefined) {
        const cleanLoginCode = normalizeScreenLoginCode(loginCode);
        if (!validateScreenLoginCode(cleanLoginCode)) {
            throw screenError("大屏账号需为3至32位字母、数字、点、横线或下划线", "SCREEN_LOGIN_CODE_INVALID", 422);
        }
        const duplicate = await prisma.classroomScreenBinding.findFirst({
            where: {schoolId, loginCode: cleanLoginCode, NOT: {id: bindingId}},
        });
        if (duplicate) throw screenError("该大屏账号已存在", "SCREEN_LOGIN_CODE_EXISTS", 409);
        data.loginCode = cleanLoginCode;
    }
    if (name !== undefined) {
        const cleanName = cleanText(name);
        if (!cleanName || cleanName.length > 191) {
            throw screenError("大屏名称不能为空且不能超过191个字符", "SCREEN_NAME_INVALID", 422);
        }
        data.name = cleanName;
    }
    if (pin !== undefined && pin !== "") {
        if (!validateScreenPin(pin)) {
            throw screenError("大屏 PIN 需为4至8位数字", "SCREEN_PIN_INVALID", 422);
        }
        data.pinHash = await bcrypt.hash(pin, BCRYPT_ROUNDS);
        data.loginFailures = 0;
        data.lockedUntil = null;
        data.credentialVersion = {increment: 1};
    }
    if (isActive !== undefined) data.isActive = Boolean(isActive);

    const updated = await prisma.classroomScreenBinding.update({
        where: {id: bindingId},
        data,
        include: screenInclude,
    });
    return publicScreenBinding(updated);
}

export async function resetClassroomScreenDevice({managerAccountId, schoolId, bindingId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const binding = await prisma.classroomScreenBinding.findFirst({where: {id: bindingId, schoolId}});
    if (!binding) throw screenError("大屏绑定不存在", "SCREEN_BINDING_NOT_FOUND", 404);
    const updated = await prisma.classroomScreenBinding.update({
        where: {id: bindingId},
        data: {
            deviceFingerprint: null,
            tokenHash: tokenHash(randomBytes(32).toString("base64url")),
            activatedAt: null,
            lastUsedAt: null,
            loginFailures: 0,
            lockedUntil: null,
            credentialVersion: {increment: 1},
        },
        include: screenInclude,
    });
    return publicScreenBinding(updated);
}

export async function loginClassroomScreen({schoolCode, loginCode, pin, deviceFingerprint}) {
    const normalizedSchoolCode = cleanText(schoolCode).toUpperCase();
    const normalizedLoginCode = normalizeScreenLoginCode(loginCode);
    const cleanFingerprint = cleanText(deviceFingerprint);
    if (!validateDeviceFingerprint(cleanFingerprint)) {
        throw screenError("无法识别当前浏览器，请刷新后重试", "SCREEN_FINGERPRINT_INVALID", 422);
    }
    const school = await prisma.school.findUnique({where: {code: normalizedSchoolCode}});
    const binding = school && validateScreenLoginCode(normalizedLoginCode)
        ? await prisma.classroomScreenBinding.findUnique({
            where: {schoolId_loginCode: {schoolId: school.id, loginCode: normalizedLoginCode}},
            include: screenInclude,
        })
        : null;
    if (binding?.lockedUntil && binding.lockedUntil > new Date()) {
        throw screenError("错误次数过多，请15分钟后重试或联系管理员重置大屏 PIN", "SCREEN_ACCOUNT_LOCKED", 429);
    }
    const pinMatches = await bcrypt.compare(String(pin || ""), binding?.pinHash || DUMMY_HASH);
    if (!binding || !binding.isActive || !pinMatches) {
        await registerLoginFailure(binding);
        throw screenError("学校代码、大屏账号或 PIN 不正确", "SCREEN_LOGIN_FAILED", 401);
    }
    if (!binding.administrativeClass.isActive || binding.administrativeClass.term.status !== "ACTIVE") {
        throw screenError("大屏绑定的班级或学期已停用", "SCREEN_BINDING_INACTIVE", 409);
    }
    if (binding.deviceFingerprint && binding.deviceFingerprint !== cleanFingerprint) {
        throw screenError("该大屏账号已绑定其他设备，请联系管理员重置设备", "SCREEN_DEVICE_MISMATCH", 409);
    }
    const existingDevice = await prisma.classroomScreenBinding.findUnique({
        where: {schoolId_deviceFingerprint: {schoolId: binding.schoolId, deviceFingerprint: cleanFingerprint}},
    });
    if (existingDevice && existingDevice.id !== binding.id) {
        throw screenError("当前设备已绑定其他大屏账号，请联系管理员升级或解除原绑定", "SCREEN_DEVICE_ALREADY_BOUND", 409);
    }
    const rawToken = randomBytes(32).toString("base64url");
    const updated = await prisma.classroomScreenBinding.update({
        where: {id: binding.id},
        data: {
            deviceFingerprint: cleanFingerprint,
            tokenHash: tokenHash(rawToken),
            loginFailures: 0,
            lockedUntil: null,
            activatedAt: binding.activatedAt || new Date(),
            lastUsedAt: new Date(),
        },
        include: screenInclude,
    });
    return {binding: publicScreenBinding(updated), token: rawToken};
}

export async function verifyClassroomScreenPin(binding, pin) {
    if (!binding.pinHash) {
        throw screenError("该设备尚未配置大屏 PIN，请由管理员升级大屏账号", "SCREEN_PIN_NOT_CONFIGURED", 409);
    }
    if (binding.lockedUntil && binding.lockedUntil > new Date()) {
        throw screenError("错误次数过多，请15分钟后重试", "SCREEN_ACCOUNT_LOCKED", 429);
    }
    if (!await bcrypt.compare(String(pin || ""), binding.pinHash)) {
        await registerLoginFailure(binding);
        throw screenError("大屏 PIN 不正确", "SCREEN_PIN_INCORRECT", 401);
    }
    await prisma.classroomScreenBinding.update({
        where: {id: binding.id},
        data: {loginFailures: 0, lockedUntil: null},
    });
    return {verified: true};
}

export async function bindClassroomScreen({
    managerAccountId,
    schoolId,
    administrativeClassId,
    deviceFingerprint,
    name,
}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const cleanFingerprint = cleanText(deviceFingerprint);
    const cleanName = cleanText(name);
    if (!validateDeviceFingerprint(cleanFingerprint)) {
        throw screenError("无法识别当前浏览器，请刷新后重试", "SCREEN_FINGERPRINT_INVALID", 422);
    }
    if (!cleanName || cleanName.length > 191) {
        throw screenError("大屏名称不能为空且不能超过191个字符", "SCREEN_NAME_INVALID", 422);
    }
    await requireAdministrativeClass(schoolId, administrativeClassId);

    const rawToken = randomBytes(32).toString("base64url");
    const binding = await prisma.classroomScreenBinding.upsert({
        where: {schoolId_deviceFingerprint: {schoolId, deviceFingerprint: cleanFingerprint}},
        create: {
            schoolId,
            administrativeClassId,
            deviceFingerprint: cleanFingerprint,
            name: cleanName,
            tokenHash: tokenHash(rawToken),
            createdByAccountId: managerAccountId,
        },
        update: {
            administrativeClassId,
            name: cleanName,
            tokenHash: tokenHash(rawToken),
            isActive: true,
            createdByAccountId: managerAccountId,
        },
        include: screenInclude,
    });
    return {binding: publicScreenBinding(binding), token: rawToken};
}

export async function authenticateClassroomScreen(rawToken) {
    const token = cleanText(rawToken);
    if (!token) throw screenError("当前浏览器尚未绑定为班级大屏", "SCREEN_TOKEN_REQUIRED", 401);
    const binding = await prisma.classroomScreenBinding.findUnique({
        where: {tokenHash: tokenHash(token)},
        include: screenInclude,
    });
    if (!binding || !binding.isActive) {
        throw screenError("大屏绑定已失效，请联系管理员重新绑定", "SCREEN_TOKEN_INVALID", 401);
    }
    if (!binding.administrativeClass.isActive || binding.administrativeClass.term.status !== "ACTIVE") {
        throw screenError("大屏绑定的班级或学期已停用", "SCREEN_BINDING_INACTIVE", 409);
    }
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    if (!binding.lastUsedAt || binding.lastUsedAt.getTime() < oneHourAgo) {
        await prisma.classroomScreenBinding.update({
            where: {id: binding.id},
            data: {lastUsedAt: new Date()},
        });
    }
    return binding;
}

export function isClassroomScreenWorkspaceAllowed(binding, workspace) {
    const administrativeClass = binding.administrativeClass;
    if (workspace.termId !== administrativeClass.termId || workspace.gradeId !== administrativeClass.gradeId) {
        return false;
    }
    if (workspace.type === "ADMIN_CLASS") return workspace.id === administrativeClass.id;
    if (workspace.type !== "COURSE_GROUP") return false;
    const rule = administrativeClass.subjectRules?.find(
        (candidate) => candidate.subjectId === workspace.subjectId,
    );
    return rule?.deliveryMode === "COURSE_GROUP" && workspace.sourceClasses?.some(
        (sourceClass) => sourceClass.administrativeClassId === administrativeClass.id,
    );
}

export async function resolveClassroomScreenWorkspaces(binding) {
    const walkingSubjectIds = binding.administrativeClass.subjectRules
        .filter((rule) => rule.deliveryMode === "COURSE_GROUP")
        .map((rule) => rule.subjectId);
    const courseGroups = walkingSubjectIds.length > 0
        ? await prisma.workspace.findMany({
            where: {
                termId: binding.administrativeClass.termId,
                gradeId: binding.administrativeClass.gradeId,
                type: "COURSE_GROUP",
                subjectId: {in: walkingSubjectIds},
                isActive: true,
                sourceClasses: {
                    some: {administrativeClassId: binding.administrativeClassId},
                },
            },
            include: {
                term: {include: {school: {select: {id: true, code: true, name: true}}}},
                grade: {select: {id: true, code: true, name: true}},
                subject: {select: {id: true, code: true, name: true, category: true}},
                sourceClasses: {
                    include: {administrativeClass: {select: {id: true, code: true, name: true}}},
                },
                subjectRules: true,
            },
            orderBy: [{subject: {sortOrder: "asc"}}, {code: "asc"}],
        })
        : [];
    return [binding.administrativeClass, ...courseGroups];
}

export async function listClassroomScreenTargets(binding) {
    return {
        binding: publicScreenBinding(binding),
        workspaces: await resolveClassroomScreenWorkspaces(binding),
        homeworkSettings: {
            quickDeadlines: sanitizeHomeworkQuickDeadlines(binding.school?.homeworkQuickDeadlines),
            quickInputs: sanitizeHomeworkQuickInputs(binding.school?.homeworkQuickInputs),
        },
    };
}

export async function listClassroomScreens({managerAccountId, schoolId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const bindings = await prisma.classroomScreenBinding.findMany({
        where: {schoolId},
        include: screenInclude,
        orderBy: [{isActive: "desc"}, {name: "asc"}],
    });
    return bindings.map(publicScreenBinding);
}

export async function setClassroomScreenActive({managerAccountId, schoolId, bindingId, isActive}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const binding = await prisma.classroomScreenBinding.findFirst({
        where: {id: bindingId, schoolId},
    });
    if (!binding) throw screenError("大屏绑定不存在", "SCREEN_BINDING_NOT_FOUND", 404);
    const updated = await prisma.classroomScreenBinding.update({
        where: {id: bindingId},
        data: {isActive: Boolean(isActive)},
        include: screenInclude,
    });
    return publicScreenBinding(updated);
}

export {publicScreenBinding, screenInclude};
