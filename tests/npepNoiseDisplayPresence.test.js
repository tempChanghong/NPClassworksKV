import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateNoiseDisplayPresence} from '../domain/npep/noiseDisplayPresence.js';
import {selectDisplayPresence} from '../services/npepNoiseDisplayPresenceService.js';

const wire = JSON.parse(readFileSync(new URL('../domain/npep/noise-display-presence-wire-cases.json', import.meta.url)));
const clone = value => structuredClone(value);

test('0.9 fixture accepts exact screen, device observe and offline return wires', () => {
  assert.equal(wire.protocolVersion, '0.9');
  assert.equal(validateNoiseDisplayPresence('screenPresence', wire.screenPresence), true);
  assert.equal(validateNoiseDisplayPresence('observe', wire.deviceObserve), true);
  assert.equal(validateNoiseDisplayPresence('deviceReturn', wire.deviceReturn), true);
  const online = clone(wire.deviceReturn);
  delete online.offlineStartedAt;
  delete online.returnMinutes;
  assert.equal(validateNoiseDisplayPresence('deviceReturn', online), true);
  assert.deepEqual(Object.keys(wire.deviceReply),
    ['supported', 'serverNow', 'returnMinutes', 'presence', 'activeReturn']);
  assert.equal(wire.deviceReply.activeReturn.requestId, wire.deviceReturn.requestId);
});

test('0.9 wire rejects loose scope, extra fields and unpaired offline return', () => {
  const invalid = [
    ['screenPresence', {...wire.screenPresence, sequence: 0}],
    ['screenPresence', {...wire.screenPresence, state: 'VISIBLE'}],
    ['screenPresence', {...wire.screenPresence, clientNow: '2026-10-04T19:02:00.000Z'}],
    ['screenPresence', {...wire.screenPresence, displaySessionId: 'not-a-uuid'}],
    ['observe', {...wire.deviceObserve, revision: -1}],
    ['observe', {...wire.deviceObserve, context: {...wire.deviceObserve.context, surprise: true}}],
    ['deviceReturn', {...wire.deviceReturn, returnMinutes: 61}],
    ['deviceReturn', {...wire.deviceReturn, offlineStartedAt: 'not-a-date'}],
    ['deviceReturn', {...wire.deviceReturn, offlineStartedAt: '2026-10-04T19:01:00Z'}],
    ['deviceReturn', {...wire.deviceReturn, offlineStartedAt: '2026-02-30T19:01:00.000Z'}],
    ['deviceReturn', {...wire.deviceReturn, offlineStartedAt: undefined}],
    ['deviceReturn', {...wire.deviceReturn, returnMinutes: undefined}],
  ];
  for (const [name, value] of invalid)
    assert.equal(validateNoiseDisplayPresence(name, value), false, `${name} ${JSON.stringify(value)}`);
});

test('fresh browser visibility wins across tabs, and stale states age out', () => {
  const now = Date.parse('2026-10-04T19:02:00.000Z');
  const row = (state, age) => ({state, receivedAt: new Date(now - age)});
  assert.deepEqual(selectDisplayPresence([], now, null), {state: 'UNKNOWN', ageMs: null});
  assert.deepEqual(selectDisplayPresence([row('BLOCKED', 1000), row('DISPLAY_VISIBLE', 11000)], now, null),
    {state: 'DISPLAY_VISIBLE', ageMs: 11000});
  assert.deepEqual(selectDisplayPresence([row('BLOCKED', 2000), row('HIDDEN', 3000)], now, null),
    {state: 'BLOCKED', ageMs: 2000});
  assert.deepEqual(selectDisplayPresence([row('HIDDEN', 12000)], now, null),
    {state: 'HIDDEN', ageMs: 12000});
  assert.deepEqual(selectDisplayPresence([row('DISPLAY_VISIBLE', 12001)], now, null),
    {state: 'UNKNOWN', ageMs: null});
  assert.deepEqual(selectDisplayPresence([row('DISPLAY_VISIBLE', 1000)], now,
    {remainingSeconds: 10}), {state: 'RETURNING', ageMs: 0});
});
