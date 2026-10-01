// N4.3 pure rules. Identical copy in NPClassworks; unified tests check its SHA-256.
const weekMinutes = 7 * 1440;
const minute = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
  ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3)) : null;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k));
function expand(rules) {
  return [-1, 0, 1].flatMap(week => rules.flatMap(rule => rule.days.map(day => {
    const start = week * weekMinutes + (day - 1) * 1440 + minute(rule.start);
    return {start, end: start + (minute(rule.end) - minute(rule.start) + 1440) % 1440};
  })));
}
function merge(spans) {
  const result = [];
  for (const span of spans.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else result.push({...span});
  }
  return result;
}
export function validatePolicy(policy, grade = false) {
  if (policy == null) return null;
  if (!exact(policy, ['mode', 'rules']) || !['Inherit', 'Override', 'Disabled'].includes(policy.mode) || grade && policy.mode === 'Inherit') return 'INVALID_MODE';
  if (!Array.isArray(policy.rules) || policy.rules.length > 32) return 'INVALID_RULES';
  if (policy.mode !== 'Override') return policy.rules.length ? 'UNEXPECTED_RULES' : null;
  if (!policy.rules.length) return 'EMPTY_RULES';
  for (const rule of policy.rules) {
    if (!exact(rule, ['days', 'start', 'end']) || !Array.isArray(rule.days) || rule.days.length < 1 || rule.days.length > 7
      || rule.days.some(d => !Number.isInteger(d) || d < 1 || d > 7) || new Set(rule.days).size !== rule.days.length
      || minute(rule.start) === null || minute(rule.end) === null) return 'INVALID_RULE';
    const length = (minute(rule.end) - minute(rule.start) + 1440) % 1440;
    if (!length || length > 180) return 'INVALID_DURATION';
  }
  return merge(expand(policy.rules)).some(w => w.end - w.start > 180) ? 'MERGED_WINDOW_TOO_LONG' : null;
}
export function resolvePolicy(grade, classroom) {
  const error = validatePolicy(grade, true) || validatePolicy(classroom);
  if (error) throw new Error(error);
  const inherited = classroom == null || classroom.mode === 'Inherit';
  const selected = inherited ? grade : classroom;
  return selected == null ? {source: 'None', rules: []} : selected.mode === 'Disabled' ? {source: 'Disabled', rules: []}
    : {source: inherited ? 'Grade' : 'Class', rules: selected.rules};
}
const calendar = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?$/.test(value)) throw new Error('INVALID_SCHOOL_CALENDAR');
  // UTC methods are arithmetic on school calendar fields, not a timezone conversion.
  // Rules end on whole minutes. JS millisecond precision preserves all minute comparisons.
  const base = value.slice(0, 19);
  const milliseconds = (value.slice(20) || '').slice(0, 3).padEnd(3, '0');
  const date = new Date(`${base}.${milliseconds}Z`);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 9998
    || date.toISOString().slice(0, 19) !== base) throw new Error('INVALID_SCHOOL_CALENDAR');
  return date;
};
const format = ms => new Date(ms).toISOString().slice(0, 19);
export function windows(policy, schoolNow) {
  const now = calendar(schoolNow);
  const error = validatePolicy({mode: policy.rules.length ? 'Override' : 'Disabled', rules: policy.rules});
  if (error) throw new Error(error);
  const monday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - ((now.getUTCDay() + 6) % 7) * 86400000;
  const spans = merge(expand(policy.rules)).map(w => ({start: monday + w.start * 60000, end: monday + w.end * 60000}));
  const view = span => span ? {start: format(span.start), end: format(span.end)} : null;
  return {current: view(spans.find(w => w.start <= now.getTime() && now.getTime() < w.end)), next: view(spans.find(w => w.start > now.getTime()))};
}
export const overlaps = (a, b) => a.start < b.end && b.start < a.end;
export function evaluate(input) {
  const block = (reason, window = null) => ({action: input.owner === 'Schedule' ? 'Stop' : 'Wait', reason, window});
  if (!['None', 'Manual', 'Schedule'].includes(input.owner)) throw new Error('INVALID_OWNER');
  if (input.owner === 'Manual') return {action: 'Wait', reason: 'MANUAL_ACTIVE', window: null};
  if (!input.eligible) return block('NOT_ELIGIBLE');
  if (!input.leaseValid) return block('POLICY_EXPIRED');
  if (['None', 'Disabled'].includes(input.policy.source)) return block('DISABLED');
  if (input.examBlocked) return block('EXAM_PAUSED');
  if (!input.clock.fresh || !input.clock.canStart || !input.clock.now || input.clock.dateNeedsReview) return block('SCHOOL_CLOCK_UNAVAILABLE');
  const window = windows(input.policy, input.clock.now).current;
  if (!window) return block('OUTSIDE_WINDOW');
  if (input.blocks.some(b => b.kind === 'Skipped' && overlaps(b.window, window))) return block('WINDOW_SKIPPED', window);
  if (input.blocks.some(b => b.kind === 'Failed' && b.microphoneKey === input.microphoneKey && overlaps(b.window, window))) return block('WINDOW_FAILED', window);
  if (!input.microphoneConfigured) return block('MICROPHONE_NOT_CONFIGURED', window);
  if (input.captureBusy) return {action: 'Wait', reason: 'CAPTURE_BUSY', window};
  return {action: input.owner === 'Schedule' ? 'Keep' : 'Start', reason: 'WINDOW_ACTIVE', window};
}
export function leaseValid(lease, current) {
  return typeof lease.hostId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(lease.hostId)
    && lease.hostId !== '00000000-0000-0000-0000-000000000000' && typeof current.hostId === 'string' && lease.hostId.toLowerCase() === current.hostId.toLowerCase()
    && typeof lease.scope === 'string' && lease.scope.trim() !== '' && lease.scope === current.scope
    && Number.isSafeInteger(lease.revision) && lease.revision >= 0 && lease.revision === current.revision
    && Number.isFinite(lease.confirmedAtMs) && lease.confirmedAtMs >= 0 && Number.isFinite(lease.lifetimeMs) && lease.lifetimeMs > 0 && lease.lifetimeMs <= 86400000
    && Number.isFinite(current.elapsedMs) && current.elapsedMs >= lease.confirmedAtMs && current.elapsedMs - lease.confirmedAtMs < lease.lifetimeMs;
}
