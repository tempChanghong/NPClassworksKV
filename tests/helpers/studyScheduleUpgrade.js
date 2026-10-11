import assert from 'node:assert/strict';
import {cp, mkdir, readdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {defaultStudySettings} from '../../domain/npep/studySettings.js';

// Seed the actual previous schema, then let production prisma migrate deploy run
// the new SQL. No production records or credentials enter this fixture.
export async function prepareStudyScheduleUpgrade({root, directory, env, run}) {
  const migration = '20261012000000_npep_legacy_study_schedule';
  const stage = join(directory, 'study-upgrade-baseline');
  await mkdir(join(stage, 'migrations'), {recursive: true});
  const names = (await readdir(join(root, 'prisma/migrations'))).filter(name => /^\d/.test(name)).sort();
  assert.ok(names.includes(migration));
  for (const name of names.filter(name => name < migration)) {
    await cp(join(root, 'prisma/migrations', name), join(stage, 'migrations', name), {recursive: true});
  }
  await cp(join(root, 'prisma/migrations/migration_lock.toml'), join(stage, 'migrations/migration_lock.toml'));
  await cp(join(root, 'prisma/schema.prisma'), join(stage, 'schema.prisma'));
  const config = join(stage, 'prisma.config.mjs');
  await writeFile(config, `import {defineConfig} from ${JSON.stringify(pathToFileURL(resolve(root, 'node_modules/prisma/config.js')).href)};export default defineConfig({schema:${JSON.stringify(join(stage, 'schema.prisma'))},migrations:{path:${JSON.stringify(join(stage, 'migrations'))}},datasource:{url:process.env.DATABASE_URL}});`);
  run(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy', '--config', config], env);
  const prefix = `study-upgrade-${randomUUID()}`, key = value => `${prefix}-${value}`;
  const rules = (start = '19:15', end = '21:30', days = [1, 3, 5]) => ({mode: 'Override', rules: [{start, end, days}]});
  const study = (start, end) => {
    const settings = defaultStudySettings();
    settings.schedule.effectiveFrom = '2026-10-12';
    settings.schedule.rules[0] = {days: [1], start, end};
    settings.homework.rotationSeconds = 75;
    return {mode: 'Override', settings};
  };
  const f = {migration, schoolId: key('school'), termId: key('term'), grades: {}, classes: {}, legacy: [], existing: []};
  const pg = new Client({connectionString: env.DATABASE_URL});
  await pg.connect();
  try {
    await pg.query('BEGIN');
    await pg.query(`INSERT INTO "School" (id,code,name) VALUES ($1,$2,'旧排程升级测试学校')`, [f.schoolId, prefix]);
    await pg.query(`INSERT INTO "AcademicTerm" (id,"schoolId",name,"academicYear",semester,status) VALUES ($1,$2,'测试学期',2026,1,'ACTIVE')`, [f.termId, f.schoolId]);
    for (const name of ['legacy', 'protected', 'disabled', 'overnight', 'empty']) {
      const id = f.grades[name] = key(name);
      await pg.query(`INSERT INTO "Grade" (id,"termId",code,name) VALUES ($1,$2,$3,$3)`, [id, f.termId, name]);
    }
    for (const [name, grade] of Object.entries({inherit: 'legacy', override: 'legacy', closed: 'legacy',
      custom: 'legacy', disabled: 'legacy', explicitInherit: 'legacy', protected: 'protected',
      protectedClosed: 'protected', disabledGrade: 'disabled', overnight: 'overnight', empty: 'empty', standalone: null})) {
      const id = f.classes[name] = key(name + '-class');
      await pg.query(`INSERT INTO "Workspace" (id,"termId","gradeId",name,code,type) VALUES ($1,$2,$3,$4,$4,'ADMIN_CLASS')`, [id, f.termId, grade ? f.grades[grade] : null, name]);
    }
    const save = async (table, list, targetType, targetId, policy, revision) => {
      await pg.query(`INSERT INTO "${table}" ("schoolId","termId","targetType","targetId",revision,policy,"updatedBy","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,'fixture-admin',CASE WHEN $7 THEN CURRENT_TIMESTAMP ELSE TIMESTAMPTZ '2026-10-11T00:00:00Z' END)`, [f.schoolId, f.termId, targetType, targetId, revision, policy, table === 'NpepStudySetting' || targetId === f.grades.overnight]);
      list.push({targetType, targetId, policy, revision});
    };
    const old = (type, id, policy) => save('NpepNoiseSchedulePolicy', f.legacy, type, id, policy, 9);
    const existing = (type, id, policy) => save('NpepStudySetting', f.existing, type, id, policy, 7);
    await old('GRADE', f.grades.legacy, rules());
    await old('GRADE', f.grades.protected, rules());
    await old('GRADE', f.grades.disabled, rules());
    await old('GRADE', f.grades.overnight, rules('23:00', '01:00', [1, 2, 3, 4, 5, 6, 7]));
    await old('CLASS', f.classes.inherit, {mode: 'Inherit', rules: []});
    await old('CLASS', f.classes.closed, {mode: 'Disabled', rules: []});
    for (const name of ['override', 'custom', 'disabled', 'explicitInherit', 'protected', 'protectedClosed', 'disabledGrade', 'standalone']) {
      await old('CLASS', f.classes[name], name === 'protectedClosed' ? {mode: 'Disabled', rules: []} : rules('20:00', '22:00', [1, 2]));
    }
    await old('GRADE', key('deleted-grade'), rules());
    await existing('GRADE', f.grades.protected, study('19:40', '21:40'));
    await existing('GRADE', f.grades.disabled, {mode: 'Disabled', settings: null});
    await existing('CLASS', f.classes.custom, study('18:45', '20:45'));
    await existing('CLASS', f.classes.disabled, {mode: 'Disabled', settings: null});
    await existing('CLASS', f.classes.explicitInherit, {mode: 'Inherit', settings: null});
    await pg.query('COMMIT');
  } catch (error) { await pg.query('ROLLBACK'); throw error; }
  finally { await pg.end(); }
  const file = join(directory, 'study-upgrade-fixture.json');
  await writeFile(file, JSON.stringify(f), {mode: 0o600});
  return file;
}
