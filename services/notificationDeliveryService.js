import {prisma} from "../utils/prisma.js";
import {authorizationError} from "./academicAuthorizationService.js";
import {assertCanReadPublication} from "./publicationAuthorizationService.js";
import {publicationInclude} from "./publicationService.js";
import {resolveClassroomScreenWorkspaces} from "./classroomScreenService.js";
import {normalizeNotificationDeliveryItems} from "../domain/notificationDelivery.js";

function deliveryError(message, code, statusCode = 400) {
    return authorizationError(message, code, statusCode);
}

export async function acknowledgeScreenNotifications({screenBinding, items}) {
    const normalized = normalizeNotificationDeliveryItems(items)
        .sort((left, right) => left.publicationId.localeCompare(right.publicationId));
    if (!normalized.length) return [];
    if (!screenBinding.tokenHash) throw deliveryError("大屏绑定已失效", "SCREEN_TOKEN_INVALID", 401);

    const workspaces = await resolveClassroomScreenWorkspaces(screenBinding);
    const allowedWorkspaceIds = workspaces.map((workspace) => workspace.id);
    return prisma.$transaction(async tx => {
        // Serialize receipt batches for one binding and recheck the credential in the
        // same transaction. This UPDATE also prevents revocation halfway through.
        const binding = await tx.classroomScreenBinding.updateMany({
            where: {
                id: screenBinding.id, isActive: true, tokenHash: screenBinding.tokenHash,
                credentialVersion: screenBinding.credentialVersion,
                administrativeClassId: screenBinding.administrativeClassId,
            },
            data: {lastUsedAt: new Date()},
        });
        if (binding.count !== 1) throw deliveryError("大屏绑定已失效", "SCREEN_TOKEN_INVALID", 401);
        const results = [];
        for (const item of normalized) {
            // Publication writes must wait until this receipt commits. Re-read version
            // and status after the lock, so a delayed request cannot acknowledge old data.
            await tx.$queryRaw`SELECT "id" FROM "Publication" WHERE "id" = ${item.publicationId} FOR SHARE`;
            const publication = await tx.publication.findFirst({
                where: {
                    id: item.publicationId, revision: item.revision, type: "NOTICE", status: "PUBLISHED",
                    targets: {some: {workspaceId: {in: allowedWorkspaceIds}}},
                },
                select: {revision: true},
            });
            if (!publication) continue;
            const where = {publicationId_screenBindingId: {publicationId: item.publicationId, screenBindingId: screenBinding.id}};
            const previous = await tx.notificationScreenDelivery.findUnique({where});
            if (previous && previous.revision > item.revision) continue;
            const newRevision = previous?.revision !== item.revision;
            const now = new Date();
            results.push(await tx.notificationScreenDelivery.upsert({
                where,
                create: {
                    publicationId: item.publicationId, screenBindingId: screenBinding.id, revision: item.revision,
                    receivedAt: now, displayedAt: item.displayed ? now : null, acknowledgedAt: item.acknowledged ? now : null,
                },
                update: {
                    revision: item.revision,
                    ...(newRevision ? {
                        receivedAt: now, displayedAt: item.displayed ? now : null, acknowledgedAt: item.acknowledged ? now : null,
                    } : {}),
                    ...(!newRevision && item.displayed && !previous.displayedAt ? {displayedAt: now} : {}),
                    ...(!newRevision && item.acknowledged && !previous.acknowledgedAt ? {acknowledgedAt: now} : {}),
                },
            }));
        }
        return results;
    }, {maxWait: 10000, timeout: 15000});
}


export async function listNotificationScreenDeliveries({accountId, publicationId}) {
    const publication = await prisma.publication.findUnique({
        where: {id: publicationId},
        include: publicationInclude,
    });
    if (!publication) throw deliveryError("发布内容不存在", "PUBLICATION_NOT_FOUND", 404);
    await assertCanReadPublication(accountId, publication);
    if (publication.type !== "NOTICE") {
        throw deliveryError("只有通知提供大屏送达状态", "PUBLICATION_NOT_NOTICE", 409);
    }

    const administrativeClassIds = new Set();
    for (const target of publication.targets) {
        if (target.workspace.type === "ADMIN_CLASS") administrativeClassIds.add(target.workspaceId);
        for (const source of target.workspace.sourceClasses || []) {
            administrativeClassIds.add(source.administrativeClassId);
        }
    }
    const bindings = await prisma.classroomScreenBinding.findMany({
        where: {isActive: true, administrativeClassId: {in: [...administrativeClassIds]}},
        include: {
            administrativeClass: {select: {id: true, code: true, name: true}},
            notificationDeliveries: {where: {publicationId}},
        },
        orderBy: {name: "asc"},
    });
    return {
        publicationId,
        revision: publication.revision,
        screens: bindings.map((binding) => ({
            binding: {
                id: binding.id,
                name: binding.name,
                administrativeClass: binding.administrativeClass,
                lastUsedAt: binding.lastUsedAt,
            },
            delivery: binding.notificationDeliveries[0] || null,
        })),
    };
}
