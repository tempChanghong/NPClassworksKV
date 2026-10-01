import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {validateDebugNpep, updateDebugNpepEnv} from '../scripts/prepare-debug-npep.js';

test('local NPEP setup refuses non-development databases and replacement identities', () => {
  const identityPath = resolve('deploy/runtime/npep-debug/deployment.json');
  const env = {NODE_ENV: 'development', DATABASE_URL: 'postgresql://local:example@127.0.0.1:5432/classworks_debug?schema=public'};
  assert.doesNotThrow(() => validateDebugNpep(env, identityPath));
  for (const changed of [
    {NODE_ENV: 'production'}, {NPEP_DEPLOYMENT_FILE: resolve('another/deployment.json')},
    {DATABASE_URL: env.DATABASE_URL.replace('127.0.0.1', 'example.com')},
    {DATABASE_URL: env.DATABASE_URL.replace('classworks_debug', 'production')},
    {DATABASE_URL: env.DATABASE_URL + '&host=example.com'},
  ]) assert.throws(() => validateDebugNpep({...env, ...changed}, identityPath));
});

test('local NPEP environment update preserves unrelated settings and is repeatable', () => {
  const source = '# local file\r\nJWT_SECRET="example # untouched"\r\nNODE_ENV=development\r\nNPEP_ENABLED=false\r\n';
  const identityPath = resolve('directory with spaces/deployment.json');
  const updated = updateDebugNpepEnv(source, identityPath);
  assert.equal(updateDebugNpepEnv(updated, identityPath), updated);
  assert.ok(updated.includes('JWT_SECRET="example # untouched"'));
  const env = parseEnv(updated);
  assert.equal(env.NPEP_ENABLED, 'true');
  assert.equal(env.NPEP_DEPLOYMENT_FILE, identityPath.replaceAll('\\', '/'));
  assert.equal(env.NODE_ENV, 'development');
});
