import {createHash} from 'node:crypto';
import Ajv from 'ajv';
import schema from './study-photos.schema.json' with {type: 'json'};
import {fail, UUID} from './wire.js';
export const PHOTO_LIMITS = Object.freeze({maxEdge: 1280, maxBytes: 262144, leaseSeconds: 60,
  maxUploadAgeSeconds: 86400, maxRetentionDays: 180, schoolQuotaBytes: 8 * 1024 ** 3});
export const photoHash = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const ajv = new Ajv({strict: true});
const leaseValidator = ajv.compile({definitions: schema.definitions, $ref: '#/definitions/leaseRequest'});
export const validatePhotoLeaseRequest = value => leaseValidator(value);
export function validatePhotoMetadata(v) {
  if (!exact(v, ['eventId', 'leaseId', 'sessionId', 'version', 'capturedAt', 'schoolNow', 'reason',
    'unit', 'level', 'high', 'continuousSeconds', 'calibrationId', 'hash', 'width', 'height', 'byteCount'])) return false;
  const stamp = s => typeof s === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)
    && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
  const acoustic = v.unit === 'EstimatedDbA';
  const level = n => typeof n === 'number' && Number.isFinite(n) && n >= (acoustic ? 30 : -160) && n <= (acoustic ? 130 : 0);
  return ['eventId', 'leaseId', 'sessionId'].every(k => UUID.test(v[k] || ''))
    && /^[a-f0-9]{64}$/.test(v.version || '') && /^[a-f0-9]{64}$/.test(v.hash || '')
    && stamp(v.capturedAt) && typeof v.schoolNow === 'string' && stamp(v.schoolNow + 'Z')
    && ['Noise', 'ExitAttempt'].includes(v.reason) && ['Dbfs', 'EstimatedDbA'].includes(v.unit)
    && level(v.high) && (v.level === null ? v.reason === 'ExitAttempt' : level(v.level))
    && (acoustic ? /^[a-f0-9]{64}$/.test(v.calibrationId || '') || v.reason === 'ExitAttempt' && v.level === null && v.calibrationId === null : v.calibrationId === null)
    && Number.isInteger(v.continuousSeconds) && v.continuousSeconds >= 1 && v.continuousSeconds <= 10
    && ['width', 'height'].every(k => Number.isInteger(v[k]) && v[k] >= 1 && v[k] <= PHOTO_LIMITS.maxEdge)
    && Number.isInteger(v.byteCount) && v.byteCount > 0 && v.byteCount <= PHOTO_LIMITS.maxBytes;
}
// Check dimensions before sending untrusted input to the bounded decoder worker.
export function jpegDimensions(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 6 || bytes.length > PHOTO_LIMITS.maxBytes
    || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) fail(400, 'INVALID_PHOTO');
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i++] !== 0xff) fail(400, 'INVALID_PHOTO');
    while (bytes[i] === 0xff) i++;
    const marker = bytes[i++];
    if (marker === 0xda || marker === 0xd9) break;
    if (i + 2 > bytes.length) fail(400, 'INVALID_PHOTO');
    const length = bytes.readUInt16BE(i);
    if (length < 2 || i + length > bytes.length) fail(400, 'INVALID_PHOTO');
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8 || bytes[i + 2] !== 8) fail(400, 'INVALID_PHOTO');
      const height = bytes.readUInt16BE(i + 3), width = bytes.readUInt16BE(i + 5);
      if (!width || !height || Math.max(width, height) > PHOTO_LIMITS.maxEdge) fail(400, 'INVALID_PHOTO');
      return {width, height};
    }
    i += length;
  }
  fail(400, 'INVALID_PHOTO');
}
