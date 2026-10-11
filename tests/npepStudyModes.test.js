import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultStudySettings, validateStudyPolicy, studyWindowsForDate} from '../domain/npep/studySettings.js';
import {validateStudyDevice} from '../domain/npep/studyDevice.js';
import cases from '../domain/npep/study-device-cases.json' with {type:'json'};

test('old daily schedules do not enable exam; each mode can be empty independently', () => {
  const s = defaultStudySettings(); s.schedule.effectiveFrom = '2026-10-12'; s.schedule.rules[0].days = [1];
  assert.equal(validateStudyPolicy({mode:'Override', settings:s}), null);
  assert.equal(studyWindowsForDate(s, '2026-10-12').length, 1);
  assert.deepEqual(studyWindowsForDate(s, '2026-10-12', 'Exam'), []);
  s.examSchedule = structuredClone(s.schedule); s.examSchedule.rules[0].start = '20:00';
  s.schedule = {timeZone:'Asia/Shanghai', effectiveFrom:'', effectiveTo:null, rules:[], exceptions:[]};
  assert.equal(validateStudyPolicy({mode:'Override', settings:s}), null);
  assert.deepEqual(studyWindowsForDate(s, '2026-10-12'), []);
  assert.equal(studyWindowsForDate(s, '2026-10-12', 'Exam')[0].start, '2026-10-12T20:00:00');
  delete s.examSchedule;
  assert.deepEqual(studyWindowsForDate(s, '2026-10-12', 'Exam'), []);
});
test('exam schedule undergoes the same strict calendar and duration validation', () => {
  const s = defaultStudySettings(); s.schedule.rules = []; s.examSchedule = structuredClone(s.schedule);
  s.examSchedule.rules = [{days:[1],start:'18:00',end:'22:00'}]; s.examSchedule.effectiveFrom = '2026-10-12';
  assert.ok(validateStudyPolicy({mode:'Override', settings:s}));
  s.examSchedule.rules[0].end = '20:00'; assert.equal(validateStudyPolicy({mode:'Override', settings:s}), null);
  s.examSchedule.effectiveFrom = '2026-02-30'; assert.equal(validateStudyPolicy({mode:'Override',settings:s}), 'INVALID_DATES');
});
test('mode-specific configuration is accepted without changing old daily fixtures', () => {
  const c = structuredClone(cases.find(c => c.definition === 'configuration' && c.expected).value);
  c.effective.settings.examSchedule = {timeZone:'Asia/Shanghai', effectiveFrom:'', effectiveTo:null, rules:[], exceptions:[]};
  assert.equal(validateStudyDevice('configuration', c), true);
  c.effective.settings.examSchedule.timeZone = 'UTC'; assert.equal(validateStudyDevice('configuration', c), false);
});
