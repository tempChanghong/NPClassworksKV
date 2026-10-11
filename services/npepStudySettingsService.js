import {randomUUID} from 'node:crypto';
import {digest, fail} from '../domain/npep/wire.js';
import {STUDY_LIMITS, normalizeStudyPolicy, validateStudyWrite, resolveStudyPolicy, studyWindowsForDate} from '../domain/npep/studySettings.js';
import {studySettingsRepository} from './npepStudySettingsRepository.js';

const integration = Object.freeze({executionState: 'NOT_VERIFIED', nativeDisplay: 'PENDING_INTEGRATION',
  thresholdPhotos: 'REQUIRES_UPDATED_HOST', cameraSelection: 'ExplicitOnDevice', backupRetention: 'UNKNOWN'});
const entry = (rows, type, id) => rows.find(row => row.targetType === type && row.targetId === id);

export function createNpepStudySettingsService(base, repo = studySettingsRepository) {
  const admin = (claims, schoolId, operation) => base.withScheduleAdmin(claims, schoolId, operation);
  async function prepare(tx, config, schoolId, body) {
    const catalog = await repo.catalog(tx, schoolId, body.termId, config);
    const targets = body.targetType === 'GRADE' ? catalog.grades : catalog.classes;
    if (!targets.some(target => target.id === body.targetId)) fail(404, 'NOT_FOUND');
    const rows = await repo.settings(tx, schoolId, body.termId);
    if ((entry(rows, body.targetType, body.targetId)?.revision ?? 0) !== body.expectedRevision) fail(409, 'STUDY_SETTING_VERSION_CONFLICT');
    const existingNoise = entry(rows, body.targetType, body.targetId)?.policy.settings?.noise;
    const incomingNoise = body.policy.settings?.noise;
    if (incomingNoise && !Object.hasOwn(incomingNoise, 'highContinuousSeconds') && existingNoise
      && (existingNoise.mediumLineDbfs != null || existingNoise.disciplineCooldownSeconds != null && existingNoise.disciplineCooldownSeconds !== 600 || existingNoise.highContinuousSeconds != null && existingNoise.highContinuousSeconds !== body.policy.settings.photos?.continuousSeconds)) {
      fail(409, 'STUDY_SETTING_UPGRADE_REQUIRED');
    }
    if (incomingNoise && existingNoise?.estimated && !Object.hasOwn(incomingNoise, 'estimated')) fail(409, 'STUDY_SETTING_UPGRADE_REQUIRED');
    const h = body.policy.settings?.homework;
    if (h?.sourceMode === 'SelectedClasses' && h.sourceClassIds.some(id => !catalog.classes.some(c => c.id === id))) fail(404, 'STUDY_SOURCE_UNAVAILABLE');
    const selected = catalog.classes.filter(c => body.targetType === 'GRADE' ? c.gradeId === body.targetId : c.id === body.targetId);
    const affected = [];
    let changedClasses = 0, pairedDevices = 0;
    for (const c of selected) {
      const grade = entry(rows, 'GRADE', c.gradeId)?.policy;
      const local = entry(rows, 'CLASS', c.id)?.policy;
      const before = resolveStudyPolicy(grade, local);
      const effective = resolveStudyPolicy(body.targetType === 'GRADE' ? body.policy : grade, body.targetType === 'CLASS' ? body.policy : local);
      const changed = digest(before) !== digest(effective);
      if (changed) { changedClasses++; pairedDevices += c.pairedDevices; }
      const homework = effective.settings?.homework;
      const sourceIds = !homework?.enabled ? [] : homework.sourceMode === 'OwnClass' ? [c.id] : homework.sourceClassIds;
      if (sourceIds.some(id => !catalog.classes.some(known => known.id === id))) fail(409, 'STUDY_SOURCE_UNAVAILABLE');
      affected.push({classId: c.id, name: c.name, pairedDevices: c.pairedDevices, changed, effective, sourceIds});
    }
    const allSourceIds = [...new Set(affected.flatMap(item => item.sourceIds))].sort();
    const sources = allSourceIds.length ? await repo.homeworkSources(tx, schoolId, body.termId, allSourceIds) : [];
    const items = affected.slice(0, 50).map(({sourceIds, ...item}) => ({...item,
      homeworkSources: sources.filter(source => source.sourceClassIds.some(id => sourceIds.includes(id)))
        .map(source => ({...source, sourceClassIds: source.sourceClassIds.filter(id => sourceIds.includes(id))})),
      windows: body.previewDate ? studyWindowsForDate(item.effective.settings, body.previewDate) : []}));
    return {termId: body.termId, targetType: body.targetType, targetId: body.targetId, baseRevision: body.expectedRevision,
      policy: body.policy, totalClasses: selected.length, changedClasses, pairedDevices, items, truncated: selected.length > 50,
      previewFingerprint: digest({targetType: body.targetType, targetId: body.targetId, policy: body.policy,
        sources: sources.map(source => ({...source, sourceClassIds: [...source.sourceClassIds].sort()})).sort((a,b) => a.id.localeCompare(b.id)),
        classes: selected.map(c => ({id: c.id, gradeId: c.gradeId, pairedDevices: c.pairedDevices})).sort((a,b) => a.id.localeCompare(b.id)),
        policies: rows.map(row => ({targetType: row.targetType, targetId: row.targetId, revision: row.revision})).sort((a,b) => (a.targetType+a.targetId).localeCompare(b.targetType+b.targetId))}),
      previewDate: body.previewDate || null, limits: STUDY_LIMITS, integration};
  }
  return {
    list: (claims, schoolId, termId) => admin(claims, schoolId, async (tx, config) => {
      const catalog = await repo.catalog(tx, schoolId, termId, config);
      const settings = catalog.termId ? await repo.settings(tx, schoolId, catalog.termId) : [];
      return {...catalog,
        limits: STUDY_LIMITS, integration, settings: settings.filter(row => (row.targetType === 'GRADE' ? catalog.grades : catalog.classes).some(t => t.id === row.targetId)).map(row => ({...row, policy: normalizeStudyPolicy(row.policy)}))};
    }),
    preview: (claims, schoolId, body) => {
      if (!validateStudyWrite(body, true)) fail(400, 'INVALID_REQUEST');
      return admin(claims, schoolId, (tx, config) => prepare(tx, config, schoolId, body));
    },
    save: (claims, schoolId, body) => {
      if (!validateStudyWrite(body)) fail(400, 'INVALID_REQUEST');
      return admin(claims, schoolId, async (tx, config) => {
        const prior = await repo.request(tx, schoolId, body.requestId), fingerprint = digest(body);
        if (prior) {
          if (prior.actorId !== claims.accountId || prior.digest !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT');
          return prior.result;
        }
        const result = {...await prepare(tx, config, schoolId, body), revision: body.expectedRevision + 1, updatedAt: new Date().toISOString()};
        if (result.previewFingerprint !== body.expectedPreviewFingerprint) fail(409, 'STUDY_PREVIEW_CHANGED');
        await repo.save(tx, schoolId, claims.accountId, body, result, fingerprint);
        await tx.npepAudit.create({data: {id: randomUUID(), schoolId, actorId: claims.accountId, action: 'STUDY_SETTING_SAVED', objectId: body.targetId}});
        return result;
      });
    },
  };
}
