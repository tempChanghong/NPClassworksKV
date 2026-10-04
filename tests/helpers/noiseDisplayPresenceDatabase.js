import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {hash} from '../../domain/npep/wire.js';

export async function verifyNoiseDisplayPresenceDatabase(t, {fixture, request, prisma, req, activate, open, identity}) {
  await t.test('0.9 real HTTP/SQL display presence and shared return lease', async () => {
    const f = await fixture(), screenToken = randomUUID();
    await prisma.classroomScreenBinding.update({where: {id: f.binding.id},
      data: {tokenHash: hash(screenToken)}});
    const screen = {'X-Classworks-Screen-Token': screenToken};
    const d = await activate(f), session = await open(d);
    const context = {identity: {...identity, deviceId: d.deviceId,
      bindingRevision: d.bindingRevision, credentialGeneration: 1},
    runId: session.body.runId, sessionId: session.sessionId,
    statusEpoch: session.statusEpoch, controlEpoch: randomUUID()};
    const captureSessionId = randomUUID(), instanceId = randomUUID();
    const window = {start: '2026-10-04T19:00:00.000', end: '2026-10-04T20:00:00.000'};
    const call = (version, path, options = {}) => request(path,
      {...options, headers: {'X-NPEP-Version': version, ...options.headers}});
    const noise = {instanceId, revision: 2, sessionId: captureSessionId, state: 'Active',
      deviceName: '测试麦克风', configured: true, startedAt: new Date().toISOString(),
      currentDbfs: -55, quality: 'Good', summary: null, algorithm: 'pcm-energy-v1', uploadError: null};
    const schedule = {capability: 'noise.schedule', version: null, source: 'None',
      owner: 'Schedule', reason: 'WINDOW_ACTIVE', schoolNow: '2026-10-04T19:01:00.000',
      clockReady: true, dateNeedsReview: false, window, next: null,
      sessionId: captureSessionId, leaseRemainingSeconds: 3600, receipt: null};
    assert.equal((await call('0.6', '/device/noise-exchange', {auth: d.auth,
      body: req({context, sequence: 1, status: noise, receipts: [], reports: []})})).status, 200);
    assert.equal((await call('0.7', '/device/noise-schedule', {auth: d.auth,
      body: req({context, sequence: 1, status: schedule})})).status, 200);
    const scope = {instanceId, revision: 2, captureSessionId, window};
    const observe = extra => call('0.9', '/device/noise-display/observe', {auth: d.auth,
      body: req({context, ...scope, ...extra})});
    const heartbeat = (state, extra = {}) => call('0.9', '/screen/noise-display/presence',
      {headers: screen, body: req({displaySessionId, sequence: 1, state, ...scope, ...extra})});
    const displaySessionId = randomUUID();
    const initial = await observe();
    assert.equal(initial.status, 200, initial.error?.code);
    assert.deepEqual(initial.data.presence, {state: 'UNKNOWN', ageMs: null});
    assert.equal(initial.data.activeReturn, null);
    assert.equal((await heartbeat('RETURNING')).error.code, 'RETURN_LEASE_REQUIRED');
    const visible = req({displaySessionId, sequence: 1, state: 'DISPLAY_VISIBLE', ...scope});
    assert.equal((await call('0.9', '/screen/noise-display/presence',
      {headers: screen, body: visible})).status, 200);
    assert.equal((await observe()).data.presence.state, 'DISPLAY_VISIBLE');
    await prisma.npepNoiseDisplayPresence.update({where: {screenBindingId_displaySessionId: {
      screenBindingId: f.binding.id, displaySessionId}}, data: {receivedAt: new Date(Date.now() - 13000)}});
    assert.equal((await call('0.9', '/screen/noise-display/presence',
      {headers: screen, body: visible})).status, 200, 'exact retry is idempotent');
    assert.deepEqual((await observe()).data.presence, {state: 'UNKNOWN', ageMs: null},
      'duplicate sequence cannot renew freshness');
    assert.equal((await heartbeat('BLOCKED', {sequence: 2})).status, 200);
    assert.equal((await observe()).data.presence.state, 'BLOCKED');
    assert.equal((await heartbeat('HIDDEN', {sequence: 2})).error.code, 'SEQUENCE_CONFLICT');
    assert.equal((await observe({captureSessionId: randomUUID()})).error.code, 'DISPLAY_SESSION_CHANGED');
    assert.equal((await observe({context: {...context, runId: randomUUID()}})).error.code, 'SESSION_SUPERSEDED');
    const offlineStartedAt = new Date(Date.now() - 60000).toISOString();
    const returned = req({context, ...scope, offlineStartedAt, returnMinutes: 10});
    const first = await call('0.9', '/device/noise-display/return', {auth: d.auth, body: returned});
    assert.equal(first.status, 200, first.error?.code);
    assert.equal(first.data.activeReturn.requestId, returned.requestId);
    assert.equal(first.data.activeReturn.startedAt, offlineStartedAt);
    assert.equal(first.data.presence.state, 'RETURNING');
    const retry = await call('0.9', '/device/noise-display/return', {auth: d.auth, body: returned});
    assert.equal(retry.data.activeReturn.expiresAt, first.data.activeReturn.expiresAt);
    assert.equal((await heartbeat('RETURNING', {sequence: 3})).status, 200);
    assert.equal((await observe()).data.activeReturn.requestId, returned.requestId);
    const oldView = await call('0.8', '/screen/noise-display', {headers: screen});
    assert.equal(Object.hasOwn(oldView.data.activeReturn, 'requestId'), false,
      '0.8 return shape remains unchanged');
    assert.equal((await call('0.8', '/device/noise-display/observe',
      {auth: d.auth, body: req({context, ...scope})})).status, 426);
    await prisma.npepNoiseDisplayReturn.update({where: {screenBindingId_windowStart_windowEnd: {
      screenBindingId: f.binding.id, windowStart: window.start, windowEnd: window.end}},
    data: {expiresAt: new Date(Date.now() - 1000)}});
    const expiredRetry = await call('0.9', '/device/noise-display/return',
      {auth: d.auth, body: returned});
    assert.equal(expiredRetry.data.activeReturn.requestId, returned.requestId);
    assert.equal(expiredRetry.data.activeReturn.remainingSeconds, 0);
    assert.equal((await heartbeat('RETURNING', {sequence: 4})).error.code, 'RETURN_LEASE_REQUIRED');
    assert.deepEqual((await observe()).data.presence, {state: 'UNKNOWN', ageMs: null});
  });
}
