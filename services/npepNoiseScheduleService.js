import {randomUUID} from 'node:crypto';
import {fail, digest} from '../domain/npep/wire.js';
import {validateScheduleWrite} from '../domain/npep/noiseSchedules.js';
import {resolvePolicy} from '../domain/npep/noiseScheduleRules.js';
import {noiseScheduleRepository} from './npepNoiseScheduleRepository.js';

export function createNpepNoiseScheduleService(service, repo = noiseScheduleRepository) {
  const admin = (claims, schoolId, operation) => service.withScheduleAdmin(claims, schoolId, operation);
  const entry = (policies, type, id) => policies.find(p => p.targetType === type && p.targetId === id);
  async function prepare(tx, config, schoolId, body) {
    const catalog = await repo.catalog(tx, schoolId, body.termId, config);
    const targets = body.targetType === 'GRADE' ? catalog.grades : catalog.classes;
    if (!targets.some(t => t.id === body.targetId)) fail(404, 'NOT_FOUND');
    const policies = await repo.policies(tx, schoolId, body.termId);
    const current = entry(policies, body.targetType, body.targetId);
    if ((current?.revision ?? 0) !== body.expectedRevision) fail(409, 'SCHEDULE_VERSION_CONFLICT');
    const selected = catalog.classes.filter(c => body.targetType === 'GRADE' ? c.gradeId === body.targetId : c.id === body.targetId);
    const affected = selected.map(c => {
      const g = body.targetType === 'GRADE' ? body.policy : entry(policies, 'GRADE', c.gradeId)?.policy ?? null;
      const local = body.targetType === 'CLASS' ? body.policy : entry(policies, 'CLASS', c.id)?.policy ?? null;
      const effective = resolvePolicy(g, local);
      const before = resolvePolicy(entry(policies, 'GRADE', c.gradeId)?.policy ?? null, entry(policies, 'CLASS', c.id)?.policy ?? null);
      return {classId: c.id, name: c.name, pairedDevices: c.pairedDevices, effective, changed: digest(before) !== digest(effective)};
    });
    return {targetType: body.targetType, targetId: body.targetId, termId: body.termId, baseRevision: body.expectedRevision,
      policy: body.policy, totalClasses: affected.length, changedClasses: affected.filter(c => c.changed).length,
      pairedDevices: affected.filter(c => c.changed).reduce((n, c) => n + c.pairedDevices, 0),
      items: affected.slice(0, 50), truncated: affected.length > 50, executionEnabled: true};
  }
  return {
    list: (claims, schoolId, termId) => admin(claims, schoolId, async (tx, config) => {
      const catalog = await repo.catalog(tx, schoolId, termId, config);
      const policies = catalog.termId ? await repo.policies(tx, schoolId, catalog.termId) : [];
      return {...catalog, policies: policies.filter(p => (p.targetType === 'GRADE' ? catalog.grades : catalog.classes).some(t => t.id === p.targetId)), executionEnabled: true};
    }),
    preview: (claims, schoolId, body) => {
      if (!validateScheduleWrite(body)) fail(400, 'INVALID_REQUEST');
      return admin(claims, schoolId, (tx, config) => prepare(tx, config, schoolId, body));
    },
    save: (claims, schoolId, body) => {
      if (!validateScheduleWrite(body)) fail(400, 'INVALID_REQUEST');
      return admin(claims, schoolId, async (tx, config) => {
        const previous = await repo.request(tx, schoolId, body.requestId);
        const fingerprint = digest(body);
        if (previous) {
          if (previous.actorId !== claims.accountId || previous.digest !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT');
          return previous.result;
        }
        const preview = await prepare(tx, config, schoolId, body);
        const result = {...preview, revision: body.expectedRevision + 1, updatedAt: new Date().toISOString()};
        await repo.save(tx, schoolId, claims.accountId, body, result, fingerprint);
        await tx.npepAudit.create({data: {id: randomUUID(), schoolId, actorId: claims.accountId,
          action: 'NOISE_SCHEDULE_SAVED', objectId: body.targetId}});
        return result;
      });
    },
  };
}
