import {noiseScheduleRepository} from './npepNoiseScheduleRepository.js';
import {isClassroomScreenWorkspaceAllowed} from './classroomScreenService.js';
import {fail} from '../domain/npep/wire.js';

export const studySettingsRepository = {
  catalog: noiseScheduleRepository.catalog,
  async settings(tx, schoolId, termId) {
    return tx.$queryRaw`SELECT "targetType", "targetId", revision, policy, "updatedAt" FROM "NpepStudySetting"
      WHERE "schoolId"=${schoolId} AND "termId"=${termId}`;
  },
  async request(tx, schoolId, requestId) {
    const rows = await tx.$queryRaw`SELECT "actorId", digest, result FROM "NpepStudySettingRequest"
      WHERE "schoolId"=${schoolId} AND "requestId"=${requestId}::uuid`;
    return rows[0] ?? null;
  },
  async save(tx, schoolId, actorId, body, result, digest) {
    await tx.$executeRaw`INSERT INTO "NpepStudySetting" ("schoolId","termId","targetType","targetId",revision,policy,"updatedBy","updatedAt")
      VALUES (${schoolId},${body.termId},${body.targetType},${body.targetId},${result.revision},${JSON.stringify(body.policy)}::jsonb,${actorId},${new Date(result.updatedAt)})
      ON CONFLICT ("schoolId","termId","targetType","targetId") DO UPDATE SET revision=EXCLUDED.revision,policy=EXCLUDED.policy,"updatedBy"=EXCLUDED."updatedBy","updatedAt"=EXCLUDED."updatedAt"`;
    await tx.$executeRaw`INSERT INTO "NpepStudySettingRequest" ("schoolId","requestId","actorId",digest,result)
      VALUES (${schoolId},${body.requestId}::uuid,${actorId},${digest},${JSON.stringify(result)}::jsonb)`;
    // Shortening affects existing photographs; extending a policy never extends old expiry.
    // Resolve every class, including inherited grades beyond the 50-row preview.
    await tx.$executeRaw`WITH effective AS (
      SELECT w.id, CASE WHEN c.policy IS NULL OR c.policy->>'mode'='Inherit' THEN g.policy ELSE c.policy END AS policy
      FROM "Workspace" w
      LEFT JOIN "NpepStudySetting" c ON c."schoolId"=${schoolId} AND c."termId"=${body.termId} AND c."targetType"='CLASS' AND c."targetId"=w.id
      LEFT JOIN "NpepStudySetting" g ON g."schoolId"=${schoolId} AND g."termId"=${body.termId} AND g."targetType"='GRADE' AND g."targetId"=w."gradeId"
      WHERE w."termId"=${body.termId} AND w.type='ADMIN_CLASS'
    ) UPDATE "NpepStudyPhoto" p SET "expiresAt"=LEAST(p."expiresAt",p."capturedAt"+make_interval(days=>(e.policy->'settings'->'photos'->>'retentionDays')::integer))
      FROM effective e WHERE p."schoolId"=${schoolId} AND p."termId"=${body.termId} AND p."classId"=e.id
      AND p.state IN ('Stored','Uploading') AND (e.policy->'settings'->'photos'->>'retentionDays')::integer BETWEEN 1 AND 180`;
    // Exit records use trusted server receipt time, with the same retention ceiling.
    await tx.$executeRaw`WITH effective AS (
      SELECT w.id, CASE WHEN c.policy IS NULL OR c.policy->>'mode'='Inherit' THEN g.policy ELSE c.policy END AS policy
      FROM "Workspace" w
      LEFT JOIN "NpepStudySetting" c ON c."schoolId"=${schoolId} AND c."termId"=${body.termId} AND c."targetType"='CLASS' AND c."targetId"=w.id
      LEFT JOIN "NpepStudySetting" g ON g."schoolId"=${schoolId} AND g."termId"=${body.termId} AND g."targetType"='GRADE' AND g."targetId"=w."gradeId"
      WHERE w."termId"=${body.termId} AND w.type='ADMIN_CLASS'
    ) UPDATE "NpepStudyExitEvent" r SET "expiresAt"=LEAST(r."expiresAt",r."createdAt"+make_interval(days=>(e.policy->'settings'->'photos'->>'retentionDays')::integer))
      FROM effective e WHERE r."schoolId"=${schoolId} AND r."termId"=${body.termId} AND r."classId"=e.id
      AND (e.policy->'settings'->'photos'->>'retentionDays')::integer BETWEEN 1 AND 180`;
  },
  async homeworkSources(tx, schoolId, termId, ids) {
    const classes = await tx.workspace.findMany({where: {id: {in: ids}, termId, type: 'ADMIN_CLASS', isActive: true,
      term: {schoolId, status: 'ACTIVE'}}, include: {subjectRules: true}});
    if (classes.length !== ids.length) fail(409, 'STUDY_SOURCE_UNAVAILABLE');
    const walkingSubjects = [...new Set(classes.flatMap(c => c.subjectRules.filter(rule => rule.deliveryMode === 'COURSE_GROUP').map(rule => rule.subjectId)))];
    const courses = walkingSubjects.length ? await tx.workspace.findMany({where: {termId, type: 'COURSE_GROUP', isActive: true,
      gradeId: {in: [...new Set(classes.map(c => c.gradeId).filter(Boolean))]}, subjectId: {in: walkingSubjects},
      sourceClasses: {some: {administrativeClassId: {in: ids}}}},
      include: {sourceClasses: true, subject: {select: {name: true}}}, orderBy: {name: 'asc'}}) : [];
    const groups = new Map();
    for (const c of classes) {
      const sources = [c, ...courses.filter(course => isClassroomScreenWorkspaceAllowed({administrativeClass: c}, course))];
      for (const workspace of sources) {
        const found = groups.get(workspace.id) || {id: workspace.id, name: workspace.name, type: workspace.type,
          subjectName: workspace.subject?.name || null, sourceClassIds: []};
        found.sourceClassIds.push(c.id);
        groups.set(workspace.id, found);
      }
    }
    return [...groups.values()];
  },
};
