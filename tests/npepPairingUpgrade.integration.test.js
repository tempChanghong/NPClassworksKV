import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {randomUUID, randomBytes} from 'node:crypto';
import {dirname, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {hash, secretHash} from '../domain/npep/wire.js';

test('Web pairing upgrade from real legacy schema and synthetic existing rows', {skip:!process.env.NPEP_PAIRING_UPGRADE_FIXTURE,timeout:60000}, async t=>{
  const url=new URL(process.env.DATABASE_URL);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/npclassworks_test');
  assert.equal(process.env.INTEGRATION_NATIVE_POSTGRES,'true');
  const f=JSON.parse(await readFile(process.env.NPEP_PAIRING_UPGRADE_FIXTURE,'utf8'));
  const [{prisma},{default:express},{createNpepRouter},{readDeployment},{generateAccessToken}]=await Promise.all([
    import('../utils/prisma.js'),import('express'),import('../routes/v2/npep.js'),import('../domain/npep/deployment.js'),import('../utils/tokenManager.js')]);
  const gate=join(dirname(process.env.NPEP_PAIRING_UPGRADE_FIXTURE),'upgrade-gate.json');
  await writeFile(gate,JSON.stringify({enabled:true,serverInstanceId:f.serverInstanceId,deploymentEpoch:f.deploymentEpoch}));
  const identity={serverInstanceId:f.serverInstanceId,deploymentEpoch:f.deploymentEpoch};
  const app=express();app.use('/api/v2/npep',createNpepRouter({deployment:()=>readDeployment({NPEP_ENABLED:'true',NPEP_DEPLOYMENT_FILE:gate}),rateLimits:false}));
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await prisma.$disconnect();});
  const origin=`http://127.0.0.1:${server.address().port}/api/v2/npep`;
  const admin=generateAccessToken(await prisma.account.findUnique({where:{id:f.accountId}}),f.sessionId);
  const auth=`npep1.${f.credentialId}.${f.deviceSecret}`, req=extra=>({requestId:randomUUID(),...extra});
  async function request(path, bearer, body){
    const response=await fetch(origin+path,{method:body?'POST':'GET',signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json','X-NPEP-Version':'0.1',...(body?{}:{'X-Request-Id':randomUUID()}),...(bearer?{Authorization:`Bearer ${bearer}`}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,...await response.json()};
  }
  await t.test('Migration defaults preserve old binding, approval and device credentials',async()=>{
    const bindings=await prisma.classroomScreenBinding.findMany({where:{schoolId:f.schoolId}});
    assert.equal(bindings.length,3);for(const b of bindings){assert.equal(b.npepPairingEnabled,false);assert.equal(b.npepPairingRevision,1);assert.equal(b.npepBindingRevision,1);}
    for(const id of [f.pairingId,f.pendingId]){const p=await prisma.npepPairing.findUnique({where:{id}});assert.equal(p.approvalSource,'ADMIN');assert.equal(p.preauthorizationRevision,null);}
    const d=await prisma.npepDevice.findUnique({where:{id:f.deviceId}});
    assert.equal(d.state,'ACTIVE');assert.equal(d.credentialId,f.credentialId);assert.equal(d.secretHash,secretHash(f.deviceSecret));
    // Compare stored epoch directly; Windows/PG session time zones must not affect migration assertions.
    const [stored]=await prisma.$queryRaw`SELECT floor(extract(epoch FROM "credentialExpiresAt") * 1000)::bigint AS expiry FROM "NpepDevice" WHERE id=${f.deviceId}::uuid`;
    assert.equal(stored.expiry,BigInt(Date.parse(f.credentialExpiresAt)));
  });
  await t.test('Existing bearer still opens a status session and reports after migration',async()=>{
    assert.equal((await request('/device/me',auth)).status,200);
    const session=await request('/device/sessions',auth,req({...identity,runId:randomUUID(),expectedStatusEpoch:0}));
    assert.equal(session.status,201,session.error?.code);
    const status={appVersion:'legacy',mode:'DAILY',modePhase:'IDLE',modeRevision:0,automaticRecording:'DISABLED',recording:'IDLE',
      classIsland:{connection:'DISCONNECTED',bridgeVersion:null},examAware:{connection:'UNKNOWN',bridgeVersion:null}};
    const result=await request('/device/status',auth,req({...identity,sessionId:session.data.sessionId,statusEpoch:session.data.statusEpoch,sequence:1,sampleAgeMs:1,status}));
    assert.equal(result.status,200,result.error?.code);
  });
  async function confirm(id,secret,approvalId){
    return request(`/pairings/${id}/confirm`,`npepp1.${id}.${secret}`,req({...identity,approvalId,credentialId:randomUUID(),deviceSecret:randomBytes(32).toString('base64url')}));
  }
  await t.test('Already approved legacy pairing confirms without web preauthorization',async()=>{
    const p=await request(`/pairings/${f.pairingId}`,`npepp1.${f.pairingId}.${f.pairingSecret}`);
    assert.equal(p.data.state,'APPROVED');assert.equal((await confirm(f.pairingId,f.pairingSecret,f.approvalId)).status,201);
  });
  await t.test('Pending legacy code can still be approved and confirmed',async()=>{
    const p=await request(`/schools/${f.schoolId}/pairings/${f.pendingId}/approve`,admin,req({screenBindingId:'upgrade-screen-pending',capabilities:['device.status']}));
    assert.equal(p.status,200,p.error?.code);assert.equal((await confirm(f.pendingId,f.pendingSecret,p.data.approvalId)).status,201);
  });
  await t.test('New screen still defaults to disabled and re-running migrate deploy is harmless',async()=>{
    const b=await prisma.classroomScreenBinding.create({data:{schoolId:f.schoolId,administrativeClassId:'upgrade-class-pending',name:'升级后新增大屏',tokenHash:hash(randomUUID()),createdByAccountId:f.accountId}});
    assert.equal(b.npepPairingEnabled,false);
    const before=await prisma.npepDevice.findUnique({where:{id:f.deviceId}});
    const migration=spawnSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'],{env:process.env,encoding:'utf8',windowsHide:true});
    assert.equal(migration.status,0,migration.stderr);assert.match(migration.stdout,/No pending migrations/);
    assert.deepEqual(await prisma.npepDevice.findUnique({where:{id:f.deviceId}}),before);
    assert.equal((await request('/device/me',auth)).status,200);
  });
});
