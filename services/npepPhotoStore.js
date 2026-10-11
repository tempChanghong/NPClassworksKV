import {Worker} from 'node:worker_threads';
import {mkdir, writeFile, readFile, rename, unlink, lstat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fail, UUID} from '../domain/npep/wire.js';
import {jpegDimensions, photoHash, PHOTO_LIMITS} from '../domain/npep/studyPhotos.js';
let workers = 0;
const comparisonPath = value => process.platform === 'win32' ? value.toLowerCase() : value;
export async function sanitizePhoto(bytes) {
  jpegDimensions(bytes);
  if (workers >= 2) fail(503, 'PHOTO_ENCODER_BUSY');
  workers++;
  try {
    return await new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./npepPhotoImageWorker.js', import.meta.url), {workerData: bytes,
        execArgv: [], resourceLimits: {maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16}});
      let done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true; clearTimeout(timer); void worker.terminate();
        error ? reject(error) : resolve({...result, bytes: Buffer.from(result.bytes)});
      };
      const timer = setTimeout(() => finish(Object.assign(new Error('PHOTO_ENCODING_TIMEOUT'), {photoEncoding: true})), 5000);
      worker.once('message', r => finish(r.error ? Object.assign(new Error('INVALID_PHOTO'), {photoEncoding: true}) : null, r));
      worker.once('error', () => finish(Object.assign(new Error('INVALID_PHOTO'), {photoEncoding: true})));
      worker.once('exit', () => { if (!done) finish(Object.assign(new Error('INVALID_PHOTO'), {photoEncoding: true})); });
    });
  } finally { workers--; }
}
export class NpepPhotoStore {
  constructor(root = process.env.NPEP_PHOTO_STORAGE_DIR || path.resolve('.data/npep-photos')) {
    this.root = path.resolve(root);
    const publicRoot = comparisonPath(path.resolve('public')), normalizedRoot = comparisonPath(this.root);
    if (normalizedRoot === publicRoot || normalizedRoot.startsWith(publicRoot + path.sep)) throw new Error('Photo storage must be private');
  }
  file(id) { if (!UUID.test(id || '')) fail(400, 'INVALID_REQUEST'); return path.join(this.root, id.slice(0, 2), id + '.jpg'); }
  async checkDirectory(directory) {
    const actual = comparisonPath(await realpath(directory));
    const publicRoot = comparisonPath(await realpath(path.resolve('public')).catch(e => {if(e.code==='ENOENT')return path.resolve('public');throw e;}));
    if (actual === publicRoot || actual.startsWith(publicRoot + path.sep) || (await lstat(directory)).isSymbolicLink()) fail(503, 'PHOTO_STORAGE_NOT_PRIVATE');
  }
  async put(id, bytes) {
    if (bytes.length > PHOTO_LIMITS.maxBytes) fail(400, 'INVALID_PHOTO');
    const target = this.file(id); await mkdir(path.dirname(target), {recursive: true, mode: 0o700});
    await this.checkDirectory(this.root); await this.checkDirectory(path.dirname(target));
    const temp = target + '.' + randomUUID() + '.tmp';
    try { await writeFile(temp, bytes, {flag: 'wx', mode: 0o600}); await rename(temp, target); }
    finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async read(id, expectedHash) {
    const filename = this.file(id), stat = await lstat(filename);
    await this.checkDirectory(this.root); await this.checkDirectory(path.dirname(filename));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PHOTO_LIMITS.maxBytes) fail(404, 'PHOTO_UNAVAILABLE');
    const bytes = await readFile(filename);
    if (photoHash(bytes) !== expectedHash) fail(404, 'PHOTO_UNAVAILABLE');
    return bytes;
  }
  async remove(id) {
    const file=this.file(id);
    try { await this.checkDirectory(this.root); await this.checkDirectory(path.dirname(file)); await unlink(file); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
