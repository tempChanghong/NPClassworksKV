// Disposable PostgreSQL cluster: never connects to classworks_debug or a Windows service.
import {spawnSync} from 'node:child_process';
import {openSync, closeSync, readFileSync} from 'node:fs';
import {mkdtemp, writeFile, readdir, access, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve, join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import net from 'node:net';
import {Client} from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
const suffix = process.platform === 'win32' ? '.exe' : '';
async function findBin() {
  if (process.env.NPEP_TEST_PG_BIN) return resolve(process.env.NPEP_TEST_PG_BIN);
  if (process.platform === 'win32') {
    const base = join(process.env.ProgramFiles || 'C:/Program Files', 'PostgreSQL');
    const versions = (await readdir(base)).sort((a, b) => Number(b) - Number(a));
    for (const version of versions) {
      const path = join(base, version, 'bin');
      try { await access(join(path, 'initdb.exe')); return path; } catch { /* next installation */ }
    }
  }
  throw new Error('Set NPEP_TEST_PG_BIN to the installed PostgreSQL bin directory.');
}
function run(command, args, env, capture = false) {
  // A pg_ctl-started Windows server inherits handles. Files avoid waiting forever
  // for EOF on a pipe held by the intentionally long-running postgres process.
  const log = capture ? join(directory, basename(command) + '.log') : null;
  const fd = log ? openSync(log, 'a') : null;
  let result;
  try { result = spawnSync(command, args, {cwd: root, env, windowsHide: true, stdio: capture ? ['ignore', fd, fd] : 'inherit', encoding: 'utf8'}); }
  finally { if (fd !== null) closeSync(fd); }
  if (result.error || result.status !== 0) throw new Error(`${basename(command)} failed (${result.status}): ${log ? readFileSync(log, 'utf8') : 'see output above'}`);
  return result.stdout;
}
const bin = await findBin();
for (const name of ['initdb', 'pg_ctl', 'pg_dump', 'pg_restore']) await access(join(bin, name + suffix));
const temporaryRoot = resolve(tmpdir());
const directory = await mkdtemp(join(temporaryRoot, 'npclassworks-native-npep-'));
const data = join(directory, 'pgdata');
const passwordFile = join(directory, 'password');
const emptyEnv = join(directory, 'empty.env');
const password = randomBytes(24).toString('hex');
await writeFile(passwordFile, password, {mode: 0o600});
await writeFile(emptyEnv, '');
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const env = {...process.env, NODE_ENV: 'test', DATABASE_URL: `postgresql://npclassworks_test:${password}@127.0.0.1:${port}/npclassworks_test?schema=public`,
  RUN_DATABASE_TESTS: 'true', NPEP_TEST_PG_BIN: bin, INTEGRATION_NATIVE_POSTGRES: 'true',
  DOTENV_CONFIG_PATH: emptyEnv, DOTENV_CONFIG_OVERRIDE: 'false',
  JWT_SECRET: randomBytes(48).toString('hex'), REFRESH_TOKEN_SECRET: randomBytes(48).toString('hex'),
  BOOTSTRAP_SETUP_KEY: randomBytes(48).toString('hex')};
for (const name of ['INTEGRATION_COMPOSE_PROJECT', 'AXIOM_TOKEN', 'AXIOM_DATASET', 'NPEP_ENABLED', 'NPEP_DEPLOYMENT_FILE',
  'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSERVICE', 'PGSERVICEFILE', 'PGOPTIONS']) delete env[name];
let started = false, passed = false, stopped = false;
function stopOwnedCluster() {
  if (stopped) return;
  const status = spawnSync(join(bin, 'pg_ctl' + suffix), ['-D', data, 'status'], {env, windowsHide: true, stdio: 'ignore'});
  if (started || status.status === 0) run(join(bin, 'pg_ctl' + suffix), ['-D', data, '-m', 'fast', '-w', '-t', '30', 'stop'], env, true);
  stopped = true;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  try { stopOwnedCluster(); } finally {
    console.log(`Interrupted; test files retained: ${directory}`);
    process.exit(130);
  }
});
try {
  const desktopOption = process.argv.indexOf('--desktop-root');
  if (desktopOption >= 0 && !process.argv[desktopOption + 1]) throw new Error('--desktop-root requires a path');
  const desktopRoot = resolve(desktopOption >= 0 ? process.argv[desktopOption + 1] : join(root, '../NPEduTools'));
  const artifacts = join(desktopRoot, '.artifacts/n3-tests');
  run('dotnet', ['build', join(desktopRoot, 'tests/NPEduTools.Npep.Acceptance/NPEduTools.Npep.Acceptance.csproj'), '--artifacts-path', artifacts, '--verbosity', 'quiet'], env);
  env.NPEP_N3_ACCEPTANCE_DLL = join(artifacts, 'bin/NPEduTools.Npep.Acceptance/debug/NPEduTools.Npep.Acceptance.dll');
  await access(env.NPEP_N3_ACCEPTANCE_DLL);
  run(join(bin, 'initdb' + suffix), ['-D', data, '-U', 'npclassworks_test', '--pwfile', passwordFile, '--auth=scram-sha-256', '--encoding=UTF8', '--locale=C'], env, true);
  run(join(bin, 'pg_ctl' + suffix), ['-D', data, '-l', join(directory, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port}`, '-w', '-t', '30', 'start'], env, true);
  started = true;
  const admin = new Client({host: '127.0.0.1', port, user: 'npclassworks_test', password, database: 'postgres'});
  await admin.connect();
  try { await admin.query('CREATE DATABASE npclassworks_test'); } finally { await admin.end(); }
  console.log(`Native isolated NPEP PostgreSQL ready on loopback port ${port}.`);
  run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], env);
  run(process.execPath, ['--test', '--test-concurrency=1', 'tests/npepDatabase.integration.test.js'], env);
  passed = true;
} finally {
  try {
    // Also detects a server started just before a startup timeout.
    stopOwnedCluster();
  } finally {
    if (passed && stopped && dirname(resolve(directory)) === temporaryRoot && basename(directory).startsWith('npclassworks-native-npep-')) {
      await rm(directory, {recursive: true});
      console.log('Native NPEP acceptance passed; temporary cluster removed.');
    } else console.log(`Temporary test files retained for diagnosis: ${directory}`);
  }
}
