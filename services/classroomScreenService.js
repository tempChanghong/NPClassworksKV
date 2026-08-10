import {createHash, randomBytes} from "node:crypto";
import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";

const screenInclude = {
    school: {select: {id: true, code: true, name: true}},
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
    if (!cleanFingerprint || cleanFingerprint === "unknown" || cleanFingerprint.length > 191) {
        throw screenError("无法识别当前浏览器，请刷新后重试", "SCREEN_FINGERPRINT_INVALID", 422);
    }
    if (!cleanName || cleanName.length > 191) {
        throw screenError("大屏名称不能为空且不能超过191个字符", "SCREEN_NAME_INVALID", 422);
    }
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
    return {binding, token: rawToken};
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
        binding,
        workspaces: await resolveClassroomScreenWorkspaces(binding),
    };
}

export async function listClassroomScreens({managerAccountId, schoolId}) {
    await assertSchoolManager(managerAccountId, schoolId);
    return prisma.classroomScreenBinding.findMany({
        where: {schoolId},
        include: screenInclude,
        orderBy: [{isActive: "desc"}, {name: "asc"}],
    });
}

export async function setClassroomScreenActive({managerAccountId, schoolId, bindingId, isActive}) {
    await assertSchoolManager(managerAccountId, schoolId);
    const binding = await prisma.classroomScreenBinding.findFirst({
        where: {id: bindingId, schoolId},
    });
    if (!binding) throw screenError("大屏绑定不存在", "SCREEN_BINDING_NOT_FOUND", 404);
    return prisma.classroomScreenBinding.update({
        where: {id: bindingId},
        data: {isActive: Boolean(isActive)},
        include: screenInclude,
    });
}

export {screenInclude};
