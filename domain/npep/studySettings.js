import {validatePolicy as validateNoisePolicy} from './noiseScheduleRules.js';

// Configuration only. This contract does not grant camera or microphone access.
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,191}$/.test(value);
export const STUDY_LIMITS = Object.freeze({prepareSeconds: 120, displayLeadSeconds: 300, holdSeconds: 2, maxHideSeconds: 180,
  maxPhotoRetentionDays: 180, photoMaxEdge: 1280, photoMaxBytes: 262144, cameraSelection: 'ExplicitOnDevice'});

export function validStudyDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && value >= '2000-01-01' && value <= '9998-12-31'
    && new Date(time).toISOString().slice(0, 10) === value;
}

export function defaultStudyEstimatedThresholds() {
  return {highDbA: 65, mediumDbA: 50};
}

export function defaultStudySettings() {
  return {
    schedule: {timeZone: 'Asia/Shanghai', effectiveFrom: '', effectiveTo: null,
      rules: [{days: [], start: '19:00', end: '21:30'}], exceptions: []},
    examSchedule: {timeZone: 'Asia/Shanghai', effectiveFrom: '', effectiveTo: null, rules: [], exceptions: []},
    presentation: {noiseDisplay: 'StatusTrend', temporaryHideSeconds: 180},
    homework: {enabled: true, sourceMode: 'OwnClass', sourceClassIds: [], rotationSeconds: 60},
    noise: {enabled: true, redLineDbfs: null, mediumLineDbfs: null, disciplineCooldownSeconds: 600, highContinuousSeconds: 3,
      estimated: defaultStudyEstimatedThresholds()},
    photos: {enabled: false, continuousSeconds: 3, cooldownSeconds: 30, retentionDays: 30,
      captureOnExit: true, extendedRetentionAcknowledged: false},
  };
}

// Expand only the exact legacy shape; never mask malformed or unknown fields.
export function normalizeStudyPolicy(policy) {
  if (policy?.mode !== 'Override') return policy;
  const n = policy.settings?.noise;
  if (!exact(n, ['enabled', 'redLineDbfs']) && !exact(n, ['enabled', 'redLineDbfs', 'mediumLineDbfs', 'disciplineCooldownSeconds'])) return policy;
  return {...policy, settings: {...policy.settings, noise: {mediumLineDbfs: null, disciplineCooldownSeconds: 600,
    ...n, highContinuousSeconds: policy.settings.photos?.continuousSeconds}}};
}

