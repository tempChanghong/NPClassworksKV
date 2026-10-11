import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schema from './study-device.schema.json' with {type: 'json'};
import {validStudyDate, validateStudyPolicy, STUDY_LIMITS} from './studySettings.js';

const ajv = new Ajv({strict: true});
addFormats(ajv);
const validators = new Map();
export function validateStudyDevice(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.compile({definitions: schema.definitions, $ref: `#/definitions/${name}`}));
  if (!validators.get(name)(value)) return false;
  if (name === 'presentationRequest') {
    const s = value.status, claim = ['Visible', 'Hidden'].includes(s.state);
    if ((s.appInstanceId === null) !== (s.pulse === null)) return false;
    if (claim && (!s.clockReady || !s.appInstanceId || s.remainingMs <= 0 || !['Preparing', 'Active', 'Ended'].includes(s.phase))) return false;
    if (s.state === 'NotRequired' && !['Disabled', 'Outside'].includes(s.phase) || s.state === 'Blocked' && s.phase !== 'Blocked') return false;
    if (s.phase === 'Ended' && (!s.clockReady || !s.window || !s.schoolNow
      || s.schoolNow < s.window.end || Date.parse(`${s.schoolNow}Z`) - Date.parse(`${s.window.end}Z`) >= 5000)) return false;
    return validateStudyDevice('receiptRequest', {requestId: value.requestId, context: value.context, sequence: value.sequence,
      status: {version: value.version, policyState: 'APPLIED', presentationState: 'NOT_INTEGRATED', captureState: 'NOT_INTEGRATED',
        phase: s.phase === 'Ended' ? 'Outside' : s.phase, reason: s.reason, clockReady: s.clockReady, schoolNow: s.schoolNow, window: s.window}});
  }
  if (name === 'homeworkRequest') return validStudyDate(value.date) && ((value.index === 0) === (value.snapshotId === null));
  if (name === 'homeworkSnapshot') {
    const text = (s, max, multiline = false) => s.length <= max && !(multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/).test(s);
    return validStudyDate(value.date) && new Set(value.items.map(item => item.id)).size === value.items.length && value.items.every(item =>
      item.id.length > 0 && text(item.id,191) && text(item.subject,191) && text(item.title,191,true) && text(item.content,2097152,true)
      && item.sources.every(source => text(source.id,191) && text(source.name,191)));
  }
  if (name === 'homeworkChunk') return value.index < value.count;
  if (['resumeRequest', 'resumeCommand', 'resumeExchangeResponse'].includes(name)) {
    const window = name === 'resumeExchangeResponse' ? value.command?.window : value.window;
    if (window) {
      const calendar = stamp => validStudyDate(stamp.slice(0, 10)) && Number(stamp.slice(11, 13)) < 24
        && Number(stamp.slice(14, 16)) < 60 && Number(stamp.slice(17, 19)) < 60;
      if (!calendar(window.start) || !calendar(window.end)) return false;
      const duration = Date.parse(`${window.end}Z`) - Date.parse(`${window.start}Z`);
      if (!(duration > 0 && duration <= 180 * 60000)) return false;
    }
  }
  if (name === 'configuration') {
    const {source, settings} = value.effective;
    if (['Grade', 'Class'].includes(source) !== (settings !== null)) return false;
    return settings === null || !validateStudyPolicy({mode: 'Override', settings});
  }
  if (name === 'executionRequest') {
    const s = value.status;
    if (s.owner === 'Schedule' && s.sessionId === null || s.owner !== 'Schedule' && s.sessionId !== null) return false;
    if (s.signalFresh && (s.owner !== 'Schedule' || s.state !== 'Active' || s.reason !== 'WINDOW_ACTIVE' || !s.clockReady || s.window === null || s.schoolNow === null)) return false;
    const observation = {version: value.version, policyState: 'APPLIED', presentationState: 'NOT_INTEGRATED', captureState: 'NOT_INTEGRATED',
      phase: s.signalFresh ? 'Active' : 'Blocked', reason: s.reason, clockReady: s.clockReady, schoolNow: s.schoolNow, window: s.window};
    return validateStudyDevice('receiptRequest', {requestId: value.requestId, context: value.context, sequence: value.sequence, status: observation});
  }
  if (name === 'receiptRequest') {
    const s = value.status;
    const calendar = stamp => validStudyDate(stamp.slice(0,10)) && Number(stamp.slice(11,13)) < 24
      && Number(stamp.slice(14,16)) < 60 && Number(stamp.slice(17,19)) < 60;
    if (s.schoolNow !== null && !calendar(s.schoolNow)) return false;
    if (s.window !== null && (!calendar(s.window.start) || !calendar(s.window.end) || s.window.start >= s.window.end)) return false;
    if (['Active', 'Preparing'].includes(s.phase)) {
      if (!s.clockReady || s.schoolNow === null || s.window === null) return false;
      const now = Date.parse(`${s.schoolNow}Z`), start = Date.parse(`${s.window.start}Z`), end = Date.parse(`${s.window.end}Z`);
      if (s.phase === 'Active' ? now < start || now >= end : now >= start || start - now > STUDY_LIMITS.displayLeadSeconds * 1000) return false;
    }
  }
  return true;
}
