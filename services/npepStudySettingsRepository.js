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
