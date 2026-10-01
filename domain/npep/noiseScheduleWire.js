import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schema from './noise-schedule-wire.schema.json' with {type:'json'};
const ajv = new Ajv({strict:true}); addFormats(ajv);
const validators = new Map();
export function validateNoiseScheduleWire(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.compile({definitions:schema.definitions,$ref:`#/definitions/${name}`}));
  if (!validators.get(name)(value)) return false;
  // School timestamps are calendar carriers, without a timezone. Reject impossible dates.
  const check = v => {
    if (typeof v === 'string') return v.isWellFormed() && !/[\u0000-\u001f\u007f-\u009f]/u.test(v) &&
      (!/^\d{4}-/.test(v) || !v.includes('T') || (Number(v.slice(0,4))>=2000 && Number(v.slice(0,4))<=9998 &&
        Number.isFinite(Date.parse(v+'Z')) && new Date(v+'Z').toISOString().slice(0,23)===v));
    if (Array.isArray(v)) return v.every(check);
    return !v || typeof v !== 'object' || Object.values(v).every(check);
  };
  return check(value);
}
