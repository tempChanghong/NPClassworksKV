import {fail} from '../domain/npep/wire.js';

export const noiseScheduleRepository = {
  async catalog(tx, schoolId, termId, config) {
    const terms = await tx.academicTerm.findMany({where: {schoolId, status: 'ACTIVE'},
      select: {id: true, name: true}, orderBy: [{academicYear: 'desc'}, {semester: 'desc'}]});
    termId ??= terms[0]?.id;
    if (!termId) return {terms, termId: null, grades: [], classes: []};
    await tx.$queryRaw`SELECT id FROM "AcademicTerm" WHERE id=${termId} FOR SHARE`;
    const term = await tx.academicTerm.findUnique({where: {id: termId}});
    if (term?.schoolId !== schoolId) fail(404, 'NOT_FOUND');
    if (term.status !== 'ACTIVE') fail(409, 'TERM_NOT_ACTIVE');
    await tx.$queryRaw`SELECT id FROM "Grade" WHERE "termId"=${termId} FOR SHARE`;
    const grades = await tx.grade.findMany({where: {termId}, select: {id: true, name: true}, orderBy: {sortOrder: 'asc'}});
    // Lock only this school's active administrative classes; policy reads must not race a grade move.
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE "termId"=${termId} AND type='ADMIN_CLASS' AND "isActive"=true FOR SHARE`;
    const classes = await tx.workspace.findMany({where: {termId, type: 'ADMIN_CLASS', isActive: true},
      select: {id: true, name: true, gradeId: true}, orderBy: {name: 'asc'}, take: 1001});
    if (classes.length > 1000 || grades.length > 1000) fail(409, 'SCOPE_TOO_LARGE');
    const ids = classes.map(c => c.id);
    const bindings = await tx.classroomScreenBinding.findMany({where: {schoolId, isActive: true, administrativeClassId: {in: ids}},
      select: {id: true, administrativeClassId: true, npepBindingRevision: true}});
    const devices = await tx.npepDevice.findMany({where: {schoolId, state: 'ACTIVE', serverInstanceId: config.serverInstanceId,
      deploymentEpoch: config.deploymentEpoch, credentialExpiresAt: {gt: new Date()}, administrativeClassId: {in: ids}},
      select: {screenBindingId: true, administrativeClassId: true, bindingRevision: true}});
    const counts = new Map();
    for (const d of devices) if (bindings.some(b => b.id === d.screenBindingId && b.administrativeClassId === d.administrativeClassId && b.npepBindingRevision === d.bindingRevision))
      counts.set(d.administrativeClassId, (counts.get(d.administrativeClassId) || 0) + 1);
    return {terms, termId, grades, classes: classes.map(c => ({...c, pairedDevices: counts.get(c.id) || 0}))};
  },
  async policies(tx, schoolId, termId) {
    return tx.$queryRaw`SELECT "targetType", "targetId", revision, policy, "updatedAt" FROM "NpepNoiseSchedulePolicy" WHERE "schoolId"=${schoolId} AND "termId"=${termId}`;
  },
  async request(tx, schoolId, requestId) {
    const rows = await tx.$queryRaw`SELECT "actorId", digest, result FROM "NpepNoiseScheduleRequest" WHERE "schoolId"=${schoolId} AND "requestId"=${requestId}::uuid`;
    return rows[0] ?? null;
  },
  async save(tx, schoolId, actorId, body, result, digest) {
    await tx.$executeRaw`INSERT INTO "NpepNoiseSchedulePolicy" ("schoolId","termId","targetType","targetId",revision,policy,"updatedBy","updatedAt")
      VALUES (${schoolId},${body.termId},${body.targetType},${body.targetId},${result.revision},${JSON.stringify(body.policy)}::jsonb,${actorId},${new Date(result.updatedAt)})
      ON CONFLICT ("schoolId","termId","targetType","targetId") DO UPDATE SET revision=EXCLUDED.revision,policy=EXCLUDED.policy,"updatedBy"=EXCLUDED."updatedBy","updatedAt"=EXCLUDED."updatedAt"`;
    await tx.$executeRaw`INSERT INTO "NpepNoiseScheduleRequest" ("schoolId","requestId","actorId",digest,result)
      VALUES (${schoolId},${body.requestId}::uuid,${actorId},${digest},${JSON.stringify(result)}::jsonb)`;
  },
};
