import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createNpepRuntimeService} from '../services/npepRuntimeService.js';
import {validateRuntime, identityOf} from '../domain/npep/runtimeControl.js';
import {fail} from '../domain/npep/wire.js';

const clone = value => value == null ? null : structuredClone(value);
async function fixture() {
  const policies = new Map(), operations = new Map();
  const device = {id: randomUUID(), serverInstanceId: randomUUID(), deploymentEpoch: randomUUID(), bindingRevision: 1,
    schoolId: 'school', administrativeClassId: 'class', screenBindingId: 'screen', sessionId: randomUUID(), statusEpoch: 1};
  const context = {identity: identityOf(device), runId: randomUUID(), sessionId: device.sessionId, statusEpoch: 1, controlEpoch: randomUUID()};
  const claims = {accountId: 'admin', sessionId: 'session', tokenVersion: 1, exp: Math.floor(Date.now() / 1000) + 3600};
  const policy = {consentId: randomUUID(), policyRevision: 1, enabled: true, supported: true, pairedExamControl: true, remoteDailyControl: true};
  const tx = {npepSessionReceipt: {findUnique: async () => ({deviceId: device.id, ...context})}, account: {findUnique: async () => ({name: '管理员'})}};
  let tail = Promise.resolve(), authorized = true;
  const serial = work => { const result = tail.then(work); tail = result.catch(() => {}); return result; };
  const base = {
    withRuntimeAdmin: (c, school, id, work) => serial(() => {
      if (c !== claims || school !== device.schoolId || id !== device.id) fail(403, 'SCHOOL_ADMIN_REQUIRED');
      return work(tx, device);
    }),
    withRuntimeDevice: (_auth, work, initiator) => serial(async () => {
      if (initiator) { const c = await initiator(tx, device); if (!authorized || c.accountId !== claims.accountId) fail(403, 'INITIATOR_NO_LONGER_AUTHORIZED'); }
      return work(tx, device);
    }),
  };
  const repo = {policy: async (_tx, id) => clone(policies.get(id)), savePolicy: async (_tx, id, p) => policies.set(id, clone(p)),
    operation: async (_tx, id) => clone(operations.get(id)), saveOperation: async (_tx, op) => operations.set(op.view.operationId, clone(op)),
    list: async (_tx, id, active) => [...operations.values()].filter(op => op.view.deviceId === id && (!active || !op.view.resolvedAt)).map(clone),
    byRequest: async (_tx, id, request) => clone([...operations.values()].find(op => op.view.deviceId === id && op.view.requestId === request))};
  const service = createNpepRuntimeService(base, repo);
  const body = value => ({requestId: randomUUID(), context: clone(context), ...value});
  await service.policy('device', body({policy}));
  const status = {runtimeMode: 'OTHER', runtimePhase: 'IDLE', runtimeRevision: 0, modeRevision: 0, configurationRevision: 0,
    consentId: policy.consentId, policyRevision: 1, remoteExamPause: false, recording: 'IDLE', desktop: 'INTERACTIVE', noticeOpen: false,
    operationId: null, observedAt: new Date().toISOString()};
  await service.status('device', body({sequence: 1, sampleAgeMs: 0, status}));
  const create = {requestId: randomUUID(), target: 'EXAM', scope: 'EXAM_MODE', expectedRuntimeRevision: 0, expectedModeRevision: 0,
    expectedConfigurationRevision: 0, consentId: policy.consentId, policyRevision: 1, controlEpoch: context.controlEpoch};
  const start = () => body(Object.fromEntries(['consentId', 'policyRevision', 'expectedRuntimeRevision', 'expectedModeRevision', 'expectedConfigurationRevision'].map(k => [k, create[k]])));
  return {service, device, context, policy, claims, body, status, create, start, policies, operations, revokeInitiator: () => { authorized = false; }};
}
const invoke = (f, method, ...args) => f.service[method](f.claims, 'school', f.device.id, ...args);

