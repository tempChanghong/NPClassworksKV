import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import bcrypt from 'bcrypt';
import {hash} from '../../domain/npep/wire.js';

export async function verifyNoiseManagementDatabase(t, {fixture, request, prisma, req, activate, open, identity}) {
  const window = {start: '2026-10-04T19:00:00.000', end: '2026-10-04T20:00:00.000'};
  const call = (version, path, options = {}) => request(path,
    {...options, headers: {'X-NPEP-Version': version, ...options.headers}});
  await t.test('0.8 real HTTP/SQL return lease, settings, PIN and scheduled STOP authorization', async () => {
    const f = await fixture(), grade = await prisma.grade.create({data: {
      termId: f.term.id, code: 'TWO', name: '高二'}});
    await prisma.workspace.update({where: {id: f.workspace.id}, data: {gradeId: grade.id}});
    const screenToken = randomUUID(), screenPin = '725316';
    await prisma.classroomScreenBinding.update({where: {id: f.binding.id}, data: {
      tokenHash: hash(screenToken), pinHash: await bcrypt.hash(screenPin, 10)}});
    const screen = {'X-Classworks-Screen-Token': screenToken};
    const d = await activate(f), session = await open(d);
    const context = {identity: {...identity, deviceId: d.deviceId, bindingRevision: d.bindingRevision,
      credentialGeneration: 1}, runId: session.body.runId, sessionId: session.sessionId,
    statusEpoch: session.statusEpoch, controlEpoch: randomUUID()};
    const captureSession = randomUUID(), instanceId = randomUUID();
    const noiseStatus = {instanceId, revision: 2, sessionId: captureSession, state: 'Active',
      deviceName: '测试麦克风', configured: true, startedAt: new Date().toISOString(),
      currentDbfs: -55, quality: 'Good', summary: null, algorithm: 'pcm-energy-v1', uploadError: null};
    const scheduleStatus = {capability: 'noise.schedule', version: null, source: 'None',
      owner: 'Schedule', reason: 'WINDOW_ACTIVE', schoolNow: '2026-10-04T19:01:00.000',
      clockReady: true, dateNeedsReview: false, window, next: null, sessionId: captureSession,
      leaseRemainingSeconds: 3600, receipt: null};
    const exchange = await call('0.6', '/device/noise-exchange', {auth: d.auth,
      body: req({context, sequence: 1, status: noiseStatus, receipts: [], reports: []})});
    assert.equal(exchange.status, 200, exchange.error?.code);
    const schedule = await call('0.7', '/device/noise-schedule', {auth: d.auth,
      body: req({context, sequence: 1, status: scheduleStatus})});
    assert.equal(schedule.status, 200, schedule.error?.code);
    const protectedStatus = await call('0.8', '/device/noise-management/status', {auth: d.auth,
      body: req({context, protection: {instanceId, revision: 2, sessionId: captureSession,
        window, protected: true}})});
    assert.equal(protectedStatus.status, 200, protectedStatus.error?.code);
    const defaultView = await call('0.8', '/screen/noise-display', {headers: screen});
    assert.equal(defaultView.data.returnMinutes, 10);
    const setting = `/schools/${f.school.id}/noise-display-settings`;
    const gradeSaved = await call('0.8', setting, {auth: f.admin, body: req({
      termId: f.term.id, targetType: 'GRADE', targetId: grade.id,
      expectedRevision: 0, returnMinutes: 5})});
    assert.equal(gradeSaved.status, 200, gradeSaved.error?.code);
    assert.equal((await call('0.8', '/screen/noise-display', {headers: screen})).data.returnMinutes, 5);
    const classSaved = await call('0.8', setting, {auth: f.admin, body: req({
      termId: f.term.id, targetType: 'CLASS', targetId: f.workspace.id,
      expectedRevision: 0, returnMinutes: 15})});
    assert.equal(classSaved.status, 200, classSaved.error?.code);
    const returned = req({window});
    const first = await call('0.8', '/screen/noise-display/return', {headers: screen, body: returned});
    assert.equal(first.status, 200, first.error?.code);
    assert.equal(first.data.activeReturn.returnMinutes, 15);
    const repeated = await call('0.8', '/screen/noise-display/return', {headers: screen,
      body: req({window})});
    assert.equal(repeated.data.activeReturn.expiresAt, first.data.activeReturn.expiresAt);
    assert.equal((await call('0.8', setting + `?termId=${f.term.id}`, {auth: f.admin}))
      .data.settings.length, 2);
    assert.equal((await call('0.8', setting, {auth: f.admin, body: req({
      termId: f.term.id, targetType: 'CLASS', targetId: f.workspace.id,
      expectedRevision: 1, returnMinutes: 20})})).status, 200);
    assert.equal((await call('0.8', '/screen/noise-display', {headers: screen}))
      .data.activeReturn.returnMinutes, 15);
    await prisma.npepNoiseDisplayReturn.update({where: {
      screenBindingId_windowStart_windowEnd: {screenBindingId: f.binding.id,
        windowStart: window.start, windowEnd: window.end}},
    data: {expiresAt: new Date(Date.now() - 1000)}});
    assert.equal((await call('0.8', '/screen/noise-display/return', {headers: screen,
      body: returned})).data.activeReturn.remainingSeconds, 0);
    const offline = await call('0.8', '/screen/noise-display/return', {headers: screen,
      body: req({window, offlineStartedAt: new Date(Date.now() - 60000).toISOString(),
        returnMinutes: 15})});
    assert.equal(offline.data.activeReturn.returnMinutes, 15);
    assert.ok(offline.data.activeReturn.remainingSeconds < 15 * 60);
    const legacyStop = req({action: 'STOP', instanceId, revision: 2,
      sessionId: captureSession, durationSeconds: 10800});
    assert.equal((await call('0.6', '/screen/noise/commands', {headers: screen,
      body: legacyStop})).error.code, 'MANAGEMENT_REQUIRED');
    const stop = req({command: {action: 'STOP', instanceId, revision: 2,
      sessionId: captureSession, durationSeconds: 10800}, pin: '000000'});
    assert.equal((await call('0.8', '/screen/noise-management/commands', {headers: screen,
      body: stop})).error.code, 'SCREEN_PIN_INCORRECT');
    const approved = await call('0.8', '/screen/noise-management/commands', {headers: screen,
      body: {...stop, requestId: randomUUID(), pin: screenPin}});
    assert.equal(approved.status, 200, approved.error?.code);
    const commandId = approved.data.command.commandId;
    const authorize = req({context, commandId, instanceId, revision: 2, sessionId: captureSession});
    assert.equal((await call('0.8', '/device/noise-management/authorize', {auth: d.auth,
      body: authorize})).data.authorized, true);
    assert.equal((await call('0.8', '/device/noise-management/authorize', {auth: d.auth,
      body: {...authorize, context: {...context, runId: randomUUID()}}})).error.code, 'SESSION_SUPERSEDED');
    assert.equal((await call('0.8', '/device/noise-management/authorize', {auth: d.auth,
      body: {...authorize, sessionId: randomUUID()}})).error.code, 'MANAGEMENT_REQUIRED');
    const aggregate = await prisma.npepNoiseDevice.findUnique({where: {deviceId: d.deviceId}});
    const expired = structuredClone(aggregate.data);
    expired.commands.find(item => item.command.commandId === commandId).command.expiresAt
      = new Date(Date.now() - 1000).toISOString();
    await prisma.npepNoiseDevice.update({where: {deviceId: d.deviceId}, data: {data: expired}});
    assert.equal((await call('0.8', '/device/noise-management/authorize', {auth: d.auth,
      body: {...authorize, requestId: randomUUID()}})).error.code, 'MANAGEMENT_REQUIRED');
    assert.equal((await call('0.7', '/device/noise-schedule', {auth: d.auth,
      body: req({context, sequence: 2, status: {...scheduleStatus,
        reason: 'EXAM_PAUSED', window: null, sessionId: null}})})).status, 200);
    assert.equal(await prisma.npepNoiseDisplayReturn.count({where: {screenBindingId: f.binding.id}}), 0);
  });
}
