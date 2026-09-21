import {readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function writeAtomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
export async function closeBeforeRestore(path) {
  const original = JSON.parse(await readFile(path, 'utf8'));
  if (typeof original.enabled !== 'boolean' || !uuid.test(original.serverInstanceId) || !uuid.test(original.deploymentEpoch)) throw new Error('Invalid NPEP deployment identity');
  const closed = {...original, enabled: false, deploymentEpoch: randomUUID()};
  await writeAtomic(path, closed);
  return closed;
}
export function enabledFlag(value = 'false') {
  if (!['true', 'false'].includes(value)) throw new Error('NPEP_ENABLED must be true or false');
  return value === 'true';
}
export async function checkConfig(env, {expected, probe = true} = {}) {
  const enabled = enabledFlag(env.NPEP_ENABLED);
  if (expected !== undefined && enabledFlag(expected) !== enabled) throw new Error('NPEP host/container flags differ; refusing restore');
  const path = env.NPEP_DEPLOYMENT_FILE;
  if (!path) {
    if (enabled) throw new Error('NPEP_DEPLOYMENT_FILE is required');
    return null;
  }
  if (!isAbsolute(path)) throw new Error('NPEP_DEPLOYMENT_FILE must be absolute');
  let config;
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && !enabled) return null; throw new Error('NPEP configuration is missing or unreadable'); }
  if (typeof config.enabled !== 'boolean' || !uuid.test(config.serverInstanceId) || !uuid.test(config.deploymentEpoch)) throw new Error('Invalid NPEP configuration');
  if (probe) {
    const first = join(dirname(path), `.npep-check-${randomUUID()}`), second = `${first}.renamed`;
    try {
      await writeFile(first, '', {flag: 'wx', mode: 0o600});
      await rename(first, second);
      await unlink(second);
    } finally {
      await Promise.all([first, second].map(file => unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; })));
    }
  }
  return config;
}
export async function prepareRestore(env, expected) {
  if (expected === undefined) throw new Error('Expected host NPEP_ENABLED is required');
  const config = await checkConfig(env, {expected});
  // A previously enabled deployment must be fenced even if now disabled.
  if (config) await closeBeforeRestore(env.NPEP_DEPLOYMENT_FILE);
}
export async function initialize(env) {
  enabledFlag(env.NPEP_ENABLED);
  if (!env.NPEP_DEPLOYMENT_FILE || !isAbsolute(env.NPEP_DEPLOYMENT_FILE)) throw new Error('Absolute NPEP_DEPLOYMENT_FILE required');
  await writeFile(env.NPEP_DEPLOYMENT_FILE, JSON.stringify({enabled: false, serverInstanceId: randomUUID(), deploymentEpoch: randomUUID()}, null, 2) + '\n', {flag: 'wx', mode: 0o600});
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const command = process.argv[2];
    if (command === 'check') await checkConfig(process.env);
    else if (command === 'init') await initialize(process.env);
    else if (command === 'prepare-restore') await prepareRestore(process.env, process.argv[3]);
    else throw new Error('Use check, init, or prepare-restore <host-enabled>');
    console.log('NPEP configuration operation completed');
  } catch { console.error('NPEP configuration operation failed; check flags, identity and directory permissions'); process.exitCode = 1; }
}
