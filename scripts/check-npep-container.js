// Uses only a uniquely named disposable image/volume; never production Compose up.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const name = `npclassworks-npep-check-${randomUUID()}`;
const image = `${name}:test`, volume = `${name}-config`;
let built = false, created = false;
let networkCreated = false, databaseCreated = false, backendCreated = false;
const network = `${name}-network`, database = `${name}-db`, backend = `${name}-backend`;
function docker(args, expected = 0, env = process.env, input) {
  const result = spawnSync('docker', args, {env, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (result.error) throw result.error;
  if (expected === 0 && result.status !== 0) throw new Error(`Disposable Docker check failed: ${result.stderr}`);
  if (expected !== 0) {
    assert.equal(result.status, expected, 'configuration rejection must not be a Docker launch failure');
    if (args.includes('scripts/npep-config.js')) assert.match(result.stderr, /NPEP configuration operation failed/);
  }
  return result.stdout;
}
try {
  for (const file of ['docker-compose.yml', 'docker-compose.shared.yml']) {
    for (const enabled of ['false', 'true']) {
      const config = JSON.parse(docker(['compose', '--env-file', 'deploy/.env.production.example', '-f', file, 'config', '--format', 'json'], 0, {...process.env, NPEP_ENABLED: enabled}));
      assert.equal(config.services.backend.environment.NPEP_ENABLED, enabled);
      assert.equal(config.services.backend.environment.NPEP_DEPLOYMENT_FILE, '/var/lib/npclassworks-npep/deployment.json');
      assert.ok(config.services.backend.volumes.some(v => v.type === 'volume' && v.source === 'npep-config' && v.target === '/var/lib/npclassworks-npep'));
    }
  }
  const source = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.ok(source.includes('COPY . .'));
  // Exercise the real Dockerfile with root-owned restrictive checkout contents.
  docker(['build', '-f', '-', '-t', image, '.'], 0, process.env,
    source.replace('COPY . .', 'COPY . .\nRUN chmod -R go-rwx /app'));
  built = true;
  docker(['volume', 'create', volume]);
  created = true;
  const run = (enabled, args, expected = 0, options = []) => docker(['run', '--rm', '--network', 'none',
    '-v', `${volume}:/var/lib/npclassworks-npep${options.includes('--read-only') ? ':ro' : ''}`, '-e', `NPEP_ENABLED=${enabled}`,
    '-e', 'NPEP_DEPLOYMENT_FILE=/var/lib/npclassworks-npep/deployment.json', ...options, image, ...args], expected);
  const helper = (...args) => ['node', 'scripts/npep-config.js', ...args];
  run('false', helper('check'));
  run('false', ['node', '--input-type=module', '-e', `import fs from 'node:fs'; import assert from 'node:assert/strict';
    for (const p of ['/app/package.json','/app/scripts/npep-config.js']) {
      assert.equal(fs.statSync(p).uid,0); fs.accessSync(p,fs.constants.R_OK);
      assert.throws(()=>fs.accessSync(p,fs.constants.W_OK));
    }`]);
  docker(['network', 'create', '--internal', network]); networkCreated = true;
  docker(['run', '-d', '--name', database, '--network', network,
    '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_PASSWORD=isolated-test-only',
    '-e', 'POSTGRES_DB=npep_startup', 'postgres:17-alpine']); databaseCreated = true;
  let databaseReady = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (spawnSync('docker', ['exec', database, 'pg_isready', '-U', 'postgres', '-d', 'npep_startup'], {stdio: 'ignore'}).status === 0) {
      databaseReady = true; break;
    }
    await delay(1000);
  }
  assert.ok(databaseReady, 'isolated PostgreSQL must start');
  const fakeEnv = {
    DATABASE_URL: `postgresql://postgres:isolated-test-only@${database}:5432/npep_startup`,
    BASE_URL: 'https://api.example.invalid', FRONTEND_URL: 'https://example.invalid',
    NPEP_ENABLED: 'false', NPEP_DEPLOYMENT_FILE: '/var/lib/npclassworks-npep/deployment.json',
    JWT_SECRET: randomUUID(), REFRESH_TOKEN_SECRET: randomUUID(),
    METRICS_TOKEN: randomUUID(), BOOTSTRAP_SETUP_KEY: randomUUID(),
  };
  docker(['run', '-d', '--name', backend, '--network', network,
    ...Object.entries(fakeEnv).flatMap(([key, value]) => ['-e', `${key}=${value}`]), image]); backendCreated = true;
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const result = spawnSync('docker', ['exec', backend, 'node', '-e',
      "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"], {stdio: 'ignore', timeout: 5000});
    if (result.status === 0) { ready = true; break; }
    await delay(1000);
  }
  assert.ok(ready, `Original production CMD failed: ${docker(['logs', '--tail', '100', backend])}`);
  console.log('Restricted real image: original config check, migrations, server and /ready passed with isolated PostgreSQL');
  run('true', helper('check'), 1);
  run('false', helper('init'));
  run('false', helper('init'), 1);
  run('true', helper('check'));
  run('true', helper('prepare-restore', 'false'), 1);
  run('false', helper('prepare-restore', 'true'), 1);
  run('false', ['node', '--input-type=module', '-e', `import assert from 'node:assert/strict';
    import {checkConfig,prepareRestore} from './scripts/npep-config.js';
    assert.notEqual(process.getuid(),0);
    const before=await checkConfig(process.env); await prepareRestore(process.env,'false');
    const after=await checkConfig(process.env); assert.equal(after.enabled,false);
    assert.equal(before.serverInstanceId,after.serverInstanceId); assert.notEqual(before.deploymentEpoch,after.deploymentEpoch);`]);
  run('true', helper('check'), 1, ['--read-only']);
  run('false', ['node', 'scripts/missing-npep-helper.js'], 1);
  run('false', ['chmod', '500', '/var/lib/npclassworks-npep']);
  run('true', helper('check'), 1);
  run('false', ['chmod', '700', '/var/lib/npclassworks-npep']);
  console.log('NPEP production Compose, image user, persistent directory, atomic write and fail-closed checks passed');
} finally {
  if (backendCreated) docker(['rm', '-f', '-v', backend]);
  if (databaseCreated) docker(['rm', '-f', '-v', database]);
  if (networkCreated) docker(['network', 'rm', network]);
  if (created) docker(['volume', 'rm', volume]);
  if (built) docker(['image', 'rm', image]);
}
