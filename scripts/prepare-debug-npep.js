import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseEnv} from 'node:util';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {UUID} from '../domain/npep/wire.js';
import {initialize, writeAtomic} from './npep-config.js';

const root = fileURLToPath(new URL('../', import.meta.url));

export function validateDebugNpep(env, expectedIdentityPath) {
  const url = new URL(env.DATABASE_URL || '');
  if (env.NODE_ENV !== 'development' || !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1'].includes(url.hostname) || !['', '5432', '55432'].includes(url.port) ||
      url.pathname !== '/classworks_debug' || url.hash ||
      [...url.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')) {
    throw new Error('仅允许 development 下的本机 classworks_debug 数据库。');
  }
  if (env.NPEP_DEPLOYMENT_FILE && resolve(env.NPEP_DEPLOYMENT_FILE) !== expectedIdentityPath) {
    throw new Error('已有其他 NPEP 身份文件配置，请先核对；不会替换已有身份。');
  }
}

export function updateDebugNpepEnv(source, identityPath) {
  const values = {NPEP_ENABLED: 'true', NPEP_DEPLOYMENT_FILE: JSON.stringify(identityPath.replaceAll('\\', '/'))};
  let result = source;
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=.*$`, 'gm');
    result = pattern.test(result) ? result.replace(pattern, () => `${key}=${value}`)
      : result.trimEnd() + `\n${key}=${value}\n`;
  }
  return result;
}

export async function prepareDebugNpep() {
  const envPath = resolve(root, 'deploy/.env.debug');
  const identityPath = resolve(root, 'deploy/runtime/npep-debug/deployment.json');
  const source = await readFile(envPath, 'utf8');
  const env = parseEnv(source);
  validateDebugNpep(env, identityPath);
  const client = new Client({connectionString: env.DATABASE_URL});
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(781001)');
    const {rows: [existing]} = await client.query('SELECT * FROM "NpepDeployment" WHERE id = $1', ['current']);
    let identity;
    try { identity = JSON.parse(await readFile(identityPath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      // Lost identity must not silently invalidate an existing local pairing.
      if (existing) throw new Error('本地已有 NPEP 登记但身份文件缺失，请恢复原文件。');
    }
    if (identity && (typeof identity.enabled !== 'boolean' || !UUID.test(identity.serverInstanceId) || !UUID.test(identity.deploymentEpoch))) {
      throw new Error('本地 NPEP 身份文件格式错误。');
    }
    if (existing) {
      if (existing.serverInstanceId !== identity.serverInstanceId || existing.deploymentEpoch !== identity.deploymentEpoch) {
        throw new Error('本地 NPEP 文件与数据库身份不同，停止初始化。');
      }
    } else {
      const {rows: [counts]} = await client.query('SELECT (SELECT count(*) FROM "NpepDevice") AS devices, (SELECT count(*) FROM "NpepPairing") AS pairings');
      if (Number(counts.devices) || Number(counts.pairings)) throw new Error('发现历史 NPEP 数据，停止首次初始化。');
      if (!identity) {
        await mkdir(dirname(identityPath), {recursive: true});
        await initialize({NPEP_ENABLED: 'false', NPEP_DEPLOYMENT_FILE: identityPath});
        identity = JSON.parse(await readFile(identityPath, 'utf8'));
      }
      if (identity.enabled) throw new Error('身份已启用但数据库没有登记，请核对已有开发数据。');
      await client.query('INSERT INTO "NpepDeployment" (id, "serverInstanceId", "deploymentEpoch") VALUES ($1, $2, $3)',
        ['current', identity.serverInstanceId, identity.deploymentEpoch]);
      await client.query('INSERT INTO "NpepAudit" (id, "objectId", action, "createdAt") VALUES ($1, $2, $3, now())',
        [randomUUID(), identity.serverInstanceId, 'DEPLOYMENT_EPOCH_ACTIVATED']);
    }
    await client.query('COMMIT');
    // Open the file gate only after the database identity has committed.
    await writeAtomic(identityPath, {...identity, enabled: true});
    if (await readFile(envPath, 'utf8') !== source) throw new Error('.env.debug 已被其他操作修改，请重新运行此命令。');
    await writeFile(envPath, updateDebugNpepEnv(source, identityPath), {mode: 0o600});
    console.log('本地 NPEP 已就绪；保留已有身份与配对。请重启统一 pnpm dev，桌面填写 http://localhost:3000。');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await prepareDebugNpep(); }
  catch (error) {
    // Database error details may contain connection data; keep CLI output bounded.
    console.error(error.code ? `本地 NPEP 初始化失败（${error.code}），请检查本地数据库、迁移及文件权限。` : error.message);
    process.exitCode = 1;
  }
}