export function validateStudyPolicy(policy, grade = false) {
  policy = normalizeStudyPolicy(policy);
  if (!exact(policy, ['mode', 'settings']) || !['Override', 'Inherit', 'Disabled'].includes(policy.mode)
    || grade && policy.mode === 'Inherit') return 'INVALID_MODE';
  if (policy.mode !== 'Override') return policy.settings === null ? null : 'UNEXPECTED_SETTINGS';
  const s = policy.settings;
  const keys = ['schedule', 'presentation', 'homework', 'noise', 'photos'];
  if (!(exact(s, keys) || exact(s, [...keys, 'examSchedule']))) return 'INVALID_SETTINGS';
  const {schedule: t, presentation: p, homework: h, noise: n, photos: f} = s;
  if (!exact(t, ['timeZone', 'effectiveFrom', 'effectiveTo', 'rules', 'exceptions']) || t.timeZone !== 'Asia/Shanghai'
    || !(validStudyDate(t.effectiveFrom) || Array.isArray(t.rules) && !t.rules.length && t.effectiveFrom === '') || t.effectiveTo !== null && (!validStudyDate(t.effectiveTo) || t.effectiveTo < t.effectiveFrom)) return 'INVALID_DATES';
  const ruleError = validateNoisePolicy({mode: Array.isArray(t.rules) && !t.rules.length ? 'Disabled' : 'Override', rules: t.rules}, true);
  if (ruleError) return ruleError;
  if (!Array.isArray(t.exceptions) || t.exceptions.length > 366) return 'INVALID_CALENDAR';
  const dates = new Set();
  for (const e of t.exceptions) {
    if (!exact(e, ['date', 'kind', 'weekday']) || !validStudyDate(e.date) || e.date < t.effectiveFrom
      || t.effectiveTo && e.date > t.effectiveTo || dates.has(e.date)
      || !['Skip', 'UseWeekday'].includes(e.kind) || (e.kind === 'Skip' ? e.weekday !== null : !integer(e.weekday, 1, 7))) return 'INVALID_CALENDAR';
    dates.add(e.date);
  }
  if (!exact(p, ['noiseDisplay', 'temporaryHideSeconds']) || !['Status', 'StatusTrend', 'StatusDbfs'].includes(p.noiseDisplay)
    || !integer(p.temporaryHideSeconds, 60, STUDY_LIMITS.maxHideSeconds)) return 'INVALID_PRESENTATION';
  if (!exact(h, ['enabled', 'sourceMode', 'sourceClassIds', 'rotationSeconds']) || typeof h.enabled !== 'boolean'
    || !['OwnClass', 'SelectedClasses'].includes(h.sourceMode) || !Array.isArray(h.sourceClassIds) || h.sourceClassIds.length > 100
    || h.sourceClassIds.some(value => !id(value)) || new Set(h.sourceClassIds).size !== h.sourceClassIds.length
    || h.sourceMode === 'OwnClass' && h.sourceClassIds.length || h.enabled && h.sourceMode === 'SelectedClasses' && !h.sourceClassIds.length
    || !integer(h.rotationSeconds, 15, 600)) return 'INVALID_HOMEWORK';
  const level = value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 0;
  const noiseKeys = ['enabled', 'redLineDbfs', 'mediumLineDbfs', 'disciplineCooldownSeconds', 'highContinuousSeconds'];
  const e = n?.estimated;
  const high = e ? e.highDbA : n?.redLineDbfs, medium = e ? e.mediumDbA : n?.mediumLineDbfs;
  const acoustic = value => value === null || Number.isFinite(value) && value >= 30 && value <= 130;
  if (!(exact(n, noiseKeys) || exact(n, [...noiseKeys, 'estimated'])) || typeof n.enabled !== 'boolean'
    || e != null && (!exact(e, ['highDbA', 'mediumDbA']) || !acoustic(e.highDbA) || !acoustic(e.mediumDbA))
    || !level(n.redLineDbfs) || !level(n.mediumLineDbfs)
    || !integer(n.disciplineCooldownSeconds, 1, 86400) || !integer(n.highContinuousSeconds, 1, 10)
    || medium !== null && (high === null || medium >= high)) return 'INVALID_NOISE';
  if (!exact(f, ['enabled', 'continuousSeconds', 'cooldownSeconds', 'retentionDays', 'captureOnExit', 'extendedRetentionAcknowledged'])
    || typeof f.enabled !== 'boolean' || !integer(f.continuousSeconds, 1, 10) || !integer(f.cooldownSeconds, 30, 300)
    || !integer(f.retentionDays, 1, STUDY_LIMITS.maxPhotoRetentionDays) || f.captureOnExit !== true
    || typeof f.extendedRetentionAcknowledged !== 'boolean') return 'INVALID_PHOTOS';
  // Legacy photo field is a compatibility mirror, never a second qualification timer.
  if (f.continuousSeconds !== n.highContinuousSeconds) return 'INCONSISTENT_THRESHOLD_DURATION';
  if (f.enabled && (!n.enabled || high === null)) return 'PHOTO_THRESHOLD_REQUIRED';
  if (f.enabled && f.retentionDays > 30 && !f.extendedRetentionAcknowledged) return 'RETENTION_ACK_REQUIRED';
  for (const e of t.exceptions) {
    const base = Date.parse(`${e.date}T00:00:00Z`);
    const spans = [-1, 0, 1].map(offset => new Date(base + offset * 86400000).toISOString().slice(0, 10)).filter(validStudyDate)
      .flatMap(date => studyWindowsForDate(s, date))
      .map(w => ({start: Date.parse(w.start + 'Z'), end: Date.parse(w.end + 'Z')})).sort((a, b) => a.start - b.start);
    let previous;
    for (const span of spans) {
      if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
      else previous = {...span};
      if (previous.end - previous.start > 180 * 60000) return 'MERGED_WINDOW_TOO_LONG';
    }
  }
  if (Object.hasOwn(s, 'examSchedule')) {
    const {examSchedule, ...shared} = s;
    const error = validateStudyPolicy({mode: 'Override', settings: {...shared, schedule: examSchedule}}, grade);
    if (error) return error;
  }
  return null;
}

