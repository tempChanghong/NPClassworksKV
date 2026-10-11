import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDeviceOverview, readOverviewQuery} from '../domain/npep/deviceOverview.js';

const at = Date.parse('2026-10-04T04:00:00Z');
const config = {serverInstanceId: 'server', deploymentEpoch: 'epoch'};
const binding = {id: 'screen', name: '一班大屏', isActive: true, administrativeClassId: 'class', npepBindingRevision: 1,
  administrativeClass: {name: '高二一班', isActive: true, type: 'ADMIN_CLASS', term: {status: 'ACTIVE', schoolId: 'school'}}};
const status = {appVersion: 'test', mode: 'DAILY', modePhase: 'RUNNING', modeRevision: 1, recording: 'IDLE', automaticRecording: 'ENABLED',
  classIsland: {connection: 'READY', bridgeVersion: 'test'}, examAware: {connection: 'DISCONNECTED', bridgeVersion: null}};
const record = (id, extra = {}) => ({id, ...config, schoolId: 'school', administrativeClassId: 'class', screenBindingId: 'screen',
  deviceName: `设备 ${id}`, bindingRevision: 1, state: 'ACTIVE', credentialExpiresAt: new Date(at + 86400000),
  lastSeenAt: new Date(at), status, secretHash: 'NEVER_RETURN', credentialId: 'NEVER_RETURN', ...extra});
const view = (records, query = {}, bindings = [binding]) => buildDeviceOverview(records, bindings, config, readOverviewQuery(query), at);

test('overview school totals include all pages and filters, with a disjoint connection breakdown', () => {
  const records = [record('a'), record('b', {lastSeenAt: new Date(at - 60001)}), record('c', {lastSeenAt: null, status: null}), record('d', {state: 'REVOKED'})];
  const first = view(records, {limit: '1'});
  assert.deepEqual(first.summary, {total: 4, active: 3, online: 1, offline: 1, unreported: 1, attention: 2, inactive: 1});
  assert.equal(first.nextCursor, 'a'); assert.equal(first.matchedTotal, 4);
  // Direct builder cursor inputs allow simple deterministic IDs; HTTP validation uses UUIDs.
  const second = buildDeviceOverview(records, [binding], config, {limit: 1, cursor: 'a', filter: 'ALL', search: ''}, at);
  assert.equal(second.items[0].deviceId, 'b'); assert.deepEqual(second.summary, first.summary);
  const filtered = view(records, {filter: 'ATTENTION', search: '设备 b'});
  assert.equal(filtered.items.length, 1); assert.equal(filtered.matchedTotal, 1);
  assert.deepEqual(filtered.summary, first.summary);
  assert.deepEqual(view(records, {search: '高二一班'}).summary, first.summary);
  assert.equal(view(records, {search: '高二一班'}).matchedTotal, 4);
});

test('only the bridge required by the current mode is flagged; offline historical mode is not diagnosed', () => {
  assert.deepEqual(view([record('a')]).items[0].issues, []);
  assert.deepEqual(view([record('a', {status: {...status, mode: 'EXAM', classIsland: status.examAware, examAware: status.classIsland}})]).items[0].issues, []);
  assert.deepEqual(view([record('a', {status: {...status, mode: 'EXAM'}})]).items[0].issues, ['EXAMAWARE_NOT_CONNECTED']);
  assert.deepEqual(view([record('a', {lastSeenAt: new Date(at - 60001), status: {...status, mode: 'UNKNOWN', modePhase: 'INCOMPLETE', recording: 'UNKNOWN'}})]).items[0].issues, ['OFFLINE']);
  const partial = view([record('a', {status: {...status, mode: 'UNKNOWN', modePhase: 'INCOMPLETE', recording: 'UNKNOWN'}})]);
  assert.deepEqual(partial.items[0].issues, ['MODE_NOT_READY', 'MODE_INCOMPLETE', 'RECORDING_UNKNOWN']);
  assert.equal(partial.summary.attention, 1, 'several reasons still count one device');
});

test('expiry, deployment and current binding invalidate authorization without being runtime failures', () => {
  for (const extra of [{credentialExpiresAt: new Date(at)}, {deploymentEpoch: 'old'}, {bindingRevision: 0}, {administrativeClassId: 'old'}]) {
    const result = view([record('a', extra)], {filter: 'INACTIVE'});
    assert.equal(result.summary.inactive, 1); assert.equal(result.summary.attention, 0);
    assert.equal(result.items.length, 1);
  }
  for (const bindings of [[], [{...binding, isActive: false}], [{...binding, administrativeClass: {...binding.administrativeClass, term: {status: 'ARCHIVED', schoolId: 'school'}}}]]) {
    assert.equal(view([record('a')], {}, bindings).items[0].state, 'INVALIDATED');
  }
  assert.equal(view([record('a', {administrativeClassId: 'old'})], {search: '高二一班'}).matchedTotal, 0, 'old association must not search as the new class');
});

test('freshness boundary, future samples, secret exclusion and empty schools', () => {
  assert.equal(view([record('a', {lastSeenAt: new Date(at - 60000)})]).summary.online, 1);
  assert.equal(view([record('a', {lastSeenAt: new Date(at + 1)})]).summary.unreported, 1);
  const extra = {...status, deviceSecret: 'NEVER_RETURN', classIsland: {...status.classIsland, secret: 'NEVER_RETURN'}};
  assert.equal(JSON.stringify(view([record('a', {status: extra})])).includes('NEVER_RETURN'), false);
  assert.equal(view([]).summary.total, 0); assert.equal(view([]).nextCursor, null);
});

test('overview query rejects invalid pagination, enum, arrays, extra keys and oversized text', () => {
  for (const query of [{limit: '0'}, {limit: '101'}, {limit: ['20']}, {limit: '1.2'}, {cursor: 'bad'},
    {filter: 'offline'}, {filter: ['ONLINE']}, {search: ['a']}, {search: '中'.repeat(101)}, {schoolId: 'other'}]) {
    assert.throws(() => readOverviewQuery(query), {code: 'INVALID_REQUEST'});
  }
  assert.deepEqual(readOverviewQuery({search: '  教室  '}), {limit: 20, cursor: undefined, filter: 'ALL', search: '教室'});
});
