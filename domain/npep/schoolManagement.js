import {pbkdf2Sync, randomBytes, timingSafeEqual} from 'node:crypto';
import {fail, digest, UUID, OPAQUE_ID} from './wire.js';

export const MANAGEMENT_ITERATIONS = 210000;
export const managementSecretValid = value => typeof value === 'string' && value.length >= 8 && value.length <= 128 && !/[\p{Cc}\p{Cf}]/u.test(value);
export function managementVerifier(secret) {
  if (!managementSecretValid(secret)) fail(400, 'INVALID_MANAGEMENT_SECRET');
  const salt = randomBytes(16);
  return {iterations: MANAGEMENT_ITERATIONS, salt: salt.toString('base64'), hash: pbkdf2Sync(secret, salt, MANAGEMENT_ITERATIONS, 32, 'sha256').toString('base64')};
}
export function verifyManagementSecret(secret, verifier) {
  if (!managementSecretValid(secret) || !verifier || verifier.iterations !== MANAGEMENT_ITERATIONS) return false;
  const salt = Buffer.from(verifier.salt ?? '', 'base64'), hash = Buffer.from(verifier.hash ?? '', 'base64');
  return salt.length === 16 && hash.length === 32 && timingSafeEqual(hash, pbkdf2Sync(secret, salt, MANAGEMENT_ITERATIONS, 32, 'sha256'));
}
export function managementWriteValid(body) {
  return body && UUID.test(body.requestId ?? '') && Number.isSafeInteger(body.expectedRevision) && body.expectedRevision >= 0
    && typeof body.enabled === 'boolean' && (body.secret === null || managementSecretValid(body.secret))
    && Object.keys(body).every(k => ['requestId', 'expectedRevision', 'enabled', 'secret'].includes(k));
}
export function managementRequestDigest(body) {
  // A request log must not become a cheap password dictionary oracle.
  const secret = body.secret === null ? null : pbkdf2Sync(body.secret, body.requestId, MANAGEMENT_ITERATIONS, 32, 'sha256').toString('base64');
  return digest({...body, secret});
}
export function equipmentWriteValid(body) {
  return body && UUID.test(body.requestId ?? '') && Number.isSafeInteger(body.expectedRevision) && body.expectedRevision >= 0
    && typeof body.locked === 'boolean' && [body.microphoneId, body.cameraId].every(v => v === null || typeof v === 'string' && v.length > 0 && v.length <= 2048 && !/[\p{Cc}\p{Cf}]/u.test(v))
    && Object.keys(body).every(k => ['requestId','expectedRevision','locked','microphoneId','cameraId'].includes(k));
}
export const bindingIdValid = id => OPAQUE_ID.test(id ?? '');
