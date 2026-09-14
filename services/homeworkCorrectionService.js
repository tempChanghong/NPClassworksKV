import {prisma} from "../utils/prisma.js";
import {loadPublicationWorkspaces} from "./publicationAuthorizationService.js";
import {publicHomeworkCorrection} from "../domain/homeworkCorrections.js";
import {parseBoardDate} from "../domain/publication.js";

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), {statusCode, code: "HOMEWORK_CORRECTIONS_UNAVAILABLE"}); };

export async function listHomeworkCorrections({publicationId, workspaceIds, date, beforeRevision, now = new Date()}) {
    const ids = [...new Set(workspaceIds || [])];
    if (!ids.length || ids.length > 20) fail("请选择1—20个教学空间");
    const workspaces = await loadPublicationWorkspaces(ids);
    if (workspaces.length !== ids.length || workspaces.some(w => w.term.status !== "ACTIVE") || new Set(workspaces.map(w => w.termId)).size !== 1) fail("教学空间已变化，请重新选择", 403);
    const errors = [];
    const parsedDate = typeof date === "string" ? parseBoardDate(date, errors, {required: true}) : null;
    if (!parsedDate || errors.length) fail("请选择有效的更正日期");
    const before = beforeRevision === undefined ? undefined : Number(beforeRevision);
    if (before !== undefined && (!/^[1-9]\d*$/.test(String(beforeRevision)) || !Number.isSafeInteger(before) || before > 2147483647)) fail("历史分页参数无效");
    const publication = await prisma.publication.findFirst({where: {id: publicationId, type: "ASSIGNMENT", status: "PUBLISHED", publishAt: {lte: now}, targets: {some: {workspaceId: {in: ids}}}}, select: {id: true, revision: true, targets: {select: {workspaceId: true}}}});
    if (!publication) fail("作业不存在或已不可见", 404);
    const allowed = ids.filter(id => publication.targets.some(t => t.workspaceId === id));
    const start = new Date(`${parsedDate.toISOString().slice(0, 10)}T00:00:00+08:00`), end = new Date(start.getTime() + 86400000);
    const rows = await prisma.publicationRevision.findMany({where: {publicationId, createdAt: {gte: start, lt: end}, revision: {gt: 1, lte: publication.revision, ...(before ? {lt: before} : {})}}, orderBy: {revision: "desc"}, take: 21,
        select: {revision: true, createdAt: true, snapshot: true, purgedAt: true}});
    const page = rows.slice(0, 20);
    const predecessors = page.length ? await prisma.publicationRevision.findMany({where: {publicationId, revision: {in: page.map(row => row.revision - 1)}}, select: {revision: true, createdAt: true, snapshot: true, purgedAt: true}}) : [];
    const byRevision = new Map(predecessors.map(row => [row.revision, row]));
    return {items: page.map(row => publicHomeworkCorrection(byRevision.get(row.revision - 1), row, allowed)).filter(Boolean), nextBeforeRevision: rows.length > 20 ? page.at(-1).revision : null};
}
