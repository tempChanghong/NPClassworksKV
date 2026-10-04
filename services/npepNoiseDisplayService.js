import {digest, fail} from '../domain/npep/wire.js';
import {resolvedDisplayMinutes} from '../domain/npep/noiseDisplay.js';
import {noiseScheduleRepository} from './npepNoiseScheduleRepository.js';
import {noiseRepository} from './npepNoiseRepository.js';
import {noiseScheduleRuntimeRepository} from './npepNoiseScheduleRuntime.js';

const windowMatches = (a, b) => a?.start === b?.start && a?.end === b?.end;
const recent = (value, now) => !!value && Number.isFinite(Date.parse(value))
  && now - Date.parse(value) >= 0 && now - Date.parse(value) < 15000;
const exposeReturn = (value, now) => value ? {
  window: {start: value.windowStart, end: value.windowEnd},
  startedAt: value.startedAt.toISOString(), expiresAt: value.expiresAt.toISOString(),
  returnMinutes: value.returnMinutes, remainingSeconds: Math.max(0, Math.ceil((value.expiresAt.getTime() - now) / 1000)),
} : null;

export function createNpepNoiseDisplayService(base, repository = noiseScheduleRepository) {
  async function context(tx, d) {
    const binding = await tx.classroomScreenBinding.findUnique({where: {id: d.screenBindingId}});
    if (!binding?.isActive || binding.schoolId !== d.schoolId || binding.npepBindingRevision !== d.bindingRevision)
      fail(409, 'BINDING_CHANGED');
    const classroom = await tx.workspace.findUnique({where: {id: binding.administrativeClassId}});
    const term = classroom?.termId && await tx.academicTerm.findUnique({where: {id: classroom.termId}});
    if (!classroom?.isActive || classroom.type !== 'ADMIN_CLASS' || term?.schoolId !== d.schoolId || term.status !== 'ACTIVE')
      fail(409, 'BINDING_CHANGED');
    const settings = await tx.npepNoiseDisplaySetting.findMany({where: {schoolId: d.schoolId, termId: classroom.termId}});
    return {binding, classroom, ...resolvedDisplayMinutes(settings, classroom.gradeId, classroom.id)};
  }
  async function activeWindow(tx, d, requestedWindow, now) {
    const schedule = await noiseScheduleRuntimeRepository.read(tx, d.id);
    const noise = await noiseRepository.read(tx, d.id);
    const s = schedule.status, n = noise.status;
    if (!recent(schedule.receivedAt, now) || !recent(noise.receivedAt, now)
      || schedule.context?.sessionId !== d.sessionId || noise.context?.sessionId !== d.sessionId
      || schedule.context?.statusEpoch !== d.statusEpoch || noise.context?.statusEpoch !== d.statusEpoch
      || s?.owner !== 'Schedule' || s.reason !== 'WINDOW_ACTIVE' || s.clockReady !== true
      || s.dateNeedsReview !== false || !s.sessionId || s.sessionId !== n?.sessionId || n.state !== 'Active'
      || !windowMatches(s.window, requestedWindow)) fail(409, 'DISPLAY_SESSION_CHANGED');
    return s.window;
  }
  async function view(tx, d) {
    if (!d) return {supported: false, serverNow: new Date().toISOString(), returnMinutes: 10,
      source: 'Default', activeReturn: null};
    const now = Date.now(), settings = await context(tx, d);
    const schedule = await noiseScheduleRuntimeRepository.read(tx, d.id);
    const noise = await noiseRepository.read(tx, d.id);
    const status = schedule.status;
    const active = recent(schedule.receivedAt, now) && recent(noise.receivedAt, now)
      && schedule.context?.sessionId === d.sessionId && noise.context?.sessionId === d.sessionId
      && status?.owner === 'Schedule' && status.reason === 'WINDOW_ACTIVE'
      && status.clockReady && !status.dateNeedsReview && status.sessionId
      && status.sessionId === noise.status?.sessionId && noise.status?.state === 'Active';
    const window = active ? status.window : null;
    const row = window && await tx.npepNoiseDisplayReturn.findUnique({where: {
      screenBindingId_windowStart_windowEnd: {screenBindingId: settings.binding.id, windowStart: window.start, windowEnd: window.end},
    }});
    return {supported: true, serverNow: new Date(now).toISOString(), returnMinutes: settings.returnMinutes,
      source: settings.source, activeReturn: row?.credentialVersion === settings.binding.credentialVersion
        ? exposeReturn(row, now) : null};
  }
  return {
    screen: token => base.withNoiseScreen(token, view),
    startReturn: (token, body) => base.withNoiseScreen(token, async (tx, d) => {
      if (!d) fail(409, 'NO_NATIVE_DEVICE');
      const now = Date.now(), settings = await context(tx, d);
      const window = await activeWindow(tx, d, body.window, now);
      const key = {screenBindingId: settings.binding.id, windowStart: window.start, windowEnd: window.end};
      const previous = await tx.npepNoiseDisplayReturn.findUnique({where: {screenBindingId_windowStart_windowEnd: key}});
      if (previous?.credentialVersion === settings.binding.credentialVersion
        && (previous.requestId === body.requestId || previous.expiresAt.getTime() > now))
        return {...await view(tx, d), activeReturn: exposeReturn(previous, now)};
      const claimed = body.offlineStartedAt && Date.parse(body.offlineStartedAt);
      if (body.offlineStartedAt && (!claimed || claimed > now || claimed < now - 3600000))
        fail(409, 'OFFLINE_RETURN_UNCONFIRMED');
      const startedAt = claimed || now;
      // A remembered offline policy can only shorten the currently configured limit.
      const returnMinutes = body.returnMinutes === undefined
        ? settings.returnMinutes : Math.min(body.returnMinutes, settings.returnMinutes);
      const row = await tx.npepNoiseDisplayReturn.upsert({where: {screenBindingId_windowStart_windowEnd: key},
        create: {...key, credentialVersion: settings.binding.credentialVersion, requestId: body.requestId,
          startedAt: new Date(startedAt), expiresAt: new Date(startedAt + returnMinutes * 60000),
          returnMinutes},
        update: {credentialVersion: settings.binding.credentialVersion, requestId: body.requestId,
          startedAt: new Date(startedAt), expiresAt: new Date(startedAt + returnMinutes * 60000),
          returnMinutes}});
      return {...await view(tx, d), activeReturn: exposeReturn(row, now)};
    }),
    listSettings: (claims, schoolId, termId) => base.withScheduleAdmin(claims, schoolId, async (tx, config) => {
      const catalog = await repository.catalog(tx, schoolId, termId, config);
      const settings = catalog.termId ? await tx.npepNoiseDisplaySetting.findMany({where: {schoolId, termId: catalog.termId}}) : [];
      return {...catalog, settings: settings.filter(s => (s.targetType === 'GRADE' ? catalog.grades : catalog.classes)
        .some(target => target.id === s.targetId))};
    }),
    saveSetting: (claims, schoolId, body) => base.withScheduleAdmin(claims, schoolId, async (tx, config) => {
      const fingerprint = digest(body);
      const prior = await tx.npepNoiseDisplaySettingRequest.findUnique({where: {schoolId_requestId: {
        schoolId, requestId: body.requestId}}});
      if (prior) {
        if (prior.actorId !== claims.accountId || prior.digest !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT');
        return prior.result;
      }
      const catalog = await repository.catalog(tx, schoolId, body.termId, config);
      if (!(body.targetType === 'GRADE' ? catalog.grades : catalog.classes).some(t => t.id === body.targetId))
        fail(404, 'NOT_FOUND');
      const key = {schoolId, termId: body.termId, targetType: body.targetType, targetId: body.targetId};
      const current = await tx.npepNoiseDisplaySetting.findUnique({where: {schoolId_termId_targetType_targetId: key}});
      if ((current?.revision ?? 0) !== body.expectedRevision) fail(409, 'DISPLAY_SETTING_VERSION_CONFLICT');
      const revision = body.expectedRevision + 1;
      if (body.returnMinutes === null) await tx.npepNoiseDisplaySetting.deleteMany({where: key});
      else await tx.npepNoiseDisplaySetting.upsert({where: {schoolId_termId_targetType_targetId: key},
        create: {...key, returnMinutes: body.returnMinutes, revision, updatedBy: claims.accountId},
        update: {returnMinutes: body.returnMinutes, revision, updatedBy: claims.accountId}});
      const result = {...key, returnMinutes: body.returnMinutes, revision: body.returnMinutes === null ? 0 : revision};
      await tx.npepNoiseDisplaySettingRequest.create({data: {schoolId, requestId: body.requestId,
        actorId: claims.accountId, digest: fingerprint, result}});
      return result;
    }),
  };
}
