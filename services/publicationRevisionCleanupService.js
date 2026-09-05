import {prisma} from "../utils/prisma.js";
import {Prisma} from "../generated/prisma/client.ts";

const DEFAULT_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

function restorableTargetIds(snapshot) {
    const ids = snapshot?.targetWorkspaceIds;
    // Unknown/malformed targets cannot establish that every target is disabled.
    return Array.isArray(ids) && ids.every(id => typeof id === "string" && id.length > 0)
        ? [...new Set(ids)] : [];
}

function isHistoricalAssignment(candidate, currentRevision) {
    return candidate.revision !== currentRevision
        && candidate.snapshot?.type === "ASSIGNMENT" && Boolean(candidate.snapshot?.subjectId);
}

async function purgeCandidate(candidate, {now, cutoff}) {
    return prisma.$transaction(async tx => {
        // Match publication writers' lock order. Keep current/certified status stable,
        // then hold every target row until the history body has been removed.
        const [publication] = await tx.$queryRaw`SELECT "revision" FROM "Publication"
            WHERE "id" = ${candidate.publicationId} FOR SHARE`;
        if (!publication) return 0;
        const [current] = await tx.$queryRaw`SELECT "id", "revision", "snapshot", "isCertified", "purgedAt", "createdAt"
            FROM "PublicationRevision" WHERE "id" = ${candidate.id}
            AND "publicationId" = ${candidate.publicationId} FOR UPDATE`;
        if (!current || current.isCertified || current.purgedAt || current.createdAt >= cutoff
            || !isHistoricalAssignment(current, publication.revision)) return 0;
        const ids = restorableTargetIds(current.snapshot);
        if (!ids.length) return 0;
        const targets = await tx.$queryRaw(Prisma.sql`SELECT "id", "isActive" FROM "Workspace"
            WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR SHARE`);
        if (targets.length !== ids.length || targets.some(target => target.isActive)) return 0;
        await tx.publicationRevision.update({
            where: {id: current.id},
            data: {
                purgedAt: now,
                snapshot: {
                    purged: true,
                    type: current.snapshot.type,
                    subjectId: current.snapshot.subjectId,
                    status: current.snapshot.status,
                    targetWorkspaceIds: ids,
                },
            },
        });
        return 1;
    });
}

/**
 * Scan all expired candidates in bounded pages. Only erase non-current, uncertified
 * assignment bodies whose known targets are all disabled; retain audit shells.
 * `limit` is the page size, not a cap on how far this run advances.
 */
export async function purgeExpiredDisabledPublicationRevisions({
    now = new Date(),
    retentionMs = DEFAULT_RETENTION_MS,
    limit = 200,
} = {}) {
    const safeRetentionMs = Math.max(Number(retentionMs) || DEFAULT_RETENTION_MS, 60 * 1000);
    const cutoff = new Date(now.getTime() - safeRetentionMs);
    const pageSize = Math.min(Math.max(Math.floor(Number(limit) || 200), 1), 1000);
    let cursor;
    let purged = 0;
    while (true) {
        const candidates = await prisma.publicationRevision.findMany({
            where: {isCertified: false, purgedAt: null, createdAt: {lt: cutoff},
                ...(cursor ? {NOT: {id: cursor}} : {})},
            orderBy: [{createdAt: "asc"}, {id: "asc"}],
            take: pageSize,
            ...(cursor ? {cursor: {id: cursor}} : {}),
            include: {publication: {select: {revision: true}}},
        });
        if (!candidates.length) break;
        // Advance past the scanned rows even when none can be purged. The cursor
        // row survives as an audit shell; Prisma uses its database timestamp.
        // Exclude its ID instead of skip: 1: a purged cursor no longer matches
        // the filter, so an offset would skip the next unprocessed revision.
        cursor = candidates.at(-1).id;
        const targetIds = [...new Set(candidates.flatMap(candidate => restorableTargetIds(candidate.snapshot)))];
        const disabledTargets = targetIds.length ? await prisma.workspace.findMany({
            where: {id: {in: targetIds}, isActive: false}, select: {id: true},
        }) : [];
        const disabledIds = new Set(disabledTargets.map(target => target.id));
        for (const candidate of candidates) {
            if (!isHistoricalAssignment(candidate, candidate.publication.revision)) continue;
            const ids = restorableTargetIds(candidate.snapshot);
            if (!ids.length || !ids.every(id => disabledIds.has(id))) continue;
            // The page-level filter saves work; it is never the final deletion check.
            purged += await purgeCandidate(candidate, {now, cutoff});
        }
        if (candidates.length < pageSize) break;
    }
    return {purged, cutoff};
}

export function startPublicationRevisionCleanup() {
    if (process.env.PUBLICATION_REVISION_CLEANUP_DISABLED === "true") return () => {};
    let running = false;
    const run = async () => {
        if (running) return;
        running = true;
        try { await purgeExpiredDisabledPublicationRevisions(); }
        catch (error) { console.error("publication revision cleanup failed:", error); }
        finally { running = false; }
    };
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
