import {OPAQUE_ID, UUID} from './wire.js';
import {validatePolicy} from './noiseScheduleRules.js';

export function validateScheduleWrite(body) {
  const keys = ['requestId', 'termId', 'targetType', 'targetId', 'expectedRevision', 'policy'];
  return !!body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === keys.length
    && keys.every(key => Object.hasOwn(body, key)) && UUID.test(body.requestId || '')
    && typeof body.termId === 'string' && OPAQUE_ID.test(body.termId)
    && ['GRADE', 'CLASS'].includes(body.targetType) && typeof body.targetId === 'string' && OPAQUE_ID.test(body.targetId)
    && Number.isInteger(body.expectedRevision) && body.expectedRevision >= 0 && body.expectedRevision < 2147483647
    && body.policy != null && validatePolicy(body.policy, body.targetType === 'GRADE') === null;
}

export function validateScheduleQuery(query) {
  return Object.keys(query).every(key => key === 'termId')
    && (query.termId === undefined || typeof query.termId === 'string' && OPAQUE_ID.test(query.termId));
}
