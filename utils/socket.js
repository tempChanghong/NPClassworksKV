/**
 * NPClassworks workspace real-time invalidation.
 *
 * Socket messages only carry publication identifiers and revisions. Homework
 * content continues to be fetched through the HTTP APIs.
 */
import {Server} from "socket.io";
import {prisma} from "./prisma.js";
import {getAllowedOrigins} from "./corsConfig.js";

let io = null;

export function initSocket(server) {
    if (io) return io;

    io = new Server(server, {
        cors: {
            origin: getAllowedOrigins(),
            methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
            allowedHeaders: ["Authorization", "Content-Type", "X-Classworks-Screen-Token"],
            credentials: false,
        },
        transports: ["polling", "websocket"],
    });

    io.on("connection", (socket) => {
        socket.data.workspaceIds = new Set();

        socket.on("join-workspaces", async (payload) => {
            try {
                const requestedIds = [...new Set(
                    (Array.isArray(payload?.workspaceIds) ? payload.workspaceIds : [])
                        .filter((id) => typeof id === "string" && id.trim())
                        .map((id) => id.trim()),
                )];
                if (requestedIds.length === 0 || requestedIds.length > 20) {
                    socket.emit("workspaces-join-error", {reason: "invalid_workspace_count", max: 20});
                    return;
                }
                const workspaces = await prisma.workspace.findMany({
                    where: {id: {in: requestedIds}, isActive: true, term: {status: "ACTIVE"}},
                    select: {id: true},
                });
                const joinedIds = workspaces.map((workspace) => workspace.id);
                const joinedIdSet = new Set(joinedIds);
                for (const workspaceId of joinedIds) {
                    socket.join(`workspace:${workspaceId}`);
                    socket.data.workspaceIds.add(workspaceId);
                }
                socket.emit("workspaces-joined", {
                    workspaceIds: joinedIds,
                    rejectedWorkspaceIds: requestedIds.filter((id) => !joinedIdSet.has(id)),
                });
            } catch (error) {
                console.error("join-workspaces error:", error);
                socket.emit("workspaces-join-error", {reason: "database_error"});
            }
        });

        socket.on("leave-workspaces", (payload) => {
            const ids = Array.isArray(payload?.workspaceIds)
                ? payload.workspaceIds
                : Array.from(socket.data.workspaceIds || []);
            for (const workspaceId of ids) {
                if (typeof workspaceId !== "string") continue;
                socket.leave(`workspace:${workspaceId}`);
                socket.data.workspaceIds.delete(workspaceId);
            }
        });
    });

    return io;
}

export function getIO() {
    return io;
}

export function broadcastWorkspaceEvent(workspaceIds, type, content = null) {
    if (!io || !Array.isArray(workspaceIds) || typeof type !== "string") return;
    const timestamp = new Date().toISOString();
    const eventPayload = {
        eventId: `workspace-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
        content,
        timestamp,
        senderId: "publication-service",
        senderInfo: {
            appId: "npclassworks",
            deviceType: "server",
            deviceName: "publication-service",
            isReadOnly: false,
            note: "Workspace feed invalidation",
        },
    };
    for (const workspaceId of new Set(workspaceIds.filter(Boolean))) {
        io.to(`workspace:${workspaceId}`).emit(type.trim(), eventPayload);
    }
}

export default {initSocket, getIO, broadcastWorkspaceEvent};
