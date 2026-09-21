import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, rm, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {checkConfig, initialize, prepareRestore} from '../scripts/npep-config.js';

test('NPEP configuration is closed by default, rejects flag drift and fences disabled historical identities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'npep-config-'));
  const env = {NPEP_ENABLED: 'false', NPEP_DEPLOYMENT_FILE: join(dir, 'deployment.json')};
  try {
    assert.equal(await checkConfig(env), null);
    await prepareRestore(env, 'false');
    await assert.rejects(checkConfig({...env, NPEP_ENABLED: 'true'}), /missing/);
    await assert.rejects(checkConfig({...env, NPEP_ENABLED: 'yes'}), /true or false/);
    await assert.rejects(prepareRestore(env, 'true'), /flags differ/);
    await assert.rejects(prepareRestore({...env, NPEP_ENABLED: 'true'}, 'false'), /flags differ/);
    await assert.rejects(prepareRestore(env), /required/);
    const legacy = expected => spawnSync(process.execPath, ['scripts/npep-deployment.js', 'prepare-restore', ...expected], {env: {...process.env, ...env}, encoding: 'utf8'});
    assert.equal(legacy([]).status, 1, 'legacy CLI cannot silently skip without host flag');
    assert.equal(legacy(['true']).status, 1, 'legacy CLI must reject flag mismatch');
    await initialize(env);
    const first = await checkConfig(env);
    assert.equal(first.enabled, false);
    await assert.rejects(initialize(env), {code: 'EEXIST'});
    await writeFile(env.NPEP_DEPLOYMENT_FILE, JSON.stringify({...first, enabled: true}));
    await prepareRestore(env, 'false');
    const after = JSON.parse(await readFile(env.NPEP_DEPLOYMENT_FILE));
    assert.equal(after.enabled, false);
    assert.equal(after.serverInstanceId, first.serverInstanceId);
    assert.notEqual(after.deploymentEpoch, first.deploymentEpoch);
    assert.equal(legacy(['false']).status, 0);
    assert.notEqual(JSON.parse(await readFile(env.NPEP_DEPLOYMENT_FILE)).deploymentEpoch, after.deploymentEpoch);
    assert.deepEqual(await readdir(dir), ['deployment.json']);
    await writeFile(env.NPEP_DEPLOYMENT_FILE, '{}');
    await assert.rejects(prepareRestore(env, 'false'), /Invalid/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
