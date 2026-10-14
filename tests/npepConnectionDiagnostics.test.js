import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {connectionDiagnostics} from '../domain/npep/connectionDiagnostics.js';
import {createNpepRouter} from '../routes/v2/npep.js';

test('connection telemetry bounds volume, records slow/failed/aborted requests, and never exports arbitrary strings', () => {
  const entries = []; let ms = 0;
  const middleware = connectionDiagnostics({write: entry => entries.push(entry), clock: () => ms});
  function complete({status = 200, elapsed = 0, abort = false, path = '/device/status', code = 'TEMPORARILY_UNAVAILABLE', id = randomUUID()} = {}) {
    const res = new EventEmitter(); res.statusCode = status;
    const req = {path, npepDiagnosticError: code, get: () => id, body: {password: 'PRIVATE'}, headers: {authorization: 'PRIVATE'}};
    let next = 0; middleware(req, res, () => next++); assert.equal(next, 1);
    ms += elapsed; res.writableFinished = !abort; res.emit(abort ? 'close' : 'finish'); res.emit('close');
  }
  complete(); assert.equal(entries.length, 0);
  complete({elapsed: 2100}); assert.equal(entries.at(-1).outcome, 'Slow');
  complete({status: 503}); assert.equal(entries.at(-1).error, 'TEMPORARILY_UNAVAILABLE');
  complete({status: 401, code: 'AUTH_INVALID'}); assert.equal(entries.at(-1).error, 'AUTH_INVALID');
  complete({abort: true}); assert.equal(entries.at(-1).outcome, 'Aborted'); assert.equal(entries.at(-1).httpStatus, null);
  complete({status: 503, path: '/schools/PRIVATE/study-settings?secret=PRIVATE', code: 'PRIVATE', id: 'PRIVATE'});
  assert.equal(entries.at(-1).requestId, null); assert.equal(entries.at(-1).error, 'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE|password|authorization|secret=/);
  for (let i = 0; i < 125; i++) complete({status: 503});
  assert.equal(entries.length, 120);
  ms += 60000; complete({status: 503}); assert.equal(entries.length, 121); assert.equal(entries.at(-1).suppressedSinceLast, 10);
  let passed = false;
  const res = new EventEmitter(); res.statusCode = 503;
  connectionDiagnostics({write: () => { throw new Error('sink failure'); }})(
    {path: '/info', get: () => null}, res, () => { passed = true; });
  assert.doesNotThrow(() => res.emit('finish')); assert.equal(passed, true);
});

test('real NPEP router records redacted 503 correlation without leaking a database error or changing the wire reply', async t => {
  const entries = [], id = randomUUID();
  const app = express();
  app.use('/api/v2/npep', createNpepRouter({client: {$transaction() { throw new Error('PRIVATE database password'); }},
    deployment() { throw new Error('PRIVATE deployment path'); }, diagnosticLog: entry => entries.push(entry)}));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v2/npep/info`, {
    headers: {'X-NPEP-Version': '0.1', 'X-Request-Id': id, authorization: 'Bearer PRIVATE'}, signal: AbortSignal.timeout(5000)});
  const body = await response.json();
  assert.equal(response.status, 503); assert.equal(body.error.code, 'TEMPORARILY_UNAVAILABLE'); assert.equal(body.requestId, id);
  assert.equal(entries.length, 1); assert.equal(entries[0].requestId, id); assert.equal(entries[0].endpoint, 'Info');
  assert.doesNotMatch(JSON.stringify({entries, body}), /PRIVATE|password|authorization|deployment path/);
});
