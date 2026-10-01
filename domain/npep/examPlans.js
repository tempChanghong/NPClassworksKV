import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import {createHash} from 'node:crypto';
import schema from './exam-plan.schema.json' with {type:'json'};
import {fail, parseStrictJson} from './wire.js';
const ajv = new Ajv({strict:true}); addFormats(ajv);
const validators = new Map();
export function validateExamPlan(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.compile({definitions:schema.definitions,$ref:`#/definitions/${name}`}));
  return validators.get(name)(value) && utf16(schema.definitions[name],value);
}
function utf16(spec,value) {
  if(spec.$ref) return utf16(schema.definitions[spec.$ref.split('/').at(-1)],value);
  if(spec.anyOf) return spec.anyOf.some(s=>s.type==='null'?value===null:value!==null&&utf16(s,value));
  if(typeof value==='string') return value.isWellFormed() && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) && (spec.maxLength===undefined||value.length<=spec.maxLength);
  if(Array.isArray(value)) return value.every(v=>utf16(spec.items,v));
  if(value&&typeof value==='object') return Object.entries(value).every(([k,v])=>spec.properties?.[k]&&utf16(spec.properties[k],v));
  return true;
}
export function planDigest(data) {
  const bytes=Buffer.from(data,'base64');
  if (!bytes.length||bytes.length>24576||bytes.toString('base64')!==data) fail(400,'INVALID_PLAN');
  const value=parseStrictJson(bytes.subarray(bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf?3:0));
  if(!value||Array.isArray(value)||typeof value!=='object') fail(400,'INVALID_PLAN');
  return createHash('sha256').update(bytes).digest('hex');
}
export const finalPlan = op => ['STARTED','FAILED','UNKNOWN','EXPIRED','CANCELLED'].includes(op.state);
export const planView = op => ({...op,dataBase64:null});
