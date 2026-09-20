import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {parseStrictJson, validate, digest, bearer, secretHash, displayText} from '../domain/npep/wire.js';

test('NPEP rejects duplicate/escaped keys, malformed UTF8, lone surrogates and deep JSON', () => {
  for (const value of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"a":{"x":1,"x":2}}', '[1,]', '"\\ud800"', '['.repeat(40) + '0' + ']'.repeat(40)]) {
    assert.throws(() => parseStrictJson(Buffer.from(value)), {code: 'INVALID_REQUEST'});
  }
  assert.throws(() => parseStrictJson(Buffer.from([0xff])), {code: 'INVALID_REQUEST'});
  assert.deepEqual(parseStrictJson(Buffer.from('{"x":[true,null,"😀",-2.5e3]}')), {x: [true, null, '😀', -2500]});
});

test('NPEP credentials require canonical decoded secrets and separate bearer types', () => {
  const id = randomUUID(), secret = randomBytes(32).toString('base64url');
  assert.equal(bearer(`Bearer npep1.${id}.${secret}`, 'npep1').hash, secretHash(secret));
  assert.throws(() => bearer(`Bearer npepp1.${id}.${secret}`, 'npep1'), {code: 'AUTH_INVALID'});
  assert.throws(() => secretHash('B'.repeat(43)), {code: 'AUTH_INVALID'});
  assert.throws(() => secretHash(secret + '='), {code: 'AUTH_INVALID'});
  assert.equal(digest({b: 1, a: {d: 1, c: 2}}), digest({a: {c: 2, d: 1}, b: 1}));
  assert.equal(displayText('\u0000测试\u202e名称'), '测试名称');
});

test('NPEP schemas restrict capability, fields, Unicode scalar counts and safe counters', () => {
  const value = {requestId: randomUUID(), installationId: randomUUID(), serverInstanceId: randomUUID(), deploymentEpoch: randomUUID(),
    deviceName: '😀'.repeat(64), appVersion: '1.0', pairingSecret: randomBytes(32).toString('base64url'), requestedCapabilities: ['device.status']};
  assert.equal(validate('createPairing', value), true);
  assert.equal(validate('createPairing', {...value, deviceName: '😀'.repeat(65)}), false);
  assert.equal(validate('createPairing', {...value, requestedCapabilities: ['classroom.mode.set']}), false);
  assert.equal(validate('createPairing', {...value, command: 'x'}), false);
  assert.equal(validate('revokeDevice', {requestId: randomUUID(), expectedBindingRevision: Number.MAX_SAFE_INTEGER}), true);
  assert.equal(validate('revokeDevice', {requestId: randomUUID(), expectedBindingRevision: Number.MAX_SAFE_INTEGER + 1}), false);
});
