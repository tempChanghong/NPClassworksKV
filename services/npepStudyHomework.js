import {Prisma} from '../generated/prisma/client.ts';
import {hash, fail} from '../domain/npep/wire.js';
import {studySettingsRepository} from './npepStudySettingsRepository.js';
import {validateStudyDevice} from '../domain/npep/studyDevice.js';

// Read-only snapshots. Chunks are transport boundaries, never homework display pages.
export const HOMEWORK_CHUNK_BYTES = 16384;
export const HOMEWORK_MAX_BYTES = 2 * 1024 * 1024;
const dateFormat = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
export function studyHomeworkDate(now = new Date()) {
  const parts = Object.fromEntries(dateFormat.formatToParts(now).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export async function readStudyHomework(tx, current, date, repository = studySettingsRepository) {
  const homework = current.effective.settings?.homework;
  let items = [];
  if (homework?.enabled) {
    const ids = homework.sourceMode === 'SelectedClasses' ? homework.sourceClassIds : [current.scope.classId];
    const sources = await repository.homeworkSources(tx, current.scope.schoolId, current.scope.termId, ids);
    const sourceById = new Map(sources.map(source => [source.id, source]));
    const where = {type: 'ASSIGNMENT', status: 'PUBLISHED', publishAt: {lte: new Date()},
      boardDate: new Date(`${date}T00:00:00Z`), targets: {some: {workspaceId: {in: [...sourceById.keys()]}}}};
    const query = {where, orderBy: {id: 'asc'}, take: 501,
      select: {id: true, revision: true, title: true, content: true, subject: {select: {name: true}},
        targets: {select: {workspaceId: true}}}};
    let rows = await tx.publication.findMany(query);
    if (rows.length > 500) fail(503, 'HOMEWORK_LIMIT_EXCEEDED');
    if (rows.length) {
      const ids = rows.map(row => row.id);
      await tx.$queryRaw`SELECT id FROM "Publication" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE`;
      rows = await tx.publication.findMany({...query, where: {...where, id: {in: ids}}});
    }
    // A publication targeting several selected spaces appears once, with every matching source.
    items = rows.filter(row => row.title?.trim() || row.content?.trim()).map(row => ({
      id: row.id, revision: row.revision, subject: row.subject?.name || '未命名科目',
      title: row.title || '', content: row.content || '',
      sources: [...new Set(row.targets.map(target => target.workspaceId))].filter(id => sourceById.has(id))
        .sort().map(id => ({id, name: sourceById.get(id).name})),
    }));
  }
  const payload = {version: current.version, date, items};
  if (!validateStudyDevice('homeworkSnapshot', payload)) fail(503, 'INVALID_HOMEWORK_CONTENT');
  const bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.length > HOMEWORK_MAX_BYTES) fail(503, 'HOMEWORK_LIMIT_EXCEEDED');
  return {snapshotId: hash(bytes), bytes};
}

export function homeworkChunk(snapshot, index, expected = null) {
  if (expected !== null && expected !== snapshot.snapshotId) fail(409, 'HOMEWORK_CHANGED');
  const count = Math.max(1, Math.ceil(snapshot.bytes.length / HOMEWORK_CHUNK_BYTES));
  if (index >= count) fail(400, 'INVALID_REQUEST');
  return {snapshotId: snapshot.snapshotId, index, count,
    data: snapshot.bytes.subarray(index * HOMEWORK_CHUNK_BYTES, (index + 1) * HOMEWORK_CHUNK_BYTES).toString('base64')};
}