test('N3 preserves old history without upgrading its execution scope', async () => {
  const f = await fixture();
  await assert.rejects(invoke(f, 'create', {...f.create, scope: 'CURRENT_RUNTIME'}), {code: 'UNSUPPORTED_SCOPE'});
  const op = (await invoke(f, 'create', f.create)).data;
  f.operations.get(op.operationId).view.scope = 'CURRENT_RUNTIME';
  const history = (await invoke(f, 'list')).items[0];
  assert.equal(history.scope, 'CURRENT_RUNTIME');
  assert.equal(validateRuntime('operation', history), true);
  await assert.rejects(f.service.start('device', op.operationId, f.start()), {code: 'UNSUPPORTED_SCOPE'});
  assert.equal(f.operations.get(op.operationId).view.grant, null);
});

test('N3 success requires startup readback evidence, not only running software', async () => {
  const f = await fixture(); const op = (await invoke(f, 'create', f.create)).data;
  const {grant} = await f.service.start('device', op.operationId, f.start());
  const evidence = {examAware: 'READY', classIsland: 'EXITED', remoteExamPause: true, startup: 'NOT_REQUESTED', sideEffects: 'APPLIED',
    alreadySatisfied: false, observedAt: new Date().toISOString(), configurationRevision: 0};
  const evt = {eventId: randomUUID(), operationId: op.operationId, sequence: 1, state: 'SUCCEEDED', step: 'VERIFY', reasonCode: null,
    occurredAt: evidence.observedAt, evidence, execution: Object.fromEntries(['runId', 'sessionId', 'statusEpoch', 'controlEpoch', 'grantId'].map(k => [k, grant[k]]))};
  await assert.rejects(f.service.events('device', f.body({events: [evt]})), {code: 'INVALID_TRANSITION'});
  evidence.startup = 'EXAM_MODE_APPLIED';
  assert.equal((await f.service.events('device', f.body({events: [evt]}))).results[0].status, 'ACCEPTED');
});
test('N3 schema rejects startup/path/bulk authority and accepts fixed EXAM or DAILY', () => {
  const cases = JSON.parse(readFileSync(new URL('../docs/npep-n3/examples.json', import.meta.url))).cases;
  for (const c of cases) {
    assert.equal(validateRuntime(c.definition, c.value), c.valid, c.name);
  }
});

test('remote Daily needs capability, cannot merge opposite target and requires complete Daily evidence', async () => {
  const f = await fixture(); const daily = {...f.create, target: 'DAILY'};
  delete f.policies.get(f.device.id).policy.remoteDailyControl;
  await assert.rejects(invoke(f, 'create', daily), {code: 'CLIENT_UNSUPPORTED'});
  f.policies.get(f.device.id).policy.remoteDailyControl = true;
  const op = (await invoke(f, 'create', daily)).data;
  assert.equal(op.target, 'DAILY'); assert.equal(validateRuntime('operation', op), true);
  assert.equal((await invoke(f, 'create', {...daily, requestId: randomUUID()})).data.operationId, op.operationId);
  await assert.rejects(invoke(f, 'create', {...f.create, requestId: randomUUID()}), {code: 'OPERATION_BUSY'});
  await assert.rejects(invoke(f, 'create', f.create), {code: 'IDEMPOTENCY_CONFLICT'});
  const {grant} = await f.service.start('device', op.operationId, f.start());
  const evidence = {examAware: 'EXITED', classIsland: 'READY', remoteExamPause: false, startup: 'DAILY_MODE_APPLIED', sideEffects: 'APPLIED',
    alreadySatisfied: false, observedAt: new Date().toISOString(), configurationRevision: 0};
  const evt = {eventId: randomUUID(), operationId: op.operationId, sequence: 1, state: 'SUCCEEDED', step: 'VERIFY', reasonCode: null,
    occurredAt: evidence.observedAt, evidence, execution: Object.fromEntries(['runId', 'sessionId', 'statusEpoch', 'controlEpoch', 'grantId'].map(k => [k, grant[k]]))};
  for (const incomplete of [{examAware:'READY'}, {classIsland:'RUNNING'}, {remoteExamPause:true}, {startup:'EXAM_MODE_APPLIED'}])
    await assert.rejects(f.service.events('device', f.body({events:[{...evt, evidence:{...evidence,...incomplete}}]})), {code:'INVALID_TRANSITION'});
  assert.equal((await f.service.events('device', f.body({events:[evt]}))).results[0].status, 'ACCEPTED');
  assert.equal((await f.service.events('device', f.body({events:[evt]}))).results[0].status, 'DUPLICATE');
  assert.equal((await invoke(f, 'create', {...f.create, requestId:randomUUID()})).created, true);
});
test('N3 duplicate and concurrent equivalent requests share the active execution', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([invoke(f, 'create', f.create), invoke(f, 'create', f.create)]);
  assert.equal(a.data.operationId, b.data.operationId); assert.equal(b.created, false);
  assert.equal(validateRuntime('operation', a.data), true);
  assert.equal(validateRuntime('managementStatus', await invoke(f, 'managementStatus')), true);
  assert.equal((await invoke(f, 'create', {...f.create, requestId: randomUUID()})).data.operationId, a.data.operationId);
  await assert.rejects(f.service.create(f.claims, 'another-school', f.device.id, f.create), {code: 'SCHOOL_ADMIN_REQUIRED'});
});

