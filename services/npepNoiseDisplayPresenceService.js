import {digest, fail} from '../domain/npep/wire.js';
import {identityOf} from '../domain/npep/runtimeControl.js';
import {noiseRepository} from './npepNoiseRepository.js';
import {noiseScheduleRuntimeRepository} from './npepNoiseScheduleRuntime.js';

const FRESH_MS = 12000;
const RETAIN_MS = 60000;
const MAX_TABS = 8;
const windowMatches = (a, b) => a?.start === b?.start && a?.end === b?.end;

export function selectDisplayPresence(rows, now, activeReturn) {
  if (activeReturn?.remainingSeconds > 0) return {state: 'RETURNING', ageMs: 0};
  const recent = rows.filter(row => {
    const age = now - new Date(row.receivedAt).getTime();
    return age >= 0 && age <= FRESH_MS && row.state !== 'RETURNING';
  });
  for (const state of ['DISPLAY_VISIBLE', 'BLOCKED', 'HIDDEN']) {
    const row = recent.find(item => item.state === state);
    if (row) return {state, ageMs: Math.min(600000,
      Math.max(0, now - new Date(row.receivedAt).getTime()))};
  }
  return {state: 'UNKNOWN', ageMs: null};
}

export function createNpepNoiseDisplayPresenceService(base, display) {
  async function currentReceipt(tx, d, context) {
    const receipt = await tx.npepSessionReceipt.findUnique({where: {sessionId: context.sessionId}});
    if (!receipt || receipt.deviceId !== d.id || receipt.runId !== context.runId
      || receipt.statusEpoch !== context.statusEpoch || receipt.expiresAt <= new Date()
      || d.sessionId !== context.sessionId || d.statusEpoch !== context.statusEpoch
      || digest(context.identity) !== digest(identityOf(d))) fail(409, 'SESSION_SUPERSEDED');
  }
  async function scope(tx, d, body, context = null) {
    await display.activeWindow(tx, d, body.window, Date.now());
    const [noise, schedule] = await Promise.all([
      noiseRepository.read(tx, d.id), noiseScheduleRuntimeRepository.read(tx, d.id),
    ]);
    if (!noise.context || !schedule.context || digest(noise.context) !== digest(schedule.context)
      || digest(noise.context.identity) !== digest(identityOf(d))
      || noise.context.sessionId !== d.sessionId || noise.context.statusEpoch !== d.statusEpoch
      || (context && digest(noise.context) !== digest(context))
      || noise.status?.instanceId !== body.instanceId || noise.status?.revision !== body.revision
      || noise.status?.sessionId !== body.captureSessionId
      || schedule.status?.sessionId !== body.captureSessionId
      || !windowMatches(schedule.status.window, body.window)) fail(409, 'DISPLAY_SESSION_CHANGED');
  }
  async function observeInTx(tx, d, body) {
    await scope(tx, d, body, body.context);
    const info = await display.deviceView(tx, d, body.window);
    const now = Date.now();
    const binding = await tx.classroomScreenBinding.findUnique({where: {id: d.screenBindingId}});
    const rows = await tx.npepNoiseDisplayPresence.findMany({where: {
      screenBindingId: d.screenBindingId, credentialVersion: binding.credentialVersion,
      deviceId: d.id, instanceId: body.instanceId, revision: body.revision,
      captureSessionId: body.captureSessionId, windowStart: body.window.start,
      windowEnd: body.window.end, receivedAt: {gte: new Date(now - FRESH_MS)},
    }, orderBy: {receivedAt: 'desc'}, take: MAX_TABS});
    return {...info, presence: selectDisplayPresence(rows, now, info.activeReturn)};
  }
  return {
    screenPresence: (token, body) => base.withNoiseScreen(token, async (tx, d) => {
      if (!d) fail(409, 'NO_NATIVE_DEVICE');
      await scope(tx, d, body);
      const info = await display.deviceView(tx, d, body.window);
      if (body.state === 'RETURNING' && !(info.activeReturn?.remainingSeconds > 0))
        fail(409, 'RETURN_LEASE_REQUIRED');
      const binding = await tx.classroomScreenBinding.findUnique({where: {id: d.screenBindingId}});
      const key = {screenBindingId: binding.id, displaySessionId: body.displaySessionId};
      const previous = await tx.npepNoiseDisplayPresence.findUnique({
        where: {screenBindingId_displaySessionId: key}});
      const fingerprint = digest(body);
      if (previous?.credentialVersion === binding.credentialVersion
        && body.sequence <= previous.sequence) {
        if (body.sequence !== previous.sequence || previous.requestId !== body.requestId
          || previous.digest !== fingerprint) fail(409, 'SEQUENCE_CONFLICT');
        return {accepted: true, serverNow: new Date().toISOString()};
      }
      const now = new Date();
      await tx.npepNoiseDisplayPresence.deleteMany({where: {
        screenBindingId: binding.id, receivedAt: {lt: new Date(now.getTime() - RETAIN_MS)}}});
      if ((!previous || previous.credentialVersion !== binding.credentialVersion)
        && await tx.npepNoiseDisplayPresence.count({
        where: {screenBindingId: binding.id, credentialVersion: binding.credentialVersion}}) >= MAX_TABS)
        fail(429, 'DISPLAY_SESSION_LIMIT');
      const data = {...key, credentialVersion: binding.credentialVersion, deviceId: d.id,
        instanceId: body.instanceId, revision: body.revision, captureSessionId: body.captureSessionId,
        windowStart: body.window.start, windowEnd: body.window.end, state: body.state,
        sequence: body.sequence, requestId: body.requestId, digest: fingerprint, receivedAt: now};
      await tx.npepNoiseDisplayPresence.upsert({
        where: {screenBindingId_displaySessionId: key}, create: data, update: data});
      return {accepted: true, serverNow: now.toISOString()};
    }),
    observe: (auth, body) => base.withRuntimeDevice(auth, async (tx, d) => {
      await currentReceipt(tx, d, body.context);
      return observeInTx(tx, d, body);
    }),
    deviceReturn: (auth, body) => base.withRuntimeDevice(auth, async (tx, d) => {
      await currentReceipt(tx, d, body.context);
      await scope(tx, d, body, body.context);
      const started = await display.startForDevice(tx, d, body);
      const observed = await observeInTx(tx, d, body);
      return started.activeReturn?.remainingSeconds === 0
        ? {...observed, activeReturn: started.activeReturn} : observed;
    }),
  };
}
