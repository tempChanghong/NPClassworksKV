import {inflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import Ajv from 'ajv';
import schema from './seating.schema.json' with {type: 'json'};
import {fail} from './wire.js';
const ajv = new Ajv({strict: true});
const validators = new Map();
export function validateSeating(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.compile({definitions: schema.definitions, $ref: `#/definitions/${name}`}));
  if (!validators.get(name)(value)) return false;
  if (name === 'manifestRequest' && value.observation) {
    const o = value.observation;
    if (o.visible && (o.appliedHash === null || o.renderAgeMs === null) || o.appliedHash === null && o.revision !== 0) return false;
  }
  if (name === 'manifest' && value.asset) {
    const a = value.asset;
    if (value.revision < 1 || a.width * a.height > 6000000 || a.chunks !== Math.ceil(a.byteCount / 16384)) return false;
  }
  return true;
}
const crcTable = Array.from({length: 256}, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ n >>> 1 : n >>> 1;
  return n >>> 0;
});
export function pngCrc(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) crc = crcTable[(crc ^ b) & 255] ^ crc >>> 8;
  return (crc ^ 0xffffffff) >>> 0;
}
// Browser canvas exports normalized, 8-bit, non-interlaced RGB/RGBA PNG. Reject metadata,
// CRC errors, truncated/extra compressed pixels and decompression bombs before storing.
export function readSeatingPng(base64) {
  if (typeof base64 !== 'string' || base64.length > 2796204 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail(400, 'INVALID_IMAGE');
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > 2097152 || bytes.toString('base64') !== base64 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) fail(400, 'INVALID_IMAGE');
  let offset = 8, width, height, channels, ended = false, dataEnded = false;
  const data = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail(400, 'INVALID_IMAGE');
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    if (end > bytes.length) fail(400, 'INVALID_IMAGE');
    const type = bytes.toString('ascii', offset + 4, offset + 8), body = bytes.subarray(offset + 8, end - 4);
    if (pngCrc(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) fail(400, 'INVALID_IMAGE');
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) fail(400, 'INVALID_IMAGE');
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); channels = body[9] === 6 ? 4 : body[9] === 2 ? 3 : 0;
      if (!width || !height || width > 4096 || height > 4096 || width * height > 6000000 || !channels || body[8] !== 8 || body[10] || body[11] || body[12]) fail(400, 'IMAGE_DIMENSIONS');
    } else if (!width) fail(400, 'INVALID_IMAGE');
    else if (type === 'IDAT') { if (dataEnded) fail(400, 'INVALID_IMAGE'); data.push(body); }
    else if (type === 'IEND') { if (length || !data.length || end !== bytes.length) fail(400, 'INVALID_IMAGE'); ended = true; }
    else if (!['sRGB', 'gAMA', 'pHYs'].includes(type) || data.length || type === 'sRGB' && (length !== 1 || body[0] > 3) || type === 'gAMA' && (length !== 4 || !body.readUInt32BE(0)) || type === 'pHYs' && (length !== 9 || body[8] > 1)) fail(400, 'INVALID_IMAGE');
    if (data.length && type !== 'IDAT') dataEnded = true;
    offset = end;
  }
  if (!ended) fail(400, 'INVALID_IMAGE');
  const row = width * channels + 1, expected = row * height;
  let raw;
  try { const compressed = Buffer.concat(data); const result = inflateSync(compressed, {maxOutputLength: expected, info: true});
    if (result.engine.bytesWritten !== compressed.length) fail(400, 'INVALID_IMAGE'); raw = result.buffer;
  } catch { fail(400, 'INVALID_IMAGE'); }
  if (raw.length !== expected) fail(400, 'INVALID_IMAGE');
  for (let y = 0; y < height; y++) if (raw[y * row] > 4) fail(400, 'INVALID_IMAGE');
  return {bytes, width, height, hash: createHash('sha256').update(bytes).digest('hex')};
}
