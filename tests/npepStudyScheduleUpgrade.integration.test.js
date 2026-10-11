import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Client} from 'pg';
import {validateStudyPolicy, resolveStudyPolicy, studyWindowsForDate} from '../domain/npep/studySettings.js';
import {resolvePolicy, windows} from '../domain/npep/noiseScheduleRules.js';

test('production migration imports only unconfigured legacy schedules and preserves effective new settings', {
  skip: !process.env.NPEP_STUDY_UPGRADE_FIXTURE, timeout: 30000,
}, async t => {
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  assert.match(url.pathname, /^\/npclassworks_test(?:_[a-z0-9_]+)?$/);
  const f = JSON.parse(await readFile(process.env.NPEP_STUDY_UPGRADE_FIXTURE, 'utf8'));
  const pg = new Client({connectionString: url.href});
  await pg.connect(); t.after(() => pg.end());
  const load = async () => (await pg.query(`SELECT * FROM "NpepStudySetting" WHERE "schoolId"=$1 ORDER BY "targetType","targetId"`, [f.schoolId])).rows;
  const rows = await load();
  const entry = (all, type, id) => all.find(row => row.targetType === type && row.targetId === id);
  for (const row of rows) assert.equal(validateStudyPolicy(row.policy, row.targetType === 'GRADE'), null);
  for (const previous of f.existing) {
    assert.deepEqual(entry(rows, previous.targetType, previous.targetId).policy, previous.policy);
    assert.equal(entry(rows, previous.targetType, previous.targetId).revision, 7);
  }
  const grade = entry(rows, 'GRADE', f.grades.legacy);
  assert.deepEqual(grade.policy.settings.schedule.rules, entry(f.legacy, 'GRADE', f.grades.legacy).policy.rules);
  assert.equal(grade.policy.settings.schedule.rules[0].start, '19:15', 'explicit old times are never replaced with 19:00');
  assert.equal(entry(rows, 'CLASS', f.classes.override).policy.settings.schedule.rules[0].start, '20:00');
  assert.equal(entry(rows, 'CLASS', f.classes.closed).policy.mode, 'Disabled');
  for (const name of ['protected', 'protectedClosed', 'disabledGrade', 'empty']) {
    assert.equal(entry(rows, 'CLASS', f.classes[name]), undefined, 'a new inherited grade strategy remains authoritative');
  }
  assert.equal(entry(rows, 'GRADE', f.grades.empty), undefined);
  assert.equal(rows.some(row => row.targetId.endsWith('deleted-grade')), false, 'deleted targets are not resurrected');
  const migrated = rows.filter(row => !entry(f.existing, row.targetType, row.targetId));
  assert.equal(migrated.length, 6);
  for (const row of migrated) {
    assert.equal(row.revision, 1);
    assert.equal(row.updatedBy, 'fixture-admin');
    if (row.policy.mode === 'Override') {
      assert.equal(row.policy.settings.photos.enabled, false);
      assert.equal(row.policy.settings.noise.redLineDbfs, null);
      assert.deepEqual(row.policy.settings.examSchedule.rules, []);
      assert.deepEqual(row.policy.settings.schedule.exceptions, []);
    }
  }
  const before = resolvePolicy(entry(f.legacy, 'GRADE', f.grades.legacy).policy, entry(f.legacy, 'CLASS', f.classes.override).policy);
  const after = resolveStudyPolicy(grade.policy, entry(rows, 'CLASS', f.classes.override).policy);
  assert.deepEqual(studyWindowsForDate(after.settings, '2026-10-12'), [windows(before, '2026-10-12T20:30:00').current]);
  const yesterday = (await pg.query(`SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date-1,'YYYY-MM-DD') AS date`)).rows[0].date;
  const night = entry(rows, 'GRADE', f.grades.overnight).policy;
  assert.ok(night.settings.schedule.effectiveFrom <= yesterday);
  assert.equal(studyWindowsForDate(night.settings, yesterday)[0].start, `${yesterday}T23:00:00`);
  const originals = (await pg.query(`SELECT "targetType","targetId",policy,revision FROM "NpepNoiseSchedulePolicy" WHERE "schoolId"=$1`, [f.schoolId])).rows;
  for (const old of f.legacy) assert.deepEqual(entry(originals, old.targetType, old.targetId), old);
  const audits = await pg.query(`SELECT * FROM "NpepAudit" WHERE "schoolId"=$1 AND action='NOISE_SCHEDULE_MIGRATED'`, [f.schoolId]);
  assert.equal(audits.rowCount, migrated.length);
  assert.ok(audits.rows.every(row => row.actorId === null));
  const marker = await pg.query(`SELECT finished_at FROM "_prisma_migrations" WHERE migration_name=$1`, [f.migration]);
  assert.ok(marker.rows[0]?.finished_at, 'production migrate deploy actually applied the migration');
  await pg.query(await readFile(new URL(`../prisma/migrations/${f.migration}/migration.sql`, import.meta.url), 'utf8'));
  assert.deepEqual(await load(), rows, 'retry cannot alter revisions, policies or timestamps');
  assert.equal((await pg.query(`SELECT count(*)::int AS count FROM "NpepAudit" WHERE "schoolId"=$1 AND action='NOISE_SCHEDULE_MIGRATED'`, [f.schoolId])).rows[0].count, migrated.length);
});
