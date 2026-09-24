import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, randomBytes} from 'node:crypto';
import {mkdtemp, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {validate} from '../domain/npep/wire.js';
import {readDeployment} from '../domain/npep/deployment.js';
import {closeBeforeRestore, activateDeployment} from '../scripts/npep-deployment.js';

test('N1 real HTTP/PostgreSQL pairing, lifecycle fencing and recovery gate', {skip: process.env.RUN_DATABASE_TESTS !== 'true', timeout: 120000}, async t => {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  assert.match(url.pathname, /^\/npclassworks_test(?:_[a-z0-9_]+)?$/);
  const [{prisma}, {default: express}, {createNpepRouter}, {generateAccessToken}, {Client}, {createNpepService}] = await Promise.all([
    import('../utils/prisma.js'), import('express'), import('../routes/v2/npep.js'), import('../utils/tokenManager.js'), import('pg'), import('../services/npepService.js'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'npep-n1-test-'));
  const gateFile = join(directory, 'deployment.json');
  const identity = {serverInstanceId: randomUUID(), deploymentEpoch: randomUUID()};
  await writeFile(gateFile, JSON.stringify({enabled: false, ...identity}));
  await activateDeployment(prisma, gateFile);
  const deployment = () => readDeployment({NPEP_ENABLED: 'true', NPEP_DEPLOYMENT_FILE: gateFile});
  const app = express();
  app.use('/api/v2/npep', createNpepRouter({deployment, rateLimits: false}));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const origin = `http://127.0.0.1:${server.address().port}/api/v2/npep`;
  const observer = new Client({connectionString: process.env.DATABASE_URL});
  await observer.connect();
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await observer.end(); await prisma.$disconnect(); });
  async function request(path, {body, auth, raw, headers = {}} = {}) {
    const method = body !== undefined || raw !== undefined ? 'POST' : 'GET';
    const response = await fetch(origin + path, {method, signal: AbortSignal.timeout(15000),
      headers: {'Content-Type': 'application/json', 'X-NPEP-Version': '0.1', ...(method === 'GET' ? {'X-Request-Id': randomUUID()} : {}), ...(auth ? {Authorization: `Bearer ${auth}`} : {}), ...headers},
      ...(method === 'POST' ? {body: raw ?? JSON.stringify(body)} : {})});
    const result = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (!response.ok && headers['X-NPEP-Version'] !== '0.2') assert.equal(validate('error', result), true, 'error must have the agreed public shape');
    if (headers['X-NPEP-Version'] === '0.2') assert.equal(result.protocolVersion, '0.2');
    return {status: response.status, data: result.data, error: result.error};
  }
  const req = extra => ({requestId: randomUUID(), ...extra});
  const secret = () => randomBytes(32).toString('base64url');
  const schools = [], accounts = [];
  async function fixture() {
    const school = await prisma.school.create({data: {code: `NPEP-${randomUUID()}`, name: '隔离测试学校'}}); schools.push(school.id);
    const account = await prisma.account.create({data: {provider: 'npep-test', providerId: randomUUID()}}); accounts.push(account.id);
    await prisma.schoolMember.create({data: {schoolId: school.id, accountId: account.id, role: 'ADMIN'}});
    const session = await prisma.accountSession.create({data: {id: randomUUID(), accountId: account.id, refreshTokenHash: randomBytes(32).toString('hex'), expiresAt: new Date(Date.now() + 3600000)}});
    const term = await prisma.academicTerm.create({data: {schoolId: school.id, name: '测试学期', academicYear: 2099, semester: 1, status: 'ACTIVE'}});
    const workspace = await prisma.workspace.create({data: {termId: term.id, name: '测试班', code: 'ONE', type: 'ADMIN_CLASS'}});
    const binding = await prisma.classroomScreenBinding.create({data: {schoolId: school.id, administrativeClassId: workspace.id, name: '测试大屏', tokenHash: randomBytes(32).toString('hex'), createdByAccountId: account.id}});
    return {school, account, session, term, workspace, binding, admin: generateAccessToken(account, session.id), legacyAdmin: generateAccessToken(account)};
  }
  async function pending() {
    const body = req({...identity, installationId: randomUUID(), deviceName: 'NPEduTools测试', appVersion: 'test', pairingSecret: secret(), requestedCapabilities: ['device.status']});
    const response = await request('/pairings', {body}); assert.equal(response.status, 201);
    assert.equal(validate('createdPairing', response.data), true);
    return {...response.data, body, auth: `npepp1.${response.data.pairingId}.${body.pairingSecret}`};
  }
  async function approve(f, p) {
    const body = req({screenBindingId: f.binding.id, capabilities: ['device.status']});
    const r = await request(`/schools/${f.school.id}/pairings/${p.pairingId}/approve`, {auth: f.admin, body});
    assert.equal(r.status, 200, r.error?.code);
    assert.equal(validate('approvedPairing', r.data), true);
    return r.data;
  }
  async function activate(f) {
    const p = await pending(), a = await approve(f, p);
    const body = req({...identity, approvalId: a.approvalId, credentialId: randomUUID(), deviceSecret: secret()});
    const response = await request(`/pairings/${p.pairingId}/confirm`, {auth: p.auth, body});
    assert.equal(response.status, 201, response.error?.code);
    assert.equal(validate('registration', response.data), true);
    return {p, a, body, ...response.data, auth: `npep1.${body.credentialId}.${body.deviceSecret}`};
  }
  async function open(d, epoch = 0) {
    const body = req({...identity, runId: randomUUID(), expectedStatusEpoch: epoch});
    const result = await request('/device/sessions', {auth: d.auth, body});
    assert.equal(result.status, 201, result.error?.code);
    return {...result.data, body};
  }
  const sample = (session, sequence = 1) => req({...identity, sessionId: session.sessionId, statusEpoch: session.statusEpoch, sequence, sampleAgeMs: 1,
    status: {appVersion: 'test', mode: 'EXAM', modePhase: 'RUNNING', modeRevision: 1, automaticRecording: 'ENABLED', recording: 'IDLE',
      classIsland: {connection: 'DISCONNECTED', bridgeVersion: null}, examAware: {connection: 'UNKNOWN', bridgeVersion: null}}});

  const requestN2 = (path, options = {}) => request(path, {...options, headers: {'X-NPEP-Version': '0.2', ...options.headers}});
  const notification = (f, extra = {}) => prisma.publication.create({data: {type: 'NOTICE', content: '真实通知正文',
    status: 'PUBLISHED', publishAt: new Date(Date.now() - 60000), authorAccountId: f.account.id,
    targets: {create: {workspaceId: f.workspace.id}}, ...extra}});
  await t.test('N2 old pairing receives bounded pages with all priorities and separate receipts', async () => {
    const {validateNotification} = await import('../domain/npep/notifications.js');
    const f = await fixture(), d = await activate(f), other = await fixture();
    const rows = [];
    for (let i = 0; i < 23; i++) rows.push(await notification(f, {priority: ['MINOR','NORMAL','IMPORTANT','URGENT'][i % 4],
      contentJson: {popupEnabled: false}, title: `通知${i}`}));
    await notification(other, {content: '其他学校秘密'});
    await notification(f, {status: 'DRAFT'});
    await notification(f, {status: 'WITHDRAWN'});
    await notification(f, {publishAt: new Date(Date.now() + 600000)});
    await notification(f, {expiresAt: new Date(Date.now() - 1000)});
    assert.equal((await requestN2('/device/notifications')).status, 401);
    assert.equal((await request('/device/notifications', {auth: d.auth, headers: {'X-NPEP-Version': '0.2'}})).status, 200);
    const first = await requestN2('/device/notifications', {auth: d.auth});
    assert.equal(first.status, 200, first.error?.code);
    assert.equal(validateNotification('snapshot', first.data), true);
    assert.equal(first.data.items.length, 20);
    const second = await requestN2(`/device/notifications?cursor=${first.data.nextCursor}`, {auth: d.auth});
    assert.equal(second.status, 200, second.error?.code);
    assert.equal(second.data.snapshotId, first.data.snapshotId);
    assert.equal(second.data.items.length, 3);
    assert.equal(second.data.nextCursor, null);
    const items = [...first.data.items, ...second.data.items];
    assert.equal(new Set(items.map(item => item.publicationId)).size, 23);
    for (const item of items) assert.equal(item.popupEnabled, item.priority !== 'MINOR');
    const minor = items.find(item => !item.popupEnabled);
    const event = {eventId: randomUUID(), publicationId: minor.publicationId, revision: minor.revision,
      stage: 'DISPLAYED', occurredAt: new Date().toISOString()};
    const send = events => requestN2('/device/notification-receipts', {auth: d.auth, body: req({events})});
    assert.equal((await send([event])).data.results[0].status, 'ACCEPTED', 'manual open of a silent notice is valid');
    assert.equal((await send([event])).data.results[0].status, 'DUPLICATE');
    assert.equal((await send([{...event, stage: 'DISMISSED'}])).data.results[0].code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await send([{...event, eventId: randomUUID(), revision: 999}])).data.results[0].code, 'NOTICE_NOT_AVAILABLE');
    const dismissed = await send([{...event, eventId: randomUUID(), stage: 'DISMISSED'}]);
    assert.equal(validateNotification('receiptResponse', dismissed.data), true);
    assert.equal(dismissed.data.results[0].status, 'ACCEPTED');
    assert.equal(await prisma.notificationScreenDelivery.count({where: {publicationId: minor.publicationId}}), 0);
    assert.equal(await prisma.npepNotificationReceipt.count({where: {deviceId: d.deviceId, stage: 'RECEIVED'}}), 0);
    const {listNotificationScreenDeliveries} = await import('../services/notificationDeliveryService.js');
    const report = await listNotificationScreenDeliveries({accountId: f.account.id, publicationId: minor.publicationId});
    assert.equal(report.npepDevices[0].receivedAt, null);
    assert.ok(report.npepDevices[0].displayedAt);
    assert.ok(report.npepDevices[0].dismissedAt);
    assert.equal((await request('/device/me', {auth: d.auth})).status, 200, 'N1 registration remains unchanged');
    assert.equal((await requestN2('/device/notifications?schoolId=other', {auth: d.auth})).status, 400);
    assert.equal((await send([{...event, stage: 'ACKNOWLEDGED'}])).status, 400);
  });
  await t.test('N2 changed, expired, replaced and foreign snapshot cursors fail explicitly', async () => {
    const f = await fixture(), d = await activate(f), other = await fixture(), otherDevice = await activate(other);
    const rows = [];
    for (let i = 0; i < 21; i++) rows.push(await notification(f));
    const first = await requestN2('/device/notifications', {auth: d.auth});
    assert.equal((await requestN2(`/device/notifications?cursor=${first.data.nextCursor}`, {auth: otherDevice.auth})).status, 410);
    await prisma.publication.update({where: {id: rows[20].id}, data: {content: '已改', revision: {increment: 1}}});
    assert.equal((await requestN2(`/device/notifications?cursor=${first.data.nextCursor}`, {auth: d.auth})).error.code, 'SNAPSHOT_INVALIDATED');
    const fresh = await requestN2('/device/notifications', {auth: d.auth});
    assert.equal((await requestN2(`/device/notifications?cursor=${first.data.nextCursor}`, {auth: d.auth})).error.code, 'SNAPSHOT_EXPIRED');
    await prisma.npepNotificationSnapshot.update({where: {deviceId: d.deviceId}, data: {expiresAt: new Date(0)}});
    assert.equal((await requestN2(`/device/notifications?cursor=${fresh.data.nextCursor}`, {auth: d.auth})).status, 410);
    const after = await requestN2('/device/notifications', {auth: d.auth});
    await prisma.publication.update({where: {id: rows[0].id}, data: {expiresAt: new Date(0)}});
    assert.equal((await requestN2(`/device/notifications?cursor=${after.data.nextCursor}`, {auth: d.auth})).status, 409);
  });
  await t.test('N2 historical receipts never confirm the new version or bypass revocation', async () => {
    const f = await fixture(), d = await activate(f), row = await notification(f);
    await requestN2('/device/notifications', {auth: d.auth});
    await prisma.publication.update({where: {id: row.id}, data: {revision: 2, status: 'WITHDRAWN'}});
    const event = {eventId: randomUUID(), publicationId: row.id, revision: 1, stage: 'DISMISSED', occurredAt: new Date().toISOString()};
    const sent = await requestN2('/device/notification-receipts', {auth: d.auth, body: req({events: [event]})});
    assert.equal(sent.data.results[0].status, 'ACCEPTED');
    assert.equal(await prisma.npepNotificationReceipt.count({where: {publicationId: row.id, revision: 2}}), 0);
    await observer.query('BEGIN');
    await observer.query('SELECT id FROM "ClassroomScreenBinding" WHERE id=$1 FOR UPDATE', [f.binding.id]);
    const waiting = requestN2('/device/notification-receipts', {auth: d.auth,
      body: req({events: [{...event, eventId: randomUUID(), stage: 'RECEIVED'}]})});
    await delay(100);
    await observer.query('UPDATE "ClassroomScreenBinding" SET "isActive"=false WHERE id=$1', [f.binding.id]);
    await observer.query('COMMIT');
    assert.equal((await waiting).status, 401);
    assert.equal((await requestN2('/device/notifications', {auth: d.auth})).status, 401);
    assert.equal(await prisma.npepNotificationReceipt.count({where: {deviceId: d.deviceId}}), 1);
  });
  await t.test('N2 oversized contents and overflowing snapshots fail without truncation', async () => {
    const f = await fixture(), d = await activate(f), long = await notification(f, {content: 'x'.repeat(8001)});
    assert.equal((await requestN2('/device/notifications', {auth: d.auth})).error.code, 'SNAPSHOT_LIMIT_EXCEEDED');
    await prisma.publication.delete({where: {id: long.id}});
    for (let i = 0; i < 501; i++) await notification(f);
    const response = await requestN2('/device/notifications', {auth: d.auth});
    assert.equal(response.status, 503);
    assert.equal(response.error.code, 'SNAPSHOT_LIMIT_EXCEEDED');
    assert.equal(await prisma.npepNotificationSnapshot.count({where: {deviceId: d.deviceId}}), 0);
  });

  await t.test('strict request boundary and separate auth domains', async () => {
    assert.equal((await request('/info', {headers: {'X-NPEP-Version': 'old'}})).status, 426);
    assert.equal((await request('/pairings', {raw: '{"requestId":"' + randomUUID() + '","requestId":"' + randomUUID() + '"}'})).status, 400);
    assert.equal((await request('/pairings', {raw: ' '.repeat(17000)})).status, 413);
    const f = await fixture(), p = await pending();
    assert.equal((await request(`/schools/${f.school.id}/devices`, {auth: f.legacyAdmin})).status, 401);
    assert.equal((await request('/device/me', {auth: p.auth})).status, 401);
    assert.equal((await request(`/pairings/${p.pairingId}`, {auth: `npepp1.${p.pairingId}.${secret()}`})).status, 401);
    const before = await request(`/pairings/${p.pairingId}/confirm`, {auth: p.auth, body: req({...identity, approvalId: randomUUID(), credentialId: randomUUID(), deviceSecret: secret()})});
    assert.equal(before.error.code, 'PAIRING_STATE_CONFLICT');
    assert.equal((await request('/pairings', {body: {...p.body, requestedCapabilities: ['notification.deliver']}})).status, 403);
    await prisma.schoolMember.update({where: {schoolId_accountId: {schoolId: f.school.id, accountId: f.account.id}}, data: {role: 'VIEWER'}});
    assert.equal((await request(`/schools/${f.school.id}/devices`, {auth: f.admin})).status, 403);
  });
  await t.test('idempotent activation recovery does not renew or reset, cross-school objects stay hidden', async () => {
    const f = await fixture(), other = await fixture(), d = await activate(f);
    assert.equal((await request('/pairings', {body: d.p.body})).status, 200);
    assert.equal((await request('/pairings', {body: {...d.p.body, deviceName: 'changed'}})).error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal((await request(`/schools/${other.school.id}/devices/${d.deviceId}/revoke`, {auth: other.admin, body: req({expectedBindingRevision: 1})})).status, 404);
    const session = await open(d);
    const first = await request('/device/status', {auth: d.auth, body: sample(session)});
    assert.equal(first.status, 200);
    const replay = await request(`/pairings/${d.p.pairingId}/confirm`, {auth: d.p.auth, body: d.body});
    assert.equal(replay.status, 200);
    assert.equal(replay.data.statusEpoch, 1);
    assert.equal(replay.data.credentialExpiresAt, d.credentialExpiresAt);
    assert.equal((await request(`/pairings/${d.p.pairingId}/confirm`, {auth: d.p.auth, body: {...d.body, deviceSecret: secret()}})).error.code, 'IDEMPOTENCY_CONFLICT');
    await prisma.npepPairing.update({where: {id: d.p.pairingId}, data: {expiresAt: new Date(Date.now() - 1)}});
    assert.equal((await request(`/pairings/${d.p.pairingId}/confirm`, {auth: d.p.auth, body: d.body})).status, 410);
    assert.equal((await request('/device/me', {auth: d.auth})).status, 200);
    const stored = await prisma.npepDevice.findUnique({where: {id: d.deviceId}});
    assert.equal(stored.lastSeenAt.toISOString(), first.data.receivedAt);
    assert.ok(!JSON.stringify(stored).includes(d.body.deviceSecret));
    const listing = await request(`/schools/${f.school.id}/devices`, {auth: f.admin});
    assert.equal(validate('deviceList', listing.data), true);
    assert.ok(!JSON.stringify(listing).includes(d.body.deviceSecret));
    assert.equal(listing.data.items[0].status.recording, 'IDLE');
  });
  await t.test('sequence, duplicate freshness and superseded session fencing', async () => {
    const f = await fixture(), d = await activate(f), s = await open(d), body = sample(s, 3);
    const applied = await request('/device/status', {auth: d.auth, body});
    assert.equal(applied.status, 200);
    await delay(5);
    const duplicate = await request('/device/status', {auth: d.auth, body});
    assert.equal(duplicate.data.disposition, 'DUPLICATE');
    assert.equal(duplicate.data.receivedAt, applied.data.receivedAt);
    assert.equal((await request('/device/status', {auth: d.auth, body: {...body, requestId: randomUUID()}})).error.code, 'SEQUENCE_CONFLICT');
    assert.equal((await request('/device/status', {auth: d.auth, body: sample(s, 1)})).error.code, 'STALE_SEQUENCE');
    const next = await open(d, 1);
    assert.equal((await request('/device/sessions', {auth: d.auth, body: s.body})).error.code, 'SESSION_SUPERSEDED');
    assert.equal((await request('/device/status', {auth: d.auth, body: sample(s, 9)})).error.code, 'SESSION_SUPERSEDED');
    assert.equal((await request('/device/sessions', {auth: d.auth, body: next.body})).status, 200);
    const row = await prisma.npepDevice.findUnique({where: {id: d.deviceId}});
    assert.equal(row.lastSeenAt, null); assert.equal(row.status, null);
    await request('/device/status', {auth: d.auth, body: sample(next)});
    await prisma.npepDevice.update({where: {id: d.deviceId}, data: {lastSeenAt: new Date(Date.now() - 61000)}});
    const listing = await request(`/schools/${f.school.id}/devices`, {auth: f.admin});
    assert.equal(listing.data.items[0].connectivity, 'OFFLINE');
  });
  await t.test('simultaneous confirms serialize one active slot and credential collision never overwrites', async () => {
    const f = await fixture(), p1 = await pending(), p2 = await pending(), a1 = await approve(f, p1), a2 = await approve(f, p2);
    const confirm = (p, a) => request(`/pairings/${p.pairingId}/confirm`, {auth: p.auth, body: req({...identity, approvalId: a.approvalId, credentialId: randomUUID(), deviceSecret: secret()})});
    const result = await Promise.all([confirm(p1, a1), confirm(p2, a2)]);
    assert.deepEqual(result.map(r => r.status).sort(), [201, 409]);
    assert.equal(result.find(r => r.status === 409).error.code, 'BINDING_OCCUPIED');
    const f2 = await fixture(), d = await activate(f2), f3 = await fixture(), p3 = await pending(), a3 = await approve(f3, p3);
    const collision = await request(`/pairings/${p3.pairingId}/confirm`, {auth: p3.auth, body: req({...identity, approvalId: a3.approvalId, credentialId: d.body.credentialId, deviceSecret: secret()})});
    assert.equal(collision.error.code, 'CREDENTIAL_ID_CONFLICT');
    assert.equal((await request('/device/me', {auth: d.auth})).status, 200);
  });
  await t.test('approver logout or demotion before confirmation prevents activation; logout after activation does not', async () => {
    for (const change of ['logout', 'demote', 'disable']) {
      const f = await fixture(), p = await pending(), a = await approve(f, p);
      if (change === 'logout') await prisma.accountSession.update({where: {id: f.session.id}, data: {revokedAt: new Date()}});
      if (change === 'demote') await prisma.schoolMember.update({where: {schoolId_accountId: {schoolId: f.school.id, accountId: f.account.id}}, data: {role: 'VIEWER'}});
      if (change === 'disable') await prisma.account.update({where: {id: f.account.id}, data: {localDisabled: true}});
      const result = await request(`/pairings/${p.pairingId}/confirm`, {auth: p.auth, body: req({...identity, approvalId: a.approvalId, credentialId: randomUUID(), deviceSecret: secret()})});
      assert.equal(result.error.code, 'APPROVER_NO_LONGER_AUTHORIZED');
    }
    const f = await fixture(), d = await activate(f);
    await prisma.accountSession.update({where: {id: f.session.id}, data: {revokedAt: new Date()}});
    assert.equal((await request('/device/me', {auth: d.auth})).status, 200);
  });
  await t.test('binding/class/term invalidation is irreversible but browser token reset is independent', async () => {
    for (const kind of ['binding', 'class', 'term', 'rebind', 'delete']) {
      const f = await fixture(), d = await activate(f);
      await prisma.classroomScreenBinding.update({where: {id: f.binding.id}, data: {credentialVersion: {increment: 1}, tokenHash: randomBytes(32).toString('hex')}});
      assert.equal((await request('/device/me', {auth: d.auth})).status, 200);
      if (kind === 'binding') {
        await prisma.classroomScreenBinding.update({where: {id: f.binding.id}, data: {isActive: false}});
        await prisma.classroomScreenBinding.update({where: {id: f.binding.id}, data: {isActive: true}});
      } else if (kind === 'class') {
        await prisma.workspace.update({where: {id: f.workspace.id}, data: {isActive: false}});
        await prisma.workspace.update({where: {id: f.workspace.id}, data: {isActive: true}});
      } else if (kind === 'term') {
        await prisma.academicTerm.update({where: {id: f.term.id}, data: {status: 'ARCHIVED'}});
        await prisma.academicTerm.update({where: {id: f.term.id}, data: {status: 'ACTIVE'}});
      } else if (kind === 'rebind') {
        const other = await prisma.workspace.create({data: {termId: f.term.id, name: '其他班', code: 'OTHER', type: 'ADMIN_CLASS'}});
        await prisma.classroomScreenBinding.update({where: {id: f.binding.id}, data: {administrativeClassId: other.id}});
        await prisma.classroomScreenBinding.update({where: {id: f.binding.id}, data: {administrativeClassId: f.workspace.id}});
      } else await prisma.classroomScreenBinding.delete({where: {id: f.binding.id}});
      assert.equal((await request('/device/me', {auth: d.auth})).status, 401);
      assert.equal((await prisma.npepDevice.findUnique({where: {id: d.deviceId}})).state, 'INVALIDATED');
    }
  });
  await t.test('confirmation rechecks demotion, logout and expiry after real lock waits', async () => {
    for (const scenario of ['demotion', 'logout', 'expiry']) {
      const f = await fixture(), p = await pending(), a = await approve(f, p);
      const body = req({...identity, approvalId: a.approvalId, credentialId: randomUUID(), deviceSecret: secret()});
      if (scenario === 'expiry') await prisma.npepPairing.update({where: {id: p.pairingId}, data: {expiresAt: new Date(Date.now() + 120)}});
      await observer.query('BEGIN');
      if (scenario === 'logout') await observer.query('SELECT id FROM "AccountSession" WHERE id=$1 FOR UPDATE', [f.session.id]);
      else await observer.query('SELECT id FROM "School" WHERE id=$1 FOR UPDATE', [f.school.id]);
      const waiting = request(`/pairings/${p.pairingId}/confirm`, {auth: p.auth, body});
      await delay(scenario === 'expiry' ? 180 : 80);
      if (scenario === 'demotion') await observer.query('UPDATE "SchoolMember" SET role=\'VIEWER\' WHERE "schoolId"=$1 AND "accountId"=$2', [f.school.id, f.account.id]);
      if (scenario === 'logout') await observer.query('UPDATE "AccountSession" SET "revokedAt"=clock_timestamp() WHERE id=$1', [f.session.id]);
      await observer.query('COMMIT');
      const result = await waiting;
      assert.equal(result.error.code, scenario === 'expiry' ? 'PAIRING_EXPIRED' : 'APPROVER_NO_LONGER_AUTHORIZED');
      assert.equal(await prisma.npepDevice.count({where: {screenBindingId: f.binding.id}}), 0);
    }
  });
  await t.test('queued heartbeat behind committed revocation cannot write lastSeen', async () => {
    const f = await fixture(), d = await activate(f), s = await open(d);
    await observer.query('BEGIN');
    await observer.query('SELECT id FROM "ClassroomScreenBinding" WHERE id=$1 FOR UPDATE', [f.binding.id]);
    const waiting = request('/device/status', {auth: d.auth, body: sample(s)});
    await delay(100);
    await observer.query('UPDATE "ClassroomScreenBinding" SET "isActive"=false WHERE id=$1', [f.binding.id]);
    await observer.query('COMMIT');
    assert.equal((await waiting).status, 401);
    assert.equal((await prisma.npepDevice.findUnique({where: {id: d.deviceId}})).lastSeenAt, null);
    const f2 = await fixture(), d2 = await activate(f2), s2 = await open(d2);
    const [heartbeat, revoked] = await Promise.all([request('/device/status', {auth: d2.auth, body: sample(s2)}), request(`/schools/${f2.school.id}/devices/${d2.deviceId}/revoke`, {auth: f2.admin, body: req({expectedBindingRevision: 1})})]);
    assert.ok([200, 401].includes(heartbeat.status)); assert.equal(revoked.status, 200);
    assert.equal((await request('/device/status', {auth: d2.auth, body: sample(s2, 2)})).status, 401);
    assert.equal((await request(`/pairings/${d2.p.pairingId}/confirm`, {auth: d2.p.auth, body: d2.body})).status, 401);
  });
  await t.test('rate quota is shared between independent service instances', async () => {
    const first = createNpepService(prisma, deployment), second = createNpepService(prisma, deployment), identity = randomUUID();
    const responses = await Promise.allSettled(Array.from({length: 10}, (_, i) => (i % 2 ? first : second).rate('test-shared', identity, 5, 3600)));
    assert.equal(responses.filter(r => r.status === 'fulfilled').length, 5);
    assert.equal(responses.filter(r => r.status === 'rejected' && r.reason.code === 'RATE_LIMITED').length, 5);
    await first.pollRate(identity);
    await assert.rejects(second.pollRate(identity), {code: 'RATE_LIMITED'});
  });
  await t.test('rate quota is atomic across two actual Node processes', async () => {
    const key = randomUUID();
    const code = `import {prisma} from './utils/prisma.js'; import {createNpepService} from './services/npepService.js';
      const service=createNpepService(prisma,()=>({}));
      const results=await Promise.allSettled(Array.from({length:5},()=>service.rate('multi-process','${key}',5,3600)));
      console.log(JSON.stringify(results.map(r=>r.status==='fulfilled'?'ok':r.reason.code)));await prisma.$disconnect();`;
    const child = () => new Promise((resolve, reject) => {
      const processHandle = spawn(process.execPath, ['--input-type=module', '-e', code], {cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe']});
      let output = '';
      processHandle.stdout.on('data', chunk => { output += chunk; });
      processHandle.on('error', reject);
      processHandle.on('close', exitCode => { if (exitCode) reject(new Error('rate worker failed')); else resolve(JSON.parse(output.trim())); });
    });
    const values = (await Promise.all([child(), child()])).flat();
    assert.equal(values.filter(v => v === 'ok').length, 5);
    assert.equal(values.filter(v => v === 'RATE_LIMITED').length, 5);
  });
  await t.test('school migration package excludes pairing, device secrets and device authorization', async () => {
    const f = await fixture(), d = await activate(f);
    await prisma.schoolMember.update({where: {schoolId_accountId: {schoolId: f.school.id, accountId: f.account.id}}, data: {role: 'OWNER'}});
    const {createSchoolMigrationPackage, decryptMigrationPackage} = await import('../services/schoolMigrationService.js');
    const passphrase = randomBytes(32).toString('base64url');
    const exported = await createSchoolMigrationPackage({managerAccountId: f.account.id, schoolId: f.school.id, confirmationSchoolCode: f.school.code, passphrase});
    const plain = JSON.stringify(await decryptMigrationPackage(exported.buffer, passphrase));
    const device = await prisma.npepDevice.findUnique({where: {id: d.deviceId}});
    const pair = await prisma.npepPairing.findUnique({where: {id: d.p.pairingId}});
    for (const forbidden of [d.deviceId, d.body.credentialId, d.body.deviceSecret, d.p.body.pairingSecret, device.secretHash, pair.secretHash]) {
      assert.equal(plain.includes(forbidden), false);
    }
  });
  await t.test('bounded maintenance deletes expired pairing secrets and receipts but preserves current devices', async () => {
    const {cleanupNpep} = await import('../services/npepMaintenanceService.js');
    const f = await fixture(), d = await activate(f), p = await pending();
    // Maintenance uses the database clock. Docker's clock may differ from the
    // host, so expire this fixture in the same clock domain as the SQL predicate.
    const [expired] = await prisma.$queryRaw`UPDATE "NpepPairing"
      SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=${p.pairingId}::uuid
      RETURNING "expiresAt" < clock_timestamp() AS expired`;
    assert.equal(expired.expired, true);
    await cleanupNpep(prisma);
    assert.equal((await prisma.npepPairing.findUnique({where: {id: p.pairingId}})).secretHash, null);
    assert.equal((await request('/device/me', {auth: d.auth})).status, 200);
    assert.equal(await prisma.$executeRaw`UPDATE "NpepPairing"
      SET "expiresAt"=clock_timestamp()-interval '2 days' WHERE id=${p.pairingId}::uuid`, 1);
    await cleanupNpep(prisma);
    assert.equal(await prisma.npepPairing.findUnique({where: {id: p.pairingId}}), null);
  });
  await t.test('external epoch blocks restored authorization rows and explicit recovery revokes them', async () => {
    const f = await fixture(), d = await activate(f);
    const project = process.env.INTEGRATION_COMPOSE_PROJECT;
    assert.match(project || '', /^npclassworks-(?:integration-\d+|npep-n1)$/);
    const container = `${project}-postgres-1`;
    const backup = spawnSync('docker', ['exec', container, 'pg_dump', '-U', decodeURIComponent(url.username), '-d', url.pathname.slice(1), '-Fc', '-t', 'public."NpepDevice"', '-t', 'public."NpepDeployment"', '-t', 'public."NpepNotificationSnapshot"', '-t', 'public."NpepNotificationExposure"', '-t', 'public."NpepNotificationReceipt"'], {maxBuffer: 32 * 1024 * 1024});
    assert.equal(backup.status, 0, 'isolated pg_dump must succeed');
    const closed = await closeBeforeRestore(gateFile);
    assert.equal((await request('/device/me', {auth: d.auth})).status, 503);
    await prisma.npepDevice.update({where: {id: d.deviceId}, data: {state: 'REVOKED'}});
    const restored = spawnSync('docker', ['exec', '-i', container, 'pg_restore', '-U', decodeURIComponent(url.username), '-d', url.pathname.slice(1), '--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error'], {input: backup.stdout, maxBuffer: 32 * 1024 * 1024});
    assert.equal(restored.status, 0, 'isolated pg_restore must succeed: ' + restored.stderr.toString());
    assert.equal((await prisma.npepDevice.findUnique({where: {id: d.deviceId}})).state, 'ACTIVE', 'the dump really restored the old active credential');
    await writeFile(gateFile, JSON.stringify({...closed, enabled: true}));
    assert.equal((await request('/device/me', {auth: d.auth})).status, 503);
    await writeFile(gateFile, JSON.stringify(closed));
    await activateDeployment(prisma, gateFile);
    assert.equal((await request('/info')).status, 200);
    assert.equal((await request('/device/me', {auth: d.auth})).status, 401);
    assert.equal((await prisma.npepDevice.findUnique({where: {id: d.deviceId}})).state, 'INVALIDATED');
    assert.equal(JSON.parse(await readFile(gateFile, 'utf8')).enabled, true);
  });
});
