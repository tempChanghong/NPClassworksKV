import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createNpepExamPlanService} from '../services/npepExamPlanService.js';
import {validateExamPlan, planDigest} from '../domain/npep/examPlans.js';
import {identityOf} from '../domain/npep/runtimeControl.js';
import {fail} from '../domain/npep/wire.js';

const clone = x => x == null ? null : structuredClone(x);
async function fixture() {
  const statuses = new Map(), ops = new Map();
  const d = {id: randomUUID(), schoolId: 'school', serverInstanceId: randomUUID(), deploymentEpoch: randomUUID(), bindingRevision: 1, sessionId: randomUUID(), statusEpoch: 1};
  const context = {identity: identityOf(d), runId: randomUUID(), sessionId: d.sessionId, statusEpoch: 1, controlEpoch: randomUUID()};
  const claims = {accountId: 'admin', sessionId: 'admin-session', tokenVersion: 1, exp: 9999999999};
  const tx = {npepSessionReceipt: {findUnique: async () => ({deviceId: d.id, ...context})}};
  let allowed = true, tail = Promise.resolve();
  const serial = work => { const p = tail.then(work); tail = p.catch(() => {}); return p; };
  const base = {
    withRuntimeAdmin: (c, s, id, work) => serial(() => { if (c !== claims || s !== d.schoolId || id !== d.id) fail(403, 'SCHOOL_ADMIN_REQUIRED'); return work(tx, d); }),
    withRuntimeDevice: (_auth, work, initiator) => serial(async () => { if (initiator) { await initiator(tx, d); if (!allowed) fail(403, 'INITIATOR_NO_LONGER_AUTHORIZED'); } return work(tx, d); }),
  };
  const repo = {status: async (_, id) => clone(statuses.get(id)), saveStatus: async (_, id, p) => statuses.set(id, clone(p)),
    get: async (_, id) => clone(ops.get(id)), save: async (_, op) => ops.set(op.view.operationId, clone(op)),
    list: async () => [...ops.values()].reverse().slice(0, 10).map(clone),
    byRequest: async (_, id, requestId) => clone([...ops.values()].find(op => op.view.requestId === requestId && op.view.context.identity.deviceId === id))};
  const service = createNpepExamPlanService(base, repo);
  const body = extra => ({requestId: randomUUID(), context: clone(context), ...extra});
  const status = {enabled: true, consentId: randomUUID(), policyRevision: 1, revision: 1, available: true, blockReason: null,
    player: {known: true, sessions: [], lastSession: null}, preparedId: null};
  await service.report('device', body({sequence: 1, status}));
  const create = body({consentId: status.consentId, policyRevision: 1, revision: 1, fileName: '考试.json', dataBase64: Buffer.from('{"examName":"考试"}').toString('base64')});
  const invoke = (method, ...args) => service[method](claims, d.schoolId, d.id, ...args);
  const result = (stage, state, extra = {}) => body({stage, state, summary: null, sessionId: null, reasonCode: null, grantId: null, ...extra});
  async function prepare() {
    const op = (await invoke('create', create)).data;
    const summary = {preparationId: randomUUID(), sha256: op.sha256, examName: '考试', message: '', exams: [{name: '语文', start: '09:00', end: '11:00', alertTime: 15}]};
    await service.result('device', op.operationId, result('prepare', 'PREPARED', {summary}));
    status.preparedId = summary.preparationId;
    await service.report('device', body({sequence: 2, status}));
    return {op, summary, start: {requestId: randomUUID(), preparationId: summary.preparationId, sha256: op.sha256}};
  }
  return {service, d, context, claims, statuses, ops, body, status, create, invoke, result, prepare, revoke: () => { allowed = false; }};
}

