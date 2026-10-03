import {fail, digest, displayText} from '../domain/npep/wire.js';

// Bulk operations affect an explicit preview of existing screens, not future screens.
export function createPairingBatch({transaction, schoolLock, administrator, audit}) {
  async function prepare(tx, config, schoolId, body) {
    await tx.$queryRaw`SELECT id FROM "AcademicTerm" WHERE id = ${body.termId} FOR SHARE`;
    const term = await tx.academicTerm.findUnique({where: {id: body.termId}});
    if (!term || term.schoolId !== schoolId) fail(404, 'NOT_FOUND');
    if (term.status !== 'ACTIVE') fail(409, 'BINDING_CHANGED');
    let grade = null;
    if (body.targetType === 'GRADE') {
      await tx.$queryRaw`SELECT id FROM "Grade" WHERE id = ${body.targetId} FOR SHARE`;
      grade = await tx.grade.findUnique({where: {id: body.targetId}});
      if (!grade || grade.termId !== term.id) fail(404, 'NOT_FOUND');
    }
    // Same lock order as single pairing: school -> term -> workspace -> screen.
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE "termId" = ${term.id} ORDER BY id FOR SHARE`;
    await tx.$queryRaw`SELECT b.id FROM "ClassroomScreenBinding" b JOIN "Workspace" w ON w.id = b."administrativeClassId"
      WHERE b."schoolId" = ${schoolId} AND w."termId" = ${term.id} ORDER BY b.id FOR UPDATE OF b`;
    const screens = await tx.classroomScreenBinding.findMany({
      where: {schoolId, administrativeClass: {termId: term.id, ...(grade ? {gradeId: grade.id} : {})}},
      include: {administrativeClass: true}, orderBy: {id: 'asc'},
    });
    const eligible = screens.filter(b => b.isActive && b.administrativeClass.isActive && b.administrativeClass.type === 'ADMIN_CLASS');
    const items = eligible.map(b => ({screenBindingId: b.id, name: displayText(b.name),
      administrativeClassId: b.administrativeClassId, administrativeClassName: displayText(b.administrativeClass.name),
      enabled: b.npepPairingEnabled, revision: b.npepPairingRevision, changed: b.npepPairingEnabled !== body.enabled}));
    const previewDigest = digest({schoolId, ...config, termId: term.id, termName: term.name,
      targetType: body.targetType, targetId: body.targetId, targetName: grade?.name ?? '全校', enabled: body.enabled,
      // Include excluded screens too: a newly enabled class must not quietly join an old preview.
      screens: screens.map(b => ({id: b.id, classId: b.administrativeClassId, name: b.name, className: b.administrativeClass.name,
        active: b.isActive, classActive: b.administrativeClass.isActive, classType: b.administrativeClass.type,
        gradeId: b.administrativeClass.gradeId, revision: b.npepPairingRevision, enabled: b.npepPairingEnabled,
        bindingRevision: b.npepBindingRevision, credentialVersion: b.credentialVersion}))});
    const data = {termId: term.id, termName: displayText(term.name), targetType: body.targetType, targetId: body.targetId,
      targetName: grade ? displayText(grade.name) : '全校', enabled: body.enabled, previewDigest,
      totalScreens: items.length, changedScreens: items.filter(i => i.changed).length,
      unchangedScreens: items.filter(i => !i.changed).length, excludedScreens: screens.length - items.length,
      items: items.slice(0, 50), truncated: items.length > 50};
    return {data, changed: eligible.filter(b => b.npepPairingEnabled !== body.enabled)};
  }
  async function execute(claims, schoolId, body, save) {
    return transaction(async (tx, config) => {
      await schoolLock(tx, schoolId); await administrator(tx, claims, schoolId);
      const {data, changed} = await prepare(tx, config, schoolId, body);
      if (!save) return data;
      if (data.previewDigest !== body.previewDigest) fail(409, 'PREAUTHORIZATION_CHANGED');
      if (changed.some(b => b.npepPairingRevision >= Number.MAX_SAFE_INTEGER)) fail(409, 'REVISION_CONFLICT');
      const ids = changed.map(b => b.id);
      if (ids.length) {
        await tx.classroomScreenBinding.updateMany({where: {id: {in: ids}}, data: {npepPairingEnabled: body.enabled, npepPairingRevision: {increment: 1}}});
        await tx.npepScreenPairingTicket.updateMany({where: {screenBindingId: {in: ids}, state: 'READY'}, data: {state: 'CANCELLED'}});
      }
      await audit(tx, body.enabled ? 'SCREEN_PAIRING_BATCH_ENABLED' : 'SCREEN_PAIRING_BATCH_DISABLED', body.requestId, schoolId, claims.accountId);
      return {...data, applied: true, updatedAt: new Date().toISOString()};
    });
  }
  return {
    previewPairingAccessBatch: (claims, schoolId, body) => execute(claims, schoolId, body, false),
    setPairingAccessBatch: (claims, schoolId, body) => execute(claims, schoolId, body, true),
  };
}
