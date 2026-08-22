export function normalizeScreenRuntimeStatus(input = {}) {
    return {
        appVersion: String(input.appVersion || "").slice(0, 32),
        route: String(input.route || "").slice(0, 256),
        visibility: input.visibility === "hidden" ? "hidden" : "visible",
        online: input.online !== false,
        realtimeConnected: input.realtimeConnected === true,
        pendingUploads: Math.min(999, Math.max(0, Number(input.pendingUploads) || 0)),
        syncState: String(input.syncState || "unknown").slice(0, 32),
        lastError: String(input.lastError || "").slice(0, 500),
        displayMode: String(input.displayMode || "screen").slice(0, 32),
    };
}

export function classroomScreenDutyState(binding, now = Date.now()) {
    if (!binding.isActive) return "DISABLED";
    if (!binding.activatedAt) return "NOT_ACTIVATED";
    if (!binding.lastHeartbeatAt || now - binding.lastHeartbeatAt.getTime() > 5 * 60 * 1000) return "OFFLINE";
    const status = binding.runtimeStatus || {};
    if (!status.online || !status.realtimeConnected || status.pendingUploads > 0 || status.lastError) return "DEGRADED";
    return "ONLINE";
}
