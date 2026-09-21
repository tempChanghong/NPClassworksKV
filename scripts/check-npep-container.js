// Uses only a uniquely named disposable image/volume; never production Compose up.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
const name = `npclassworks-npep-check-${randomUUID()}`;
const image = `${name}:test`, volume = `${name}-config`;
let built = false, created = false;
function docker(args, expected = 0, env = process.env) {
  const result = spawnSync('docker', args, {env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
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
  docker(['build', '-t', image, '.']);
  built = true;
  docker(['volume', 'create', volume]);
  created = true;
  const run = (enabled, args, expected = 0, options = []) => docker(['run', '--rm', '--network', 'none',
    '-v', `${volume}:/var/lib/npclassworks-npep${options.includes('--read-only') ? ':ro' : ''}`, '-e', `NPEP_ENABLED=${enabled}`,
    '-e', 'NPEP_DEPLOYMENT_FILE=/var/lib/npclassworks-npep/deployment.json', ...options, image, ...args], expected);
  const helper = (...args) => ['node', 'scripts/npep-config.js', ...args];
  run('false', helper('check'));
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
  if (created) docker(['volume', 'rm', volume]);
  if (built) docker(['image', 'rm', image]);
}