test('paired priority requests accept notices, recording, old pause and stale UI revisions', async () => {
  const f = await fixture(), p = f.policies.get(f.device.id);
  Object.assign(p.status, {noticeOpen: true, recording: 'RECORDING', remoteExamPause: true, runtimePhase: 'RECOVERY_REQUIRED', runtimeRevision: 25, modeRevision: 30});
  assert.equal((await invoke(f, 'create', f.create)).created, true);
  const g = await fixture(); delete g.policies.get(g.device.id).policy.pairedExamControl;
  await assert.rejects(invoke(g, 'create', g.create), {code: 'CLIENT_UNSUPPORTED'});
});

test('new Host epoch frees interrupted execution and accepts its late authenticated receipt', async () => {
  const f = await fixture(), first = (await invoke(f, 'create', f.create)).data;
  const {grant} = await f.service.start('device', first.operationId, f.start());
  f.context.controlEpoch = randomUUID(); f.policy.policyRevision++;
  await f.service.policy('device', f.body({policy: f.policy}));
  await f.service.status('device', f.body({sequence: 1, sampleAgeMs: 0, status: {...f.status, policyRevision: f.policy.policyRevision}}));
  const next = await invoke(f, 'create', {...f.create, requestId: randomUUID(), policyRevision: f.policy.policyRevision, controlEpoch: f.context.controlEpoch});
  assert.notEqual(next.data.operationId, first.operationId);
  assert.equal(f.operations.get(first.operationId).view.state, 'UNKNOWN');
  const event = {eventId: randomUUID(), operationId: first.operationId, sequence: 1, state: 'PARTIAL', step: 'PREPARE_EXAM', reasonCode: 'EXAMAWARE_NOT_READY',
    occurredAt: new Date().toISOString(), evidence: {examAware: 'NOT_READY', classIsland: 'RUNNING', remoteExamPause: true,
      startup: 'UNKNOWN', sideEffects: 'POSSIBLE', alreadySatisfied: false, observedAt: new Date().toISOString(), configurationRevision: 0},
    execution: Object.fromEntries(['runId','sessionId','statusEpoch','controlEpoch','grantId'].map(k => [k,grant[k]]))};
  const forged = structuredClone(event); forged.execution.grantId = randomUUID();
  await assert.rejects(f.service.events('device', f.body({events:[forged]})), {code:'AUTH_INVALID'});
  assert.equal((await f.service.events('device', f.body({events:[event]}))).results[0].status, 'ACCEPTED');
  assert.equal((await f.service.poll('device')).items[0].operationId, next.data.operationId);
});
test('N3 rechecks initiator, policy, recorder, and deadline before issuing a grant', async () => {
  const f = await fixture(); const op = (await invoke(f, 'create', f.create)).data;
  f.revokeInitiator();
  await assert.rejects(f.service.start('device', op.operationId, f.start()), {code: 'INITIATOR_NO_LONGER_AUTHORIZED'});
  const g = await fixture(); const other = (await invoke(g, 'create', g.create)).data;
  await g.service.policy('device', g.body({policy: {...g.policy, policyRevision: 2, consentId: randomUUID(), enabled: false}}));
  await assert.rejects(g.service.start('device', other.operationId, g.start()), {code: 'EXPIRED'});
  const h = await fixture(); h.policies.get(h.device.id).status.recording = 'RECORDING';
  assert.equal((await invoke(h, 'create', h.create)).created, true);
  h.policies.get(h.device.id).status.recording = 'IDLE'; h.policies.get(h.device.id).sampleAsOf = new Date(Date.now() - 61000).toISOString();
  await assert.rejects(invoke(h, 'create', {...h.create,requestId:randomUUID()}), {code: 'DEVICE_OFFLINE'});
});
test('N3 cancelled task cannot start; granted task cannot cancel or expire from silence', async () => {
  const f = await fixture(); const op = (await invoke(f, 'create', f.create)).data;
  await invoke(f, 'cancel', op.operationId);
  await assert.rejects(f.service.start('device', op.operationId, f.start()), {code: 'EXPIRED'});
  const g = await fixture(); const other = (await invoke(g, 'create', g.create)).data;
  const a = await g.service.start('device', other.operationId, g.start()), b = await g.service.start('device', other.operationId, g.start());
  assert.deepEqual(a.grant, b.grant); assert.equal(validateRuntime('startResponse', a), true);
  await assert.rejects(invoke(g, 'cancel', other.operationId), {code: 'START_ALREADY_AUTHORIZED'});
  g.operations.get(other.operationId).view.expiresAt = '2000-01-01T00:00:00.000Z';
  assert.equal((await g.service.poll('device')).items[0].state, 'START_AUTHORIZED');
});
test('N3 partial receipt is idempotent, releases slot and local resolution preserves outcome', async () => {
  const f = await fixture(); const op = (await invoke(f, 'create', f.create)).data;
  const {grant} = await f.service.start('device', op.operationId, f.start());
  const evidence = {examAware: 'READY', classIsland: 'RUNNING', remoteExamPause: true, startup: 'EXAM_MODE_APPLIED', sideEffects: 'POSSIBLE',
    alreadySatisfied: false, observedAt: new Date().toISOString(), configurationRevision: 0};
  const evt = {eventId: randomUUID(), operationId: op.operationId, sequence: 1, state: 'PARTIAL', step: 'CLOSE_CLASSISLAND', reasonCode: 'UAC_CANCELLED',
    occurredAt: evidence.observedAt, evidence, execution: Object.fromEntries(['runId', 'sessionId', 'statusEpoch', 'controlEpoch', 'grantId'].map(k => [k, grant[k]]))};
  const a = await f.service.events('device', f.body({events: [evt]}));
  const b = await f.service.events('device', f.body({events: [evt]}));
  assert.equal(a.results[0].status, 'ACCEPTED'); assert.equal(b.results[0].status, 'DUPLICATE');
  assert.equal((await invoke(f, 'create', {...f.create, requestId: randomUUID()})).created, true);
  const resolved = await f.service.resolve('device', op.operationId, f.body({resolutionId: randomUUID(), expectedLastEventSequence: 1,
    kind: 'LOCAL_END', noPendingActions: true, evidence: {...evidence, remoteExamPause: false}, occurredAt: new Date().toISOString()}));
  assert.equal(resolved.state, 'PARTIAL'); assert.ok(resolved.resolvedAt); assert.ok(resolved.localEndedAt);
});
