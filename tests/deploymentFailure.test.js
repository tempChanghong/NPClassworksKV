import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, readdirSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {captureFailure, redact} from '../deploy/capture-failure.js';

test('failure diagnostics retain startup evidence privately without dumping environment', t => {
  const runtime = mkdtempSync(join(tmpdir(), 'deployment-failure-'));
  t.after(() => rmSync(runtime, {recursive: true, force: true}));
  const calls = [], id = 'a'.repeat(64);
  const env = {JWT_SECRET: 'secret"\nvalue', DATABASE_URL: 'postgresql://user:password@db/app'};
  const directory = captureFailure(['/repo', '/private/env', '/repo/compose.yml', runtime], {
    env,
    run(command, args, options) {
      calls.push({command, args});
      assert.equal(options.timeout, 10000);
      assert.equal(options.maxBuffer, 1024 * 1024);
      if (args.includes('ps')) return {status: 0, stdout: `${id}\nnot-an-id\n`, stderr: ''};
      if (args[0] === 'inspect') return {status: 0, stdout: '{"exitCode":1}', stderr: ''};
      return {status: 0, stdout: `EACCES helper\n${env.JWT_SECRET}\n${env.DATABASE_URL}`, stderr: ''};
    },
  });
  assert.equal(calls.length, 3);
  assert.equal(calls.some(call => call.args.some(arg => /Config.Env|Config.Cmd/.test(arg))), false);
  const logs = JSON.parse(readFileSync(join(directory, 'logs.json'), 'utf8'));
  assert.match(logs.stdout, /EACCES helper/);
  assert.equal(logs.stdout.includes(env.JWT_SECRET), false);
  assert.equal(logs.stdout.includes('password'), false);
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    for (const file of readdirSync(directory)) assert.equal(statSync(join(directory, file)).mode & 0o777, 0o600);
  }
});

test('diagnostic command failure is recorded and credentials in URLs are redacted', t => {
  const runtime = mkdtempSync(join(tmpdir(), 'deployment-failure-'));
  t.after(() => rmSync(runtime, {recursive: true, force: true}));
  const directory = captureFailure(['/repo', '/env', '/compose', runtime], {
    env: {}, run: () => ({status: null, error: {code: 'ETIMEDOUT'}, stdout: '', stderr: 'unavailable'}),
  });
  assert.equal(JSON.parse(readFileSync(join(directory, 'logs.json'))).error, 'ETIMEDOUT');
  assert.equal(redact('postgresql://user:pass@db/app', {}), 'postgresql://[REDACTED]@db/app');
});

test('real readiness failure branch captures evidence before rollback even if capture fails', () => {
  const source = readFileSync(new URL('../deploy/upgrade.sh', import.meta.url), 'utf8');
  const branch = source.slice(source.indexOf('if ! wait_for_backend 45;'), source.indexOf('# Publish only'));
  assert.ok(branch.includes('capture-failure.js'));
  const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  const result = spawnSync(shell, ['-s'], {encoding: 'utf8', input: `set -e
DEPLOY_DIR=/fake REPO_ROOT=/fake ENV_FILE=/fake/env COMPOSE_FILE=/fake/compose RUNTIME_DIR=/fake/runtime
rollback_on_failure=true
wait_for_backend() { return 1; }
node() { echo capture-attempt; return 1; }
bash() { echo rollback-attempt; }
log() { :; }
die() { echo failure-reported; exit 1; }
${branch}`});
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/), ['capture-attempt', 'rollback-attempt', 'failure-reported']);
});
