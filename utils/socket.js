/**
 * NPClassworks workspace real-time invalidation.
 *
 * Socket messages only carry publication identifiers and revisions. Homework
 * content continues to be fetched through the HTTP APIs.
 */
import {Server} from "socket.io";
import {prisma} from "./prisma.js";
import {getAllowedOrigins} from "./corsConfig.js";
import {socketConnectionsGauge} from "./metrics.js";
import {canReceiveWorkspaceEvent, socketCredentials} from "../services/socketEventAuthorization.js";

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
        socketConnectionsGauge.inc();
        socket.once("disconnect", () => socketConnectionsGauge.dec());
        socket.data.workspaceIds = new Set();
        socket.data.credentials = socketCredentials(socket.handshake.auth);
        socket.data.leaveGeneration = 0;
        socket.data.credentialGeneration = 0;
        socket.on("update-credentials", payload => {
            socket.data.credentialGeneration++;
            socket.data.credentials = socketCredentials(payload);
        });

        socket.on("join-workspaces", async (payload) => {
            try {
                const generation = socket.data.leaveGeneration;
                socket.data.credentialGeneration++;
                socket.data.credentials = socketCredentials(payload?.credentials || socket.data.credentials);
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
                if (!socket.connected || generation !== socket.data.leaveGeneration) return;
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
            socket.data.leaveGeneration++;
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

export async function broadcastWorkspaceEvent(workspaceIds, type, content = null, {wasPublished = false} = {}) {
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
    const ids = [...new Set(workspaceIds.filter(Boolean))];
    const rooms = ids.map(id => `workspace:${id}`);
    if (!rooms.length) return;
    try {
        const sockets = await io.in(rooms).fetchSockets();
        for (const socket of sockets) {
            const joinedIds = ids.filter(id => socket.rooms.has(`workspace:${id}`));
            if (!joinedIds.length) continue;
            const generation = socket.data.credentialGeneration;
            const authorized = await canReceiveWorkspaceEvent(socket.data.credentials || {}, joinedIds, type, content);
            if (generation !== socket.data.credentialGeneration || !joinedIds.some(id => socket.rooms.has(`workspace:${id}`))) continue;
            if (authorized) {
                if (joinedIds.some(id => socket.rooms.has(`workspace:${id}`))) socket.emit(type.trim(), eventPayload);
            } else if (type.startsWith("publication.") && (content?.status === "PUBLISHED" || wasPublished)) {
                // Public feeds need only a refresh signal, never internal publication metadata.
                socket.emit("publication.feed.changed", {});
            }
        }
    } catch (error) {console.error("workspace event delivery failed:", error?.name || "Error");}
}

export default {initSocket, getIO, broadcastWorkspaceEvent};
