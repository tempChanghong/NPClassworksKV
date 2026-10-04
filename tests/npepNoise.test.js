import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createNpepNoiseService} from '../services/npepNoiseService.js';
import {validateNoise} from '../domain/npep/noise.js';
import {identityOf} from '../domain/npep/runtimeControl.js';

function fixture() {
  const d = {id: randomUUID(), screenBindingId: randomUUID(), serverInstanceId: randomUUID(),
    deploymentEpoch: randomUUID(), bindingRevision: 1, sessionId: randomUUID(), statusEpoch: 1};
  const context = {identity: identityOf(d), sessionId: d.sessionId, statusEpoch: 1, runId: randomUUID(), controlEpoch: randomUUID()};
  let data = {status: null, commands: [], reports: []};
  let scheduled = null;
  const tx = {
    $queryRaw: async strings => strings[0].includes('NpepNoiseScheduleDevice') && scheduled ? [{data: scheduled}] : [],
    npepSessionReceipt: {findUnique: async () => ({deviceId: d.id, runId: context.runId, statusEpoch: 1})},
    classroomScreenBinding: {findUnique: async () => ({credentialVersion: 1})},
    npepNoiseScheduleDevice: {findUnique: async () => ({data: scheduled})},
  };
  const base = {withRuntimeDevice: (_a, f) => f(tx, d), withNoiseScreen: (_s, f) => f(tx, d), withRuntimeAdmin: (_c, _s, _d, f) => f(tx, d)};
  const repo = {read: async () => structuredClone(data), save: async (_tx, _id, value) => { data = structuredClone(value); }};
  const service = createNpepNoiseService(base, repo);
  const status = {instanceId: randomUUID(), revision: 0, sessionId: null, state: 'Idle', deviceName: null, configured: true,
    startedAt: null, currentDbfs: null, quality: 'Waiting', summary: null, algorithm: 'pcm-energy-v1', uploadError: null};
  const body = {requestId: randomUUID(), context, sequence: 1, status, receipts: [], reports: []};
  const command = () => ({requestId: randomUUID(), action: 'START', instanceId: status.instanceId, revision: status.revision, sessionId: status.sessionId, durationSeconds: 10800});
  return {service, d, context, status, body, command, data: () => data,
    schedule: value => { scheduled = value; }};
}

test('noise control accepts only bounded statistics, never arbitrary audio or paths', () => {
  const f = fixture(); assert.equal(validateNoise('exchangeRequest', f.body), true);
  for (const patch of [{pcm: 'AA=='}, {context: null}, {reports: Array(5).fill({})}]) assert.equal(validateNoise('exchangeRequest', {...f.body, ...patch}), false);
  assert.equal(validateNoise('createRequest', {...f.command(), durationSeconds: 10801}), false);
});
test('screen request is idempotent and receipt is distinct from actual microphone state', async () => {
  const f = fixture(); await f.service.exchange('device', f.body);
  const c = f.command(), first = await f.service.create('screen', c);
  assert.deepEqual(await f.service.create('screen', c), first);
  assert.equal((await f.service.screen('screen')).status.state, 'Idle');
  await assert.rejects(f.service.create('screen', f.command()), {code: 'COMMAND_PENDING'});
  const next = {...f.body, sequence: 2, receipts: [{commandId: first.command.commandId, outcome: 'ACCEPTED', reason: null}]};
  await f.service.exchange('device', next);
  assert.equal((await f.service.screen('screen')).commands[0].receipt.outcome, 'ACCEPTED');
  assert.equal((await f.service.screen('screen')).status.state, 'Idle');
});
test('expired starts and session changes cannot be replayed; duplicates do not refresh freshness', async () => {
  const f = fixture(); await f.service.exchange('device', f.body);
  await f.service.create('screen', f.command());
  f.data().commands[0].command.expiresAt = new Date(0).toISOString();
  assert.equal((await f.service.exchange('device', {...f.body, sequence: 2})).command, null);
  f.data().receivedAt = new Date(0).toISOString();
  await f.service.exchange('device', {...f.body, sequence: 2});
  assert.equal((await f.service.screen('screen')).online, false);
  await assert.rejects(f.service.create('screen', f.command()), {code: 'DEVICE_OFFLINE'});
  await assert.rejects(f.service.exchange('device', {...f.body, sequence: 3, context: {...f.context, sessionId: randomUUID()}}), {code: 'SESSION_SUPERSEDED'});
});
test('reports deduplicate, reject altered retries, and preserve no-signal as null', async () => {
  const f = fixture();
  const report = {sessionId: randomUUID(), startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), deviceName: '测试麦克风', algorithm: 'pcm-energy-v1', outcome: 'Stopped',
    summary: {elapsedSeconds: 2, sampledSeconds: 0, coverage: 0, energyMeanDbfs: null, peakDbfs: null, clippedPercent: 0, frames: 0}};
  const b = {...f.body, reports: [report]}; assert.equal(validateNoise('exchangeRequest', b), true);
  await f.service.exchange('device', b); await f.service.exchange('device', {...b, sequence: 2});
  assert.equal((await f.service.screen('screen')).reports.length, 1);
  await assert.rejects(f.service.exchange('device', {...b, sequence: 3, reports: [{...report, outcome: 'Faulted'}]}), {code: 'IDEMPOTENCY_CONFLICT'});
});
test('stop targets the reported session and starts require a configured microphone', async () => {
  const f = fixture(); f.status.configured = false; await f.service.exchange('device', f.body);
  await assert.rejects(f.service.create('screen', f.command()), {code: 'MICROPHONE_NOT_CONFIGURED'});
  f.status.configured = true; f.status.state = 'Active'; f.status.sessionId = randomUUID();
  await f.service.exchange('device', {...f.body, sequence: 2});
  await assert.rejects(f.service.create('screen', {...f.command(), action: 'STOP', sessionId: randomUUID()}), {code: 'STATE_CHANGED'});
  assert.equal((await f.service.create('screen', {...f.command(), action: 'STOP'})).command.sessionId, f.status.sessionId);
});

test('scheduled STOP rejects the legacy route and requires a binding-scoped management grant', async () => {
  const f = fixture();
  f.status.state = 'Active';
  f.status.sessionId = randomUUID();
  f.schedule({status: {owner: 'Schedule', reason: 'WINDOW_ACTIVE', sessionId: f.status.sessionId,
    window: {start: '2026-10-04T19:00:00.000', end: '2026-10-04T20:00:00.000'}}});
  await f.service.exchange('device', f.body);
  const stop = {...f.command(), action: 'STOP'};
  await assert.rejects(f.service.create('screen', stop), {code: 'MANAGEMENT_REQUIRED'});
  const granted = await f.service.create('screen', stop,
    {bindingId: f.d.screenBindingId, credentialVersion: 1});
  assert.equal(granted.managementGrant.sessionId, stop.sessionId);
  assert.equal(granted.command.action, 'STOP');
});
