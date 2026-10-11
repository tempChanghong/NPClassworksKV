import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schema from './noise.schema.json' with {type: 'json'};
const ajv = new Ajv({strict: true});
addFormats(ajv);
const validators = new Map();
export function validateNoise(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.compile({definitions: schema.definitions, $ref: `#/definitions/${name}`}));
  if (!validators.get(name)(value) || !utf16(schema.definitions[name], value)) return false;
  if (name === 'exchangeRequest') return coherentEstimate(value.status) && value.reports.every(coherentEstimate);
  return !['status', 'report'].includes(name) || coherentEstimate(value);
}
function coherentEstimate(value) {
  const e = value.estimate;
  if (!e) return true;
  const s = e.summary, elapsed = value.summary?.elapsedSeconds ?? 0;
  const current = e.currentDbA !== null;
  return current === (e.state === 'Active') && (!current || e.reason === null && value.state === 'Active')
    && (s.sampledSeconds > 0) === (s.energyMeanDbA !== null && s.maximumDbA !== null)
    && (s.sampledSeconds > 0 || s.energyMeanDbA === null && s.maximumDbA === null)
    && Math.abs(s.coverage - (elapsed > 0 ? Math.min(1, s.sampledSeconds / elapsed) : 0)) <= 1e-6
    && (s.energyMeanDbA === null || s.maximumDbA >= s.energyMeanDbA - 1e-8);
}
function utf16(spec, value) {
  if (spec.$ref) return utf16(schema.definitions[spec.$ref.split('/').at(-1)], value);
  if (spec.anyOf) return spec.anyOf.some(s => s.type === 'null' ? value === null : value !== null && utf16(s, value));
  if (typeof value === 'string') return value.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && (spec.maxLength === undefined || value.length <= spec.maxLength);
  if (Array.isArray(value)) return value.every(v => utf16(spec.items, v));
  if (value && typeof value === 'object') return Object.entries(value).every(([k, v]) => spec.properties?.[k] && utf16(spec.properties[k], v));
  return true;
}
