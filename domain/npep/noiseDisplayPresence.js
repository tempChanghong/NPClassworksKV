import {UUID} from './wire.js';
import {validateNoise} from './noise.js';
import {validDisplayWindow} from './noiseDisplay.js';

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const scope = value => UUID.test(value.instanceId) && Number.isSafeInteger(value.revision)
  && value.revision >= 0 && UUID.test(value.captureSessionId) && validDisplayWindow(value.window);
const deviceKeys = ['requestId', 'context', 'instanceId', 'revision', 'captureSessionId', 'window'];
const utcMilliseconds = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

export function validateNoiseDisplayPresence(name, value) {
  if (name === 'screenPresence') return exact(value,
    ['requestId', 'displaySessionId', 'sequence', 'state', 'instanceId', 'revision', 'captureSessionId', 'window'])
    && UUID.test(value.requestId) && UUID.test(value.displaySessionId)
    && Number.isSafeInteger(value.sequence) && value.sequence >= 1
    && ['DISPLAY_VISIBLE', 'RETURNING', 'BLOCKED', 'HIDDEN'].includes(value.state)
    && scope(value);
  if (name === 'observe') return exact(value, deviceKeys) && UUID.test(value.requestId)
    && validateNoise('context', value.context) && scope(value);
  if (name === 'deviceReturn') {
    const online = exact(value, deviceKeys);
    const offline = exact(value, [...deviceKeys, 'offlineStartedAt', 'returnMinutes']);
    if (!online && !offline) return false;
    return UUID.test(value.requestId) && validateNoise('context', value.context) && scope(value)
      && (online || (utcMilliseconds(value.offlineStartedAt)
        && Number.isInteger(value.returnMinutes) && value.returnMinutes >= 1 && value.returnMinutes <= 60));
  }
  return false;
}
