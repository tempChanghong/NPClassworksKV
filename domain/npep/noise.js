import {validStudyDate} from './studySettings.js';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import schema from './noise.schema.json' with {type: 'json'};
const ajv = new Ajv({strict: true});
addFormats(ajv);
const validators = new Map();
export function validateNoise(name, value) {
  if (!validators.has(name)) validators.set(name, ajv.compile({definitions: schema.definitions, $ref: `#/definitions/${name}`}));
  if (!validators.get(name)(value) || !utf16(schema.definitions[name], value)) return false;
  const coherent = v => coherentNoiseSummary(v.summary) && coherentEstimate(v) && coherentStudy(v);
  if (name === 'exchangeRequest') return coherent(value.status) && value.reports.every(coherent);
  return !['status', 'report'].includes(name) || coherent(value);
}
export function coherentNoiseSummary(s) {
  if (s === null) return true; // Idle status, not a report.
  if (!s || !['elapsedSeconds','sampledSeconds','coverage','clippedPercent','frames'].every(k=>Number.isFinite(s[k]) && s[k]>=0)
    || s.coverage>1 || s.clippedPercent>100 || !Number.isInteger(s.frames)) return false;
  const mean=s.energyMeanDbfs, peak=s.peakDbfs;
  return (s.sampledSeconds>0)===(s.frames>0)
    && Math.abs(s.coverage-(s.elapsedSeconds>0 ? Math.min(1,s.sampledSeconds/s.elapsedSeconds) : 0))<=1e-6
    && (mean===null)===(peak===null)
    && (mean===null || Number.isFinite(mean) && Number.isFinite(peak) && peak>=mean-1e-8)
    && (s.sampledSeconds>0 || mean===null && peak===null && s.clippedPercent===0)
    && (s.clippedPercent===0 || peak!==null && peak>=20*Math.log10(.999)-1e-8);
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

function coherentStudy(value) {
  const s=value.study; if(!s)return true;
  const start=Date.parse(s.window.start+'Z'),end=Date.parse(s.window.end+'Z');
  if(!validStudyDate(s.window.start.slice(0,10)) || !validStudyDate(s.window.end.slice(0,10)) || !Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>10800000 ||
    s.clockSource!==(s.mode==='Exam'?'Windows':'ClassIsland'))return false;
  const p=s.statistics;if(!p)return true;
  if(p.sessionId!==value.sessionId || p.raw.unit!=='dBFS' || p.estimated && p.estimated.unit!=='estimated-dB(A)')return false;
  return [p.raw,p.estimated].filter(Boolean).every(c=>c.highSeconds<=c.thresholdSampledSeconds+1e-6 &&
    c.mediumSeconds<=c.mediumThresholdSampledSeconds+1e-6 && c.thresholdSampledSeconds<=c.sampledSeconds+1e-6 &&
    c.mediumThresholdSampledSeconds<=c.sampledSeconds+1e-6 && (c.energyMean===null)===(c.maximum===null) &&
    (c.energyMean===null || c.maximum>=c.energyMean-1e-6));
}
