import assert from 'node:assert/strict';
import {randomUUID, randomBytes} from 'node:crypto';

export async function verifyDeviceOverviewDatabase(t, {fixture, request, prisma, activate, open, sample}) {
  await t.test('school device overview: real SQL totals, pagination, name search, current binding and authorization', async () => {
    const f = await fixture(), other = await fixture();
    const devices = [];
    for (let i = 0; i < 5; i++) {
      const binding = i === 0 ? f.binding : await prisma.classroomScreenBinding.create({data: {schoolId: f.school.id,
        administrativeClassId: f.workspace.id, name: `运维测试屏 ${i}`, tokenHash: randomBytes(32).toString('hex'), createdByAccountId: f.account.id}});
      const device = await activate({...f, binding}); devices.push(device);
      if (i < 3) {
        const session = await open(device);
        const body = sample(session);
        body.status.mode = 'EXAM'; body.status.examAware = {connection: 'READY', bridgeVersion: 'test'};
        assert.equal((await request('/device/status', {auth: device.auth, body})).status, 200);
      }
    }
    await prisma.npepDevice.update({where: {id: devices[2].deviceId}, data: {lastSeenAt: new Date(Date.now() - 120000)}});
    await prisma.npepDevice.update({where: {id: devices[4].deviceId}, data: {state: 'REVOKED'}});
    await activate(other);
    const path = `/schools/${f.school.id}/device-overview`;
    const first = await request(path + '?limit=1', {auth: f.admin});
    assert.equal(first.status, 200, first.error?.code);
    assert.deepEqual(first.data.summary, {total: 5, active: 4, online: 2, offline: 1, unreported: 1, attention: 2, inactive: 1});
    assert.equal(first.data.items.length, 1); assert.equal(first.data.matchedTotal, 5);
    const second = await request(path + '?limit=1&cursor=' + first.data.nextCursor, {auth: f.admin});
    assert.equal(second.status, 200); assert.notEqual(second.data.items[0].deviceId, first.data.items[0].deviceId);
    assert.deepEqual(second.data.summary, first.data.summary);
    const search = await request(path + '?filter=ATTENTION&search=' + encodeURIComponent('运维测试屏'), {auth: f.admin});
    assert.equal(search.status, 200); assert.equal(search.data.matchedTotal, 2); assert.deepEqual(search.data.summary, first.data.summary);
    assert.equal(JSON.stringify(search.data).includes('secretHash'), false);
    assert.equal(JSON.stringify(search.data).includes('credentialId'), false);
    assert.equal((await request(path, {auth: other.admin})).status, 403);
    assert.equal((await request(path, {auth: devices[0].auth})).status, 401);
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path + '?search=x&search=y', {auth: f.admin})).status, 400);
    assert.equal((await request(path + '?filter=INVALID', {auth: f.admin})).status, 400);
    assert.equal((await request(path + '?cursor=' + randomUUID() + '&limit=101', {auth: f.admin})).status, 400);
    await prisma.classroomScreenBinding.update({where: {id: devices[0].screenBindingId}, data: {npepBindingRevision: {increment: 1}}});
    const changed = await request(path + '?filter=INACTIVE', {auth: f.admin});
    assert.equal(changed.status, 200); assert.equal(changed.data.summary.inactive, 2);
    assert.equal(changed.data.items.find(item => item.deviceId === devices[0].deviceId).state, 'INVALIDATED');
  });
}
