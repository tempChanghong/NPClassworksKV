// Materialize the last schema before web pairing and seed real legacy rows.
// Never use production data, previous executable downloads or current Prisma fields here.
import assert from 'node:assert/strict';
import {cp, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID, randomBytes} from 'node:crypto';
import {Client} from 'pg';
import {hash, secretHash} from '../../domain/npep/wire.js';

export async function preparePairingUpgrade({root, directory, env, run}) {
  const baseline = '20261002000000_npep_screen_pairing';
  const stage = join(directory,'upgrade-baseline');await mkdir(join(stage,'migrations'),{recursive:true});
  const names = (await readdir(join(root,'prisma/migrations'))).filter(n=>/^\d/.test(n)).sort();
  assert.ok(names.includes(baseline));
  for (const name of names.filter(n=>n < baseline)) await cp(join(root,'prisma/migrations',name),join(stage,'migrations',name),{recursive:true});
  await cp(join(root,'prisma/migrations/migration_lock.toml'),join(stage,'migrations/migration_lock.toml'));
  await cp(join(root,'prisma/schema.prisma'),join(stage,'schema.prisma'));
  const config = join(stage,'prisma.config.mjs');
  const configImport = pathToFileURL(resolve(root,'node_modules/prisma/config.js')).href;
  await writeFile(config,`import {defineConfig} from ${JSON.stringify(configImport)};export default defineConfig({schema:${JSON.stringify(join(stage,'schema.prisma'))},migrations:{path:${JSON.stringify(join(stage,'migrations'))}},datasource:{url:process.env.DATABASE_URL}});`);
  run(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy','--config',config],env);
  const pg = new Client({connectionString:env.DATABASE_URL});await pg.connect();
  const secret = ()=>randomBytes(32).toString('base64url');
  const f = {serverInstanceId:randomUUID(),deploymentEpoch:randomUUID(),schoolId:'upgrade-school',termId:'upgrade-term',
    accountId:'upgrade-admin',sessionId:randomUUID(),deviceId:randomUUID(),installationId:randomUUID(),credentialId:randomUUID(),
    deviceSecret:secret(),pairingId:randomUUID(),pairingSecret:secret(),pendingId:randomUUID(),pendingSecret:secret(),
    approvalId:randomUUID(),credentialExpiresAt:new Date(Date.now()+86400000).toISOString()};
  try {
    const column = await pg.query(`SELECT 1 FROM information_schema.columns WHERE table_name='ClassroomScreenBinding' AND column_name='npepPairingEnabled'`);
    assert.equal(column.rowCount,0,'old schema really lacks preauthorization');
    const missing = await pg.query(`SELECT to_regclass('public."NpepScreenPairingTicket"') AS table`);assert.equal(missing.rows[0].table,null);
    await pg.query('BEGIN');
    await pg.query(`INSERT INTO "NpepDeployment" VALUES ('current',$1,$2)`,[f.serverInstanceId,f.deploymentEpoch]);
    await pg.query(`INSERT INTO "School" (id,code,name) VALUES ($1,'UPGRADE','升级测试学校')`,[f.schoolId]);
    await pg.query(`INSERT INTO "Account" (id,provider,"providerId") VALUES ($1,'upgrade-test','upgrade-admin')`,[f.accountId]);
    await pg.query(`INSERT INTO "SchoolMember" ("schoolId","accountId",role) VALUES ($1,$2,'ADMIN')`,[f.schoolId,f.accountId]);
    await pg.query(`INSERT INTO "AccountSession" (id,"accountId","refreshTokenHash","expiresAt") VALUES ($1,$2,$3,$4)`,
      [f.sessionId,f.accountId,hash(secret()),new Date(Date.now()+3600000)]);
    await pg.query(`INSERT INTO "AcademicTerm" (id,"schoolId",name,"academicYear",semester,status) VALUES ($1,$2,'升级测试学期',2099,1,'ACTIVE')`,[f.termId,f.schoolId]);
    for(const id of ['connected','approved','pending']){
      await pg.query(`INSERT INTO "Workspace" (id,"termId",name,code,type) VALUES ($1,$2,$1,$1,'ADMIN_CLASS')`,['upgrade-class-'+id,f.termId]);
      await pg.query(`INSERT INTO "ClassroomScreenBinding" (id,"schoolId","administrativeClassId",name,"tokenHash","createdByAccountId") VALUES ($1,$2,$3,$1,$4,$5)`,
        ['upgrade-screen-'+id,f.schoolId,'upgrade-class-'+id,hash(secret()),f.accountId]);
    }
    await pg.query(`INSERT INTO "NpepDevice" (id,"installationId","credentialId","secretHash","serverInstanceId","deploymentEpoch","schoolId","administrativeClassId","screenBindingId","bindingRevision","deviceName","credentialExpiresAt") VALUES ($1,$2,$3,$4,$5,$6,$7,'upgrade-class-connected','upgrade-screen-connected',1,'旧版已连接设备',$8)`,
      [f.deviceId,f.installationId,f.credentialId,secretHash(f.deviceSecret),f.serverInstanceId,f.deploymentEpoch,f.schoolId,f.credentialExpiresAt]);
    for(const approved of [false,true]){
      const id=approved?f.pairingId:f.pendingId, pairingSecret=approved?f.pairingSecret:f.pendingSecret;
      await pg.query(`INSERT INTO "NpepPairing" (id,"installationId","requestId","createDigest","secretHash","userCode","deviceName","appVersion","serverInstanceId","deploymentEpoch",state,"expiresAt") VALUES ($1,$2,$3,$4,$5,$6,'旧版待配对设备','legacy',$7,$8,$9,$10)`,
        [id,randomUUID(),randomUUID(),hash('legacy fixture'),secretHash(pairingSecret),approved?'ABCD2345':'WXYZ2345',f.serverInstanceId,f.deploymentEpoch,approved?'APPROVED':'PENDING',new Date(Date.now()+600000)]);
    }
    const snapshot={schoolId:f.schoolId,schoolName:'升级测试学校',administrativeClassId:'upgrade-class-approved',administrativeClassName:'upgrade-class-approved',
      screenBindingId:'upgrade-screen-approved',screenBindingName:'upgrade-screen-approved',bindingRevision:1,capabilities:['device.status']};
    await pg.query(`UPDATE "NpepPairing" SET "schoolId"=$2,"screenBindingId"='upgrade-screen-approved',"approvalId"=$3,"approvalRequestId"=$4,"approvalDigest"=$5,"approverId"=$6,"approverSessionId"=$7,"approverTokenVersion"=1,"approvalSnapshot"=$8 WHERE id=$1`,
      [f.pairingId,f.schoolId,f.approvalId,randomUUID(),hash('legacy approval'),f.accountId,f.sessionId,snapshot]);
    await pg.query('COMMIT');
    assert.equal((await pg.query(`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE migration_name=$1`,[baseline])).rows[0].count,0);
  } catch(error){await pg.query('ROLLBACK');throw error;} finally {await pg.end();}
  const file = join(directory,'pairing-upgrade.json');await writeFile(file,JSON.stringify(f),{mode:0o600});
  console.log(`Legacy pairing upgrade baseline seeded (${names.filter(n=>n<baseline).length} migrations, synthetic data).`);
  return file;
}
