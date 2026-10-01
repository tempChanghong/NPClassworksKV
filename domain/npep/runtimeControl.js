import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schema from './runtime-control.schema.json' with {type: 'json'};
import {digest, fail} from './wire.js';

const ajv = new Ajv({strict: true});
addFormats(ajv);
const validators = new Map();
export function validateRuntime(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.compile({definitions: schema.definitions, $ref: `#/definitions/${name}`}));
  return validators.get(name)(value) && utf16(schema.definitions[name], value);
}
function utf16(spec, value) {
  if (spec.$ref) return utf16(schema.definitions[spec.$ref.split('/').at(-1)], value);
  if (spec.anyOf) return spec.anyOf.some(s => s.type === 'null' ? value === null : value !== null && utf16(s, value));
  if (typeof value === 'string') return value.isWellFormed() && (spec.maxLength === undefined || value.length <= spec.maxLength);
  if (Array.isArray(value)) return value.every(v => utf16(spec.items, v));
  if (value && typeof value === 'object') return Object.entries(value).every(([key, v]) => spec.properties?.[key] && utf16(spec.properties[key], v));
  return true;
}
export const identityOf = d => ({serverInstanceId: d.serverInstanceId, deploymentEpoch: d.deploymentEpoch,
  deviceId: d.id, bindingRevision: d.bindingRevision, credentialGeneration: 1});
export function requireSame(a, b, code = 'STATE_CHANGED') { if (digest(a) !== digest(b)) fail(409, code); }
export const fresh = (p, now = Date.now()) => !!p?.sampleAsOf && now - Date.parse(p.sampleAsOf) >= 0 && now - Date.parse(p.sampleAsOf) <= 60000;
export function requireReady(p, body, now = Date.now()) {
  if (!p?.policy.supported) fail(409, 'CLIENT_UNSUPPORTED');
  if (p.policy.pairedExamControl !== true) fail(409, 'CLIENT_UNSUPPORTED');
  if (!p.policy.enabled) fail(409, 'CONTROL_DISABLED');
  if (!fresh(p, now)) fail(409, 'DEVICE_OFFLINE');
  requireSame([body.consentId, body.policyRevision, body.controlEpoch],
    [p.policy.consentId, p.policy.policyRevision, p.context.controlEpoch], 'POLICY_CHANGED');
}
export function operationView(op, now = Date.now()) {
  return {...op.view, freshness: !op.view.progressReceivedAt ? 'UNKNOWN' : now - Date.parse(op.view.progressReceivedAt) <= 60000 ? 'CURRENT' : 'STALE'};
}

export function applyRuntimeEvent(op, event, now = new Date().toISOString()) {
  const previous = op.events.find(x => x.eventId === event.eventId || x.sequence === event.sequence);
  if (previous) { requireSame(previous, event, 'SEQUENCE_CONFLICT'); return 'DUPLICATE'; }
  if (op.events.length >= 256) fail(409, 'OPERATION_BUSY');
  if (event.sequence !== op.view.lastEventSequence + 1) fail(409, 'SEQUENCE_GAP');
  if (op.view.resolvedAt && !op.view.grant && event.state === 'REJECTED' && event.execution === null && event.evidence?.sideEffects === 'NONE') {
    op.events.push(event); op.view.lastEventSequence = event.sequence; return 'ACCEPTED';
  }
  const lateResult = op.retiredByEpoch === true && ['SUCCEEDED', 'PARTIAL', 'UNKNOWN', 'REJECTED'].includes(event.state);
  if (!lateResult && (op.view.resolvedAt || ['SUCCEEDED', 'REJECTED', 'FAILED', 'PARTIAL', 'UNKNOWN'].includes(op.view.state))) fail(409, 'INVALID_TRANSITION');
  const grant = op.view.grant;
  if (grant) {
    requireSame(event.execution, Object.fromEntries(['runId', 'sessionId', 'statusEpoch', 'controlEpoch', 'grantId'].map(k => [k, grant[k]])), 'AUTH_INVALID');
  } else if (event.execution !== null || !['RECEIVED', 'CHECKING', 'REJECTED', 'UNKNOWN'].includes(event.state) ||
      event.state === 'UNKNOWN' && event.evidence?.sideEffects !== 'NONE') fail(409, 'INVALID_TRANSITION');
  if (event.state === 'SUCCEEDED' && op.view.target !== 'DAILY' && (!event.evidence || event.evidence.examAware !== 'READY' || event.evidence.classIsland !== 'EXITED' || !event.evidence.remoteExamPause)) fail(409, 'INVALID_TRANSITION');
  if (event.state === 'SUCCEEDED' && op.view.scope === 'EXAM_MODE' && op.view.target !== 'DAILY' && event.evidence?.startup !== 'EXAM_MODE_APPLIED') fail(409, 'INVALID_TRANSITION');
  if (event.state === 'SUCCEEDED' && op.view.target === 'DAILY' && (!event.evidence ||
      event.evidence.examAware !== 'EXITED' || event.evidence.classIsland !== 'READY' || event.evidence.remoteExamPause ||
      event.evidence.startup !== 'DAILY_MODE_APPLIED')) fail(409, 'INVALID_TRANSITION');
  if (event.state === 'REJECTED' && event.evidence?.sideEffects !== 'NONE') fail(409, 'INVALID_TRANSITION');
  if (grant && event.state === 'FAILED') fail(409, 'INVALID_TRANSITION'); // Post-grant uncertainty keeps the unresolved slot.
  op.events.push(event);
  op.retiredByEpoch = false;
  Object.assign(op.view, {state: event.state, step: event.step, reasonCode: event.reasonCode, evidence: event.evidence,
    lastEventSequence: event.sequence, progressReceivedAt: now,
    resolvedAt: ['SUCCEEDED', 'REJECTED', 'PARTIAL', 'UNKNOWN', 'FAILED'].includes(event.state) ? now : null});
  return 'ACCEPTED';
}
