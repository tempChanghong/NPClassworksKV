import {prisma} from "../utils/prisma.js";

const DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

function restorableTargetIds(snapshot) {
    return Array.isArray(snapshot?.targetWorkspaceIds)
        ? snapshot.targetWorkspaceIds.filter((id) => typeof id === "string")
        : [];
}

/**
 * Purge only the content body of non-current, uncertified assignment revisions whose
 * target teaching spaces are all disabled. The row remains as an audit shell;
 * certified and current revisions are never eligible.
 */
export async function purgeExpiredDisabledPublicationRevisions({
    now = new Date(),
    retentionMs = DEFAULT_RETENTION_MS,
    limit = 200,
} = {}) {
    const safeRetentionMs = Math.max(Number(retentionMs) || DEFAULT_RETENTION_MS, 60 * 1000);
    const cutoff = new Date(now.getTime() - safeRetentionMs);
    const candidates = await prisma.publicationRevision.findMany({
        where: {
            isCertified: false,
            purgedAt: null,
            createdAt: {lt: cutoff},
        },
        orderBy: {createdAt: "asc"},
        take: Math.min(Math.max(Number(limit) || 200, 1), 1000),
        include: {publication: {select: {revision: true}}},
    });
    const targetIds = [...new Set(candidates.flatMap((candidate) => restorableTargetIds(candidate.snapshot)))];
    const activeTargets = targetIds.length
        ? await prisma.workspace.findMany({
            where: {id: {in: targetIds}, isActive: true},
            select: {id: true},
        })
        : [];
    const activeTargetIds = new Set(activeTargets.map((workspace) => workspace.id));
    const eligible = candidates.filter((candidate) => {
        if (candidate.revision === candidate.publication.revision) return false;
        if (candidate.snapshot?.type !== "ASSIGNMENT" || !candidate.snapshot?.subjectId) return false;
        const ids = restorableTargetIds(candidate.snapshot);
        return ids.length > 0 && ids.every((id) => !activeTargetIds.has(id));
    });
    if (eligible.length === 0) return {purged: 0, cutoff};

    await prisma.$transaction(eligible.map((candidate) => prisma.publicationRevision.update({
        where: {id: candidate.id},
        data: {
            purgedAt: now,
            snapshot: {
                purged: true,
                type: candidate.snapshot.type,
                subjectId: candidate.snapshot.subjectId,
                status: candidate.snapshot.status,
                targetWorkspaceIds: restorableTargetIds(candidate.snapshot),
            },
        },
    })));
    return {purged: eligible.length, cutoff};
}

export function startPublicationRevisionCleanup() {
    if (process.env.PUBLICATION_REVISION_CLEANUP_DISABLED === "true") return () => {};
    const run = () => purgeExpiredDisabledPublicationRevisions().catch((error) => {
        console.error("publication revision cleanup failed:", error);
    });
    const initialTimer = setTimeout(run, 30 * 1000);
    initialTimer.unref?.();
    const interval = setInterval(run, 24 * 60 * 60 * 1000);
    interval.unref?.();
    return () => {
        clearTimeout(initialTimer);
        clearInterval(interval);
    };
}

export {DEFAULT_RETENTION_MS};
