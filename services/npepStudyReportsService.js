import {randomUUID} from 'node:crypto';
import {fail, OPAQUE_ID} from '../domain/npep/wire.js';
import {validStudyDate} from '../domain/npep/studySettings.js';

// Ownership is written on report acceptance; never infer an old class from today's binding.
export const studyReportsRepository = {
  async groups(tx, school, term, classroom, mode, date, before, selected = null) {
    return tx.$queryRaw`WITH reports AS (
      SELECT "deviceId", r AS report,
        "deviceId"::text||':'||(r->'study'->>'mode')||':'||(r->'study'->>'policyVersion')||':'||
        (r->'study'->'window'->>'start')||':'||(r->'study'->'window'->>'end') AS key,
        r->'study'->'window'->>'start' AS start
      FROM "NpepNoiseDevice", LATERAL jsonb_array_elements(COALESCE(data->'reports','[]'::jsonb)) r
      WHERE r->'ownership'->>'schoolId'=${school} AND r->'ownership'->>'termId'=${term}
        AND r->'ownership'->>'classId'=${classroom}
        AND (r->>'receivedAt')::timestamptz>clock_timestamp()-interval '30 days'
        AND (${mode}::text IS NULL OR r->'study'->>'mode'=${mode})
        AND (${date}::text IS NULL OR left(r->'study'->'window'->>'start',10)=${date})
    ) SELECT key,start,"deviceId",jsonb_agg(report ORDER BY report->>'startedAt',report->>'sessionId') AS fragments
      FROM reports WHERE (${selected}::text IS NULL OR key=${selected})
        AND (start,key)<(${before.start},${before.key})
      GROUP BY key,start,"deviceId" ORDER BY start DESC,key DESC LIMIT 21`;
  },
  async evidence(tx, school, term, classroom, sessions) {
    const ids = JSON.stringify(sessions);
    const photos = await tx.$queryRaw`SELECT "eventId","capturedAt","expiresAt",state,metadata FROM "NpepStudyPhoto"
      WHERE "schoolId"=${school} AND "termId"=${term} AND "classId"=${classroom} AND "expiresAt">clock_timestamp()
      AND metadata->>'sessionId' IN (SELECT jsonb_array_elements_text(${ids}::jsonb))
      ORDER BY "capturedAt","eventId" LIMIT 301`;
    const events = await tx.$queryRaw`SELECT e."eventId",e.metadata,e."createdAt",
      CASE WHEN p.state='Stored' AND p."expiresAt">clock_timestamp() THEN 'Stored' ELSE 'Unavailable' END AS "photoState"
      FROM "NpepStudyExitEvent" e LEFT JOIN "NpepStudyPhoto" p ON p."eventId"=e."eventId" AND p."schoolId"=e."schoolId" AND p."classId"=e."classId"
      WHERE e."schoolId"=${school} AND e."termId"=${term} AND e."classId"=${classroom} AND e."expiresAt">clock_timestamp()
      AND e.metadata->>'sessionId' IN (SELECT jsonb_array_elements_text(${ids}::jsonb))
      ORDER BY e."createdAt",e."eventId" LIMIT 301`;
    return {photos:photos.slice(0,300).map(p=>({eventId:p.eventId,capturedAt:new Date(p.capturedAt).toISOString(),
      expiresAt:new Date(p.expiresAt).toISOString(),state:p.state,reason:p.metadata.reason})),
    events:events.slice(0,300).map(e=>({eventId:e.eventId,createdAt:new Date(e.createdAt).toISOString(),reason:e.metadata.reason,
      photoEventId:e.metadata.photoEventId,photoState:e.photoState})),truncated:photos.length>300 || events.length>300};
  },
};
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function decode(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) fail(400,'INVALID_REQUEST');
  try { return JSON.parse(Buffer.from(value,'base64url').toString()); } catch { fail(400,'INVALID_REQUEST'); }
}
export function createNpepStudyReportsService(base, repo = studyReportsRepository) {
  return {list:(claims,school,q)=>base.withScheduleAdmin(claims,school,async tx=>{
    if (Object.keys(q).some(k=>!['termId','classId','mode','date','cursor','groupId'].includes(k)) ||
        typeof q.termId!=='string' || typeof q.classId!=='string' || !OPAQUE_ID.test(q.termId) || !OPAQUE_ID.test(q.classId) ||
        q.mode !== undefined && !['Daily','Exam'].includes(q.mode) || q.date !== undefined && !validStudyDate(q.date) ||
        q.cursor && q.groupId) fail(400,'INVALID_REQUEST');
    const c=await tx.workspace.findUnique({where:{id:q.classId}}),t=await tx.academicTerm.findUnique({where:{id:q.termId}});
    if (c?.termId!==q.termId || t?.schoolId!==school) fail(404,'NOT_FOUND');
    const before=q.cursor?decode(q.cursor):{start:'9999',key:'~'};
    if (typeof before?.start!=='string' || !validStudyDate(before.start.slice(0,10)) && before.start!=='9999' ||
        typeof before?.key!=='string' || before.key.length>512) fail(400,'INVALID_REQUEST');
    const selected=q.groupId?decode(q.groupId):null;
    if (q.groupId !== undefined && (typeof selected!=='string' || selected.length>512)) fail(400,'INVALID_REQUEST');
    const rows=await repo.groups(tx,school,q.termId,q.classId,q.mode??null,q.date??null,before,selected);
    const items=rows.slice(0,20).map(r=>({groupId:encode(r.key),deviceId:r.deviceId,mode:r.fragments[0].study.mode,
      clockSource:r.fragments[0].study.clockSource,window:r.fragments[0].study.window,fragmentCount:r.fragments.length,
      ...(selected?{fragments:r.fragments}:{} )}));
    if (selected && !items.length) fail(404,'NOT_FOUND');
    if (selected) Object.assign(items[0],await repo.evidence(tx,school,q.termId,q.classId,items[0].fragments.map(r=>r.sessionId)));
    await tx.npepAudit.create({data:{id:randomUUID(),schoolId:school,actorId:claims.accountId,
      action:selected?'STUDY_SESSION_VIEW':'STUDY_SESSION_LIST',objectId:q.classId}});
    return {items,cursor:rows.length>20?encode({start:rows[19].start,key:rows[19].key}):null,
      retentionDays:30,legacyNotice:'旧报告没有可靠的会话归属，不自动归入本页；仍可在设备历史报告查看。'};
  })};
}
