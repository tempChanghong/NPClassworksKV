import {UUID} from './wire.js';
import {validateNoise} from './noise.js';
import {validDisplayWindow} from './noiseDisplay.js';

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
// Reuse the 0.6 context definition exactly, including its nil control epoch.
const validContext = value => validateNoise('context', value);

export function validateNoiseManagement(name, body) {
  if (name === 'status') return exact(body, ['requestId', 'context', 'protection'])
    && UUID.test(body.requestId) && validContext(body.context)
    && exact(body.protection, ['instanceId', 'revision', 'sessionId', 'window', 'protected'])
    && UUID.test(body.protection.instanceId) && nonnegative(body.protection.revision)
    && (body.protection.sessionId === null || UUID.test(body.protection.sessionId))
    && (body.protection.window === null || validDisplayWindow(body.protection.window))
    && typeof body.protection.protected === 'boolean';
  if (name === 'screenStop') return exact(body, ['requestId', 'command', 'pin'])
    && UUID.test(body.requestId) && typeof body.pin === 'string' && /^\d{4,8}$/.test(body.pin)
    && exact(body.command, ['action', 'instanceId', 'revision', 'sessionId', 'durationSeconds'])
    && body.command.action === 'STOP'
    && validateNoise('createRequest', {...body.command, requestId: body.requestId});
  if (name === 'authorize') return exact(body, ['requestId', 'context', 'commandId', 'instanceId', 'revision', 'sessionId'])
    && UUID.test(body.requestId) && validContext(body.context) && UUID.test(body.commandId)
    && UUID.test(body.instanceId) && nonnegative(body.revision) && UUID.test(body.sessionId);
  return false;
}
