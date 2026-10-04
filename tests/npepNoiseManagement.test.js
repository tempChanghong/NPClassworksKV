import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateNoiseManagement} from '../domain/npep/noiseManagement.js';
import {validateDisplayReturn, validateDisplaySetting, validDisplayWindow, resolvedDisplayMinutes}
  from '../domain/npep/noiseDisplay.js';

const window = {start: '2026-10-04T19:00:00.000', end: '2026-10-04T20:00:00.000'};
const context = {identity: {serverInstanceId: randomUUID(), deploymentEpoch: randomUUID(),
  deviceId: randomUUID(), bindingRevision: 1, credentialGeneration: 1},
runId: randomUUID(), sessionId: randomUUID(), statusEpoch: 1, controlEpoch: randomUUID()};

test('0.8 management wire rejects extra authority and malformed school dates', () => {
  const status = {requestId: randomUUID(), context,
    protection: {instanceId: randomUUID(), revision: 2, sessionId: randomUUID(), window, protected: true}};
  assert.equal(validateNoiseManagement('status', status), true);
  assert.equal(validateNoiseManagement('status', {...status,
    context: {...context, controlEpoch: '00000000-0000-0000-0000-000000000000'}}), true);
  assert.equal(validateNoiseManagement('status', {...status, isAdmin: true}), false);
  assert.equal(validateNoiseManagement('status', {...status,
    context: {...context, identity: {...context.identity, credentialGeneration: 0}}}), false);
  assert.equal(validDisplayWindow({...window, start: '2026-02-30T19:00:00.000'}), false);
  assert.equal(validDisplayWindow({...window, start: '1999-10-04T19:00:00.000'}), false);
});

test('return window and grade/class duration are separate from schedule policy', () => {
  assert.equal(validateDisplayReturn({requestId: randomUUID(), window}), true);
  assert.equal(validateDisplayReturn({requestId: randomUUID(), window,
    offlineStartedAt: new Date().toISOString(), returnMinutes: 5}), true);
  assert.equal(validateDisplayReturn({requestId: randomUUID(), window, returnMinutes: 5}), false);
  assert.equal(validateDisplayReturn({requestId: randomUUID(), window, expiresAt: 'tomorrow'}), false);
  assert.equal(validateDisplaySetting({requestId: randomUUID(), termId: 'term', targetType: 'CLASS',
    targetId: 'class', expectedRevision: 0, returnMinutes: 5}), true);
  assert.deepEqual(resolvedDisplayMinutes([], 'grade', 'class'), {returnMinutes: 10, source: 'Default'});
  const grade = {targetType: 'GRADE', targetId: 'grade', returnMinutes: 5};
  const local = {targetType: 'CLASS', targetId: 'class', returnMinutes: 15};
  assert.deepEqual(resolvedDisplayMinutes([grade], 'grade', 'class'), {returnMinutes: 5, source: 'Grade'});
  assert.deepEqual(resolvedDisplayMinutes([grade, local], 'grade', 'class'), {returnMinutes: 15, source: 'Class'});
});