test('N4 explicit prepare/start preserves byte hash, idempotency and live player separation', async () => {
  const f = await fixture(), p = await f.prepare();
  assert.equal((await f.service.poll('device')).item.state, 'PREPARED');
  assert.equal((await f.service.poll('device')).item.dataBase64, null);
  await assert.rejects(f.service.grant('device', p.op.operationId, f.body({})), {code: 'STATE_CHANGED'});
  assert.equal((await f.invoke('start', p.op.operationId, p.start)).state, 'START_REQUESTED');
  await f.invoke('start', p.op.operationId, p.start);
  const a = await f.service.grant('device', p.op.operationId, f.body({}));
  const b = await f.service.grant('device', p.op.operationId, f.body({}));
  assert.deepEqual(a.grant, b.grant); assert.ok(validateExamPlan('grantResponse', a));
  await assert.rejects(f.invoke('cancel', p.op.operationId), {code: 'START_ALREADY_AUTHORIZED'});
  const result = f.result('start', 'STARTED', {sessionId: 'player-1', grantId: a.grant.grantId});
  await f.service.result('device', p.op.operationId, result);
  await f.service.result('device', p.op.operationId, {...result, requestId: randomUUID()});
  const view = await f.invoke('management'); assert.ok(validateExamPlan('management', view));
  assert.equal(view.items[0].state, 'STARTED'); assert.deepEqual(view.status.player.sessions, []);
  assert.equal((await f.invoke('create', f.create)).created, false);
});
test('N4 concurrent create has one active slot and rejects a changed request body', async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.invoke('create', f.create), f.invoke('create', f.create)]);
  assert.equal(a.data.operationId, b.data.operationId);
  await assert.rejects(f.invoke('create', {...f.create, fileName: 'other.json'}), {code: 'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.invoke('create', {...f.create, requestId: randomUUID()}), {code: 'OPERATION_BUSY'});
});
test('N4 rechecks start initiator, current preparation and known idle player before grant', async () => {
  const f = await fixture(), p = await f.prepare();
  await f.invoke('start', p.op.operationId, p.start); f.revoke();
  await assert.rejects(f.service.grant('device', p.op.operationId, f.body({})), {code: 'INITIATOR_NO_LONGER_AUTHORIZED'});
  const g = await fixture(), q = await g.prepare();
  g.statuses.get(g.d.id).status.player.sessions = [{id: 'other', state: 'ready', examName: 'other'}];
  await assert.rejects(g.invoke('start', q.op.operationId, q.start), {code: 'PLAYER_BUSY'});
  g.statuses.get(g.d.id).status.player.sessions = []; g.statuses.get(g.d.id).status.preparedId = randomUUID();
  await assert.rejects(g.invoke('start', q.op.operationId, q.start), {code: 'PLAN_EXPIRED'});
});
test('N4 consent changes and restart epochs expire pending tasks without creating a new grant', async () => {
  const f = await fixture(), p = await f.prepare();
  await f.service.report('device', f.body({sequence: 3, status: {...f.status, enabled: false, policyRevision: 2}}));
  assert.equal((await f.invoke('management')).items[0].state, 'EXPIRED');
  await assert.rejects(f.invoke('start', p.op.operationId, p.start), {code: 'STATE_CHANGED'});
  const g = await fixture(), q = await g.prepare();
  g.context.controlEpoch = randomUUID();
  await g.service.report('device', g.body({sequence: 1, status: {...g.status, policyRevision: 2}}));
  assert.equal((await g.invoke('management')).items[0].state, 'EXPIRED');
  assert.equal(g.ops.get(q.op.operationId).view.grant, null);
});
test('N4 unknown start and elapsed grant never become successful from silence', async () => {
  const f = await fixture(), p = await f.prepare();
  await f.invoke('start', p.op.operationId, p.start);
  await f.service.grant('device', p.op.operationId, f.body({}));
  f.ops.get(p.op.operationId).view.grant.startNotAfter = '2000-01-01T00:00:00.000Z';
  assert.equal((await f.service.poll('device')).item, null);
  assert.equal((await f.invoke('management')).items[0].state, 'UNKNOWN');
});
test('N4 results require matching hash/grant and bounded summary', async () => {
  const f = await fixture(), op = (await f.invoke('create', f.create)).data;
  const summary = {preparationId: randomUUID(), sha256: '0'.repeat(64), examName: '考试', message: '', exams: [{name: '数学', start: '', end: '', alertTime: 15}]};
  await assert.rejects(f.service.result('device', op.operationId, f.result('prepare', 'PREPARED', {summary})), {code: 'INVALID_TRANSITION'});
  summary.sha256 = op.sha256; summary.message = 'a'.repeat(6000);
  await assert.rejects(f.service.result('device', op.operationId, f.result('prepare', 'PREPARED', {summary})), {code: 'INVALID_TRANSITION'});
  const g = await fixture(), p = await g.prepare(); await g.invoke('start', p.op.operationId, p.start);
  await assert.rejects(g.service.result('device', p.op.operationId, g.result('start', 'STARTED', {sessionId: 'p', grantId: randomUUID()})), {code: 'INVALID_TRANSITION'});
});
test('N4 rejects offline, disabled and wrong identity; cancellation removes plan payload', async () => {
  const f = await fixture(); f.statuses.get(f.d.id).receivedAt = '2000-01-01T00:00:00.000Z';
  await assert.rejects(f.invoke('create', f.create), {code: 'DEVICE_OFFLINE'});
  const g = await fixture(); g.statuses.get(g.d.id).status.enabled = false;
  await assert.rejects(g.invoke('create', g.create), {code: 'CONTROL_DISABLED'});
  const h = await fixture(), op = (await h.invoke('create', h.create)).data;
  await h.invoke('cancel', op.operationId); assert.equal((await h.service.poll('device')).item, null);
  assert.equal(h.ops.get(op.operationId).view.dataBase64, null);
  h.context.identity.deviceId = randomUUID();
  await assert.rejects(h.service.report('device', h.body({sequence: 3, status: h.status})), {code: 'AUTH_INVALID'});
});
test('N4 byte input is UTF8 canonical base64, object JSON, handles BOM; schema rejects extra authority', async () => {
  const f = await fixture(); assert.ok(validateExamPlan('createRequest', f.create));
  assert.ok(!validateExamPlan('createRequest', {...f.create, replaceExisting: true}));
  assert.ok(!validateExamPlan('createRequest', {...f.create, fileName: '😀'.repeat(81)}));
  for (const bytes of [Buffer.from('[]'), Buffer.from([255]), Buffer.from('{"x":1,"x":2}')]) assert.throws(() => planDigest(bytes.toString('base64')));
  assert.equal(planDigest(Buffer.from('\ufeff{}').toString('base64')).length, 64);
  assert.throws(() => planDigest(f.create.dataBase64 + '\n'));
});
