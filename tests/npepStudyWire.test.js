import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateStudyDevice} from '../domain/npep/studyDevice.js';
import {studyWindowsForDate} from '../domain/npep/studySettings.js';
const examples = file => JSON.parse(fs.readFileSync(new URL(`../domain/npep/${file}`,import.meta.url)));
for (const c of examples('study-device-cases.json')) test(c.name,()=>assert.equal(validateStudyDevice(c.definition,c.value),c.expected));
for (const c of examples('study-calendar-cases.json')) test(c.name,()=>assert.deepEqual(studyWindowsForDate(c.settings,c.date),c.windows));