export function validateStudyWrite(body, preview = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = ['requestId', 'termId', 'targetType', 'targetId', 'expectedRevision', 'policy'];
  if (!preview) keys.push('expectedPreviewFingerprint');
  if (preview && Object.hasOwn(body, 'previewDate')) keys.push('previewDate');
  return exact(body, keys) && typeof body.requestId === 'string'
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(body.requestId)
    && id(body.termId) && id(body.targetId) && ['GRADE', 'CLASS'].includes(body.targetType)
    && integer(body.expectedRevision, 0, 2147483646) && !validateStudyPolicy(body.policy, body.targetType === 'GRADE')
    && (preview || typeof body.expectedPreviewFingerprint === 'string' && /^[a-f0-9]{64}$/.test(body.expectedPreviewFingerprint))
    && (!Object.hasOwn(body, 'previewDate') || validStudyDate(body.previewDate));
}

export function resolveStudyPolicy(grade, classroom) {
  grade = normalizeStudyPolicy(grade); classroom = normalizeStudyPolicy(classroom);
  const error = grade && validateStudyPolicy(grade, true) || classroom && validateStudyPolicy(classroom);
  if (error) throw new Error(error);
  const inherited = !classroom || classroom.mode === 'Inherit';
  const chosen = inherited ? grade : classroom;
  if (!chosen) return {source: 'None', settings: null};
  if (chosen.mode === 'Disabled') return {source: 'Disabled', settings: null};
  return {source: inherited ? 'Grade' : 'Class', settings: chosen.settings};
}

// School calendar arithmetic, never the browser/Windows wall clock. Date boundaries
// and holiday substitutions apply to the start date, including cross-midnight windows.
export function studyScheduleForMode(settings, mode = 'Daily') {
  return mode === 'Exam' ? settings?.examSchedule : settings?.schedule;
}

export function studyWindowsForDate(settings, date, mode = 'Daily') {
  if (!validStudyDate(date)) throw new Error('INVALID_DATES');
  const t = studyScheduleForMode(settings, mode);
  if (!t || date < t.effectiveFrom || t.effectiveTo && date > t.effectiveTo) return [];
  const special = t.exceptions.find(e => e.date === date);
  if (special?.kind === 'Skip') return [];
  const midnight = Date.parse(`${date}T00:00:00Z`);
  const weekday = special?.weekday || (new Date(midnight).getUTCDay() || 7);
  const minute = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const spans = t.rules.filter(rule => rule.days.includes(weekday)).map(rule => {
    const start = midnight + minute(rule.start) * 60000;
    return {start, end: start + (minute(rule.end) - minute(rule.start) + 1440) % 1440 * 60000};
  }).sort((a, b) => a.start - b.start);
  const merged = [];
  for (const span of spans) {
    if (merged.length && span.start <= merged.at(-1).end) merged.at(-1).end = Math.max(merged.at(-1).end, span.end);
    else merged.push({...span});
  }
  return merged.map(span => ({start: new Date(span.start).toISOString().slice(0, 19), end: new Date(span.end).toISOString().slice(0, 19)}));
}
