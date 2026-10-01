import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {createNpepRouter} from '../routes/v2/npep.js';
import {NpepError, UUID, validate} from '../domain/npep/wire.js';

test('NPEP early errors preserve request correlation without accessing the database', async t => {
  const client = {$transaction: () => { throw new Error('Database must not be called'); }};
  const app = express();
  app.use('/api/v2/npep', createNpepRouter({client, deployment: () => {
    throw new NpepError(503, 'TEMPORARILY_UNAVAILABLE');
  }}));
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}/api/v2/npep`;
  const cases = [
    {name: 'N1 disabled info', path: '/info', version: '0.1'},
    {name: 'N2 disabled polling', path: '/device/notifications', version: '0.2'},
    {name: 'N3 disabled polling', path: '/device/runtime-operations', version: '0.4'},
    {name: 'old N3 cannot silently gain startup authority', path: '/device/runtime-operations', version: '0.4', sentVersion: '0.3', status: 426, code: 'PROTOCOL_UNSUPPORTED'},
    {name: 'disabled POST with body ID only', path: '/pairings', version: '0.1', bodyOnly: true},
    {name: 'unsupported protocol', path: '/info', version: '0.1', sentVersion: '9.9', status: 426, code: 'PROTOCOL_UNSUPPORTED'},
    {name: 'malformed JSON', path: '/pairings', version: '0.1', raw: '{', status: 400, code: 'INVALID_REQUEST'},
    {name: 'oversized payload', path: '/pairings', version: '0.1', raw: ' '.repeat(17000), status: 413, code: 'PAYLOAD_TOO_LARGE'},
    {name: 'mismatched IDs', path: '/pairings', version: '0.1', mismatch: true, status: 400, code: 'INVALID_REQUEST'},
  ];
  for (const c of cases) await t.test(c.name, async () => {
    const id = randomUUID();
    const body = c.raw ?? (c.bodyOnly || c.mismatch ? JSON.stringify({requestId: id}) : undefined);
    const res = await fetch(origin + c.path, {
      method: body === undefined ? 'GET' : 'POST', body,
      headers: {'Content-Type': 'application/json', 'X-NPEP-Version': c.sentVersion ?? c.version,
        ...(!c.bodyOnly ? {'X-Request-Id': c.mismatch ? randomUUID() : id} : {})},
      signal: AbortSignal.timeout(5000),
    });
    const result = await res.json();
    assert.equal(res.status, c.status ?? 503);
    assert.equal(result.error.code, c.code ?? 'TEMPORARILY_UNAVAILABLE');
    assert.equal(result.requestId, id);
    assert.equal(result.protocolVersion, c.version);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    if (c.version === '0.1') assert.equal(validate('error', result), true);
  });
  await t.test('invalid header ID is not reflected in an early error', async () => {
    const res = await fetch(origin + '/info', {headers: {'X-Request-Id': 'invalid', 'X-NPEP-Version': '9.9'}});
    const result = await res.json();
    assert.equal(res.status, 426);
    assert.equal(UUID.test(result.requestId), true);
  });
});
