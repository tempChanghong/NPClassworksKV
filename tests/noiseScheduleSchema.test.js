import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import Ajv from 'ajv';
import {validatePolicy} from '../domain/npep/noiseScheduleRules.js';
const schema = JSON.parse(readFileSync(new URL('../domain/npep/noise-schedule-policy.schema.json', import.meta.url)));
const ajv = new Ajv({strict: true, strictTypes: false});
ajv.addSchema(schema);
const grade = ajv.compile({$ref: schema.$id + '#/definitions/gradePolicy'});
const classroom = ajv.compile({$ref: schema.$id + '#/definitions/classPolicy'});
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/noise-schedule-cases.json', import.meta.url)));
test('policy schema plus semantic validator match shared cases', () => {
  for (const item of fixtures.validation) {
    const valid = item.policy === null || (item.grade ? grade(item.policy) : classroom(item.policy)) && validatePolicy(item.policy, item.grade) === null;
    assert.equal(valid, item.expected === null, item.name);
  }
});
test('schema rejects missing or unknown fields, noninteger weekdays and implicit coercion', () => {
  for (const value of [
    {}, {mode: 'Disabled'}, {mode: 'Disabled', rules: [], enabled: true},
    {mode: 'Override', rules: [{days: ['1'], start: '19:00', end: '20:00'}]},
    {mode: 'Override', rules: [{days: [1.5], start: '19:00', end: '20:00'}]},
    {mode: 'Override', rules: [{days: [1], start: '19:00', end: '20:00', audio: true}]},
  ]) assert.equal(classroom(value), false);
});
