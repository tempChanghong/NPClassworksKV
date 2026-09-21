// Disposable synthetic context: no repository secrets, services or volumes.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {randomUUID} from 'node:crypto';

const context = mkdtempSync(join(tmpdir(), 'np-build-permissions-'));
const image = `np-build-permissions-${randomUUID()}`;
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const normalization = dockerfile.split(/\r?\n/).find(line => line === 'RUN chmod -R a+rX /app');
assert.ok(normalization, 'use the production permission normalization');
const privatePaths = ['deploy/backups/private.txt', 'deploy/runtime/private.txt', 'elsewhere/db.dump',
  'elsewhere/db.dump.sha256', 'elsewhere/images.tar', '.env.production', 'deploy/.env.production'];
function put(path, value) {
  const target = join(context, path);
  mkdirSync(dirname(target), {recursive: true});
  writeFileSync(target, value);
}
function docker(args) {
  const result = spawnSync('docker', args, {encoding: 'utf8', maxBuffer: 8 * 1024 * 1024});
  if (result.error) throw result.error;
  return result;
}
try {
  put('.dockerignore', readFileSync(new URL('../.dockerignore', import.meta.url)));
  put('package.json', '{"type":"module"}');
  put('scripts/npep-config.js', readFileSync(new URL('./npep-config.js', import.meta.url)));
  for (const path of privatePaths) put(path, 'PRIVATE_SENTINEL');
  put('verify.cjs', `const fs=require('fs'); for(const p of ${JSON.stringify(privatePaths)}) {
    if(fs.existsSync('/app/'+p)) throw Error('Private context file copied: '+p);
  }`);
  for (const fixed of [false, true]) {
    put('Dockerfile', `FROM node:22-alpine
WORKDIR /app
COPY . .
RUN node verify.cjs
# Reproduce root checkout under umask 077, independently of host filesystem.
RUN chmod -R go-rwx /app
${fixed ? normalization : ''}
USER node
ENV NPEP_ENABLED=false
CMD ["node", "scripts/npep-config.js", "check"]
`);
    const tag = `${image}:${fixed ? 'fixed' : 'restricted'}`;
    const build = docker(['build', '--network', 'none', '-t', tag, context]);
    assert.equal(build.status, 0, build.stderr);
    const run = docker(['run', '--rm', '--network', 'none', '--read-only', tag]);
    if (fixed) {
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /NPEP configuration operation completed/);
    } else {
      assert.equal(run.status, 1, run.stderr);
      assert.match(run.stderr, /EACCES|MODULE_NOT_FOUND/);
    }
  }
  console.log('Restricted checkout fails before fix; runtime helper and private context exclusions pass after fix');
} finally {
  for (const tag of ['restricted', 'fixed']) docker(['image', 'rm', `${image}:${tag}`]);
  rmSync(context, {recursive: true, force: true});
}
