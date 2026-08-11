import {prisma} from "../utils/prisma.js";
import {authorizationError} from "./academicAuthorizationService.js";
import {assertCanReadPublication} from "./publicationAuthorizationService.js";
import {publicationInclude} from "./publicationService.js";
import {resolveClassroomScreenWorkspaces} from "./classroomScreenService.js";

function deliveryError(message, code, statusCode = 400) {
    return authorizationError(message, code, statusCode);
}

export async function acknowledgeScreenNotifications({screenBinding, items}) {
    const normalized = (Array.isArray(items) ? items : []).map((item) => ({
        publicationId: typeof item?.publicationId === "string" ? item.publicationId : "",
        revision: Number(item?.revision),
        displayed: item?.displayed === true,
    })).filter((item) => item.publicationId && Number.isInteger(item.revision) && item.revision > 0).slice(0, 100);
    if (!normalized.length) return [];

    const workspaces = await resolveClassroomScreenWorkspaces(screenBinding);
    const allowedWorkspaceIds = workspaces.map((workspace) => workspace.id);
    const publications = await prisma.publication.findMany({
        where: {
            id: {in: normalized.map((item) => item.publicationId)},
            type: "NOTICE",
            status: "PUBLISHED",
            targets: {some: {workspaceId: {in: allowedWorkspaceIds}}},
        },
        select: {id: true, revision: true},
    });
    const allowed = new Map(publications.map((publication) => [publication.id, publication]));
    const existing = await prisma.notificationScreenDelivery.findMany({
        where: {
            screenBindingId: screenBinding.id,
            publicationId: {in: [...allowed.keys()]},
        },
    });
    const existingByPublication = new Map(existing.map((delivery) => [delivery.publicationId, delivery]));
    const now = new Date();
    const operations = normalized.flatMap((item) => {
        const publication = allowed.get(item.publicationId);
        if (!publication || publication.revision !== item.revision) return [];
        const previous = existingByPublication.get(item.publicationId);
        const newRevision = previous?.revision !== item.revision;
        return [prisma.notificationScreenDelivery.upsert({
            where: {
                publicationId_screenBindingId: {
                    publicationId: item.publicationId,
                    screenBindingId: screenBinding.id,
                },
            },
            create: {
                publicationId: item.publicationId,
                screenBindingId: screenBinding.id,
                revision: item.revision,
                receivedAt: now,
                displayedAt: item.displayed ? now : null,
            },
            update: {
                revision: item.revision,
                ...(newRevision ? {receivedAt: now, displayedAt: item.displayed ? now : null} : {}),
                ...(!newRevision && item.displayed && !previous?.displayedAt ? {displayedAt: now} : {}),
            },
        })];
    });
    await prisma.classroomScreenBinding.update({
        where: {id: screenBinding.id},
        data: {lastUsedAt: now},
    });
    return operations.length ? prisma.$transaction(operations) : [];
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
