import {prisma} from "../utils/prisma.js";
import {assertSchoolManager, authorizationError} from "./academicAuthorizationService.js";
import {classroomScreenDutyState, normalizeScreenRuntimeStatus} from "../domain/classroomScreenDuty.js";

const COMMAND_TYPES = new Set(["REFRESH_DATA", "RELOAD_APP"]);

function dutyError(message, code, status = 400, details = null) {
    return authorizationError(message, code, status, details);
}

export async function reportClassroomScreenHeartbeat({screenBinding, status}) {
    const now = new Date();
    const runtimeStatus = normalizeScreenRuntimeStatus(status);
    const commands = await prisma.$transaction(async (tx) => {
        await tx.classroomScreenBinding.update({
            where: {id: screenBinding.id},
            data: {lastHeartbeatAt: now, lastUsedAt: now, runtimeStatus},
        });
        const pending = await tx.classroomScreenCommand.findMany({
            where: {
                screenBindingId: screenBinding.id,
                status: {in: ["PENDING", "DELIVERED"]},
                expiresAt: {gt: now},
            },
            orderBy: {createdAt: "asc"},
            take: 10,
        });
        if (pending.length) {
            await tx.classroomScreenCommand.updateMany({
                where: {id: {in: pending.map((item) => item.id)}, status: "PENDING"},
                data: {status: "DELIVERED", deliveredAt: now},
            });
        }
        return pending;
    });
    return {receivedAt: now, commands: commands.map(({id, type, payload, createdAt}) => ({id, type, payload, createdAt}))};
}

export async function acknowledgeClassroomScreenCommand({screenBinding, commandId, success, result}) {
    const command = await prisma.classroomScreenCommand.findFirst({
        where: {id: commandId, screenBindingId: screenBinding.id},
    });
    if (!command) throw dutyError("值守指令不存在", "SCREEN_COMMAND_NOT_FOUND", 404);
    if (new Set(["ACKNOWLEDGED", "FAILED"]).has(command.status)) return command;
    return prisma.classroomScreenCommand.update({
        where: {id: command.id},
        data: {
            status: success === false ? "FAILED" : "ACKNOWLEDGED",
            result: result ? {message: String(result.message || "").slice(0, 500)} : undefined,
            acknowledgedAt: new Date(),
        },
    });
}

export async function issueClassroomScreenCommand({managerAccountId, schoolId, bindingId, type, payload}) {
    await assertSchoolManager(managerAccountId, schoolId);
    if (!COMMAND_TYPES.has(type)) throw dutyError("不支持的值守指令", "SCREEN_COMMAND_INVALID", 422);
    const binding = await prisma.classroomScreenBinding.findFirst({where: {id: bindingId, schoolId, isActive: true}});
    if (!binding) throw dutyError("大屏不存在或已停用", "SCREEN_BINDING_NOT_FOUND", 404);
    return prisma.classroomScreenCommand.create({
        data: {
            screenBindingId: binding.id,
            issuedByAccountId: managerAccountId,
            type,
            payload: payload || undefined,
            expiresAt: new Date(Date.now() + 15 * 60 * 1000),
        },
    });
}

export {classroomScreenDutyState};
