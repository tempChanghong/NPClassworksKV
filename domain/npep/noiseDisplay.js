import {UUID, OPAQUE_ID} from './wire.js';

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const schoolCalendar = value => {
  if (typeof value !== 'string' || !/^(?:[2-9]\d{3})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/.test(value))
    return false;
  const instant = new Date(`${value}Z`);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === `${value}Z`;
};
export const validDisplayWindow = value => exact(value, ['start', 'end'])
  && schoolCalendar(value.start) && schoolCalendar(value.end) && value.start < value.end;

export function validateDisplayReturn(body) {
  const required = ['requestId', 'window'];
  if (!exact(body, required) && !exact(body, [...required, 'offlineStartedAt'])
    && !exact(body, [...required, 'offlineStartedAt', 'returnMinutes'])) return false;
  return UUID.test(body.requestId) && validDisplayWindow(body.window)
    && (body.offlineStartedAt === undefined || (typeof body.offlineStartedAt === 'string'
      && !Number.isNaN(Date.parse(body.offlineStartedAt)) && /Z$/.test(body.offlineStartedAt)))
    && (body.returnMinutes === undefined || (body.offlineStartedAt !== undefined
      && Number.isInteger(body.returnMinutes) && body.returnMinutes >= 1 && body.returnMinutes <= 60));
}

export function validateDisplaySetting(body) {
  if (!exact(body, ['requestId', 'termId', 'targetType', 'targetId', 'expectedRevision', 'returnMinutes'])) return false;
  return UUID.test(body.requestId) && OPAQUE_ID.test(body.termId) && OPAQUE_ID.test(body.targetId)
    && ['GRADE', 'CLASS'].includes(body.targetType) && Number.isInteger(body.expectedRevision) && body.expectedRevision >= 0
    && (body.returnMinutes === null || (Number.isInteger(body.returnMinutes)
      && body.returnMinutes >= 1 && body.returnMinutes <= 60));
}

export function resolvedDisplayMinutes(settings, gradeId, classId) {
  const local = settings.find(s => s.targetType === 'CLASS' && s.targetId === classId);
  if (local) return {returnMinutes: local.returnMinutes, source: 'Class'};
  const grade = settings.find(s => s.targetType === 'GRADE' && s.targetId === gradeId);
  if (grade) return {returnMinutes: grade.returnMinutes, source: 'Grade'};
  return {returnMinutes: 10, source: 'Default'};
}
