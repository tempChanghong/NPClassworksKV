const VERSION = 1;
const MAX_RECENT = 5;
const MAX_FAVORITES = 8;
const MAX_TARGETS = 20;
const MAX_ID_LENGTH = 191;

function safeId(value) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH
        ? value
        : null;
}

function normalizedCombination(value, now = () => new Date()) {
    const targetWorkspaceIds = [...new Set(
        (Array.isArray(value?.targetWorkspaceIds) ? value.targetWorkspaceIds : [])
            .map(safeId)
            .filter(Boolean),
    )].sort().slice(0, MAX_TARGETS);
    if (!targetWorkspaceIds.length) return null;

    const type = value?.type === "NOTICE" ? "NOTICE" : "ASSIGNMENT";
    const savedAt = typeof value?.savedAt === "string" && Number.isFinite(Date.parse(value.savedAt))
        ? new Date(value.savedAt).toISOString()
        : now().toISOString();
    return {
        type,
        subjectId: type === "NOTICE" ? null : safeId(value?.subjectId),
        targetWorkspaceIds,
        savedAt,
    };
}

export function teacherTargetCombinationId(value) {
    const normalized = normalizedCombination(value);
    return normalized
        ? [normalized.type, normalized.subjectId || "", ...normalized.targetWorkspaceIds].join(":")
        : "";
}

export function sanitizeTeacherTargetPreferences(value = {}, now) {
    const unique = (items, limit) => {
        const seen = new Set();
        return (Array.isArray(items) ? items : []).map((item) => normalizedCombination(item, now)).filter((item) => {
            const id = teacherTargetCombinationId(item);
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        }).slice(0, limit);
    };
    return {
        version: VERSION,
        favorites: unique(value.favorites, MAX_FAVORITES),
        recent: unique(value.recent, MAX_RECENT),
    };
}
