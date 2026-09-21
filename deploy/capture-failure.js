import {spawnSync} from 'node:child_process';
import {chmodSync, mkdtempSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

export function redact(value, env) {
  let text = String(value ?? '');
  for (const [key, secret] of Object.entries(env)) {
    if (/PASSWORD|SECRET|TOKEN|KEY|DATABASE_URL/i.test(key) && secret) {
      text = text.split(secret).join('[REDACTED]');
    }
  }
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}

export function captureFailure([root, envFile, composeFile, runtime], {run = spawnSync, env = process.env} = {}) {
  const directory = mkdtempSync(join(runtime, 'failure-'));
  chmodSync(directory, 0o700);
  const compose = ['compose', '--project-directory', root, '--env-file', envFile, '-f', composeFile];
  const save = (name, args) => {
    const result = run('docker', args, {encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, env});
    const body = JSON.stringify({status: result.status, error: result.error?.code,
      stdout: redact(result.stdout, env), stderr: redact(result.stderr, env)}, null, 2);
    writeFileSync(join(directory, name), body, {mode: 0o600, flag: 'wx'});
    return result;
  };
  const ids = save('containers.json', [...compose, 'ps', '-a', '-q', 'backend', 'frontend', 'postgres']);
  // Never serialize Config.Env, command arguments, or health-check output.
  for (const id of String(ids.stdout || '').trim().split(/\s+/).filter(id => /^[a-f0-9]{12,64}$/.test(id)).slice(0, 6)) {
    save(`${id}.json`, ['inspect', '--format',
      '{"id":{{json .Id}},"image":{{json .Image}},"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"oomKilled":{{json .State.OOMKilled}},"restarts":{{json .RestartCount}}}', id]);
  }
  save('logs.json', [...compose, 'logs', '--no-color', '--tail', '200', '--since', '15m', 'backend', 'postgres']);
  return directory;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.error(`[NPClassworks] 私有失败诊断：${captureFailure(process.argv.slice(2))}`);
  } catch {
    console.error('[NPClassworks] 无法保存失败诊断');
    process.exitCode = 1;
  }
}
