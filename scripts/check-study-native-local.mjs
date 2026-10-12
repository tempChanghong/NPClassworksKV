import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import express from 'express';
import {createNpepRouter} from '../routes/v2/npep.js';
import {defaultStudySettings} from '../domain/npep/studySettings.js';
import {secretHash} from '../domain/npep/wire.js';
const [dll,outputDirectory]=process.argv.slice(2);
if(!dll || !outputDirectory || !fs.existsSync(dll))throw new Error('Pass the built native acceptance DLL and an isolated evidence directory');
const output=path.resolve(outputDirectory);fs.mkdirSync(output,{recursive:true});
const fixturePath=path.join(output,`study-http-fixture-${randomUUID()}.json`);
const id=randomUUID(),credentialId=randomUUID(),secret=randomBytes(32).toString('base64url');
const deployment={serverInstanceId:randomUUID(),deploymentEpoch:randomUUID()};
const term={id:'term',schoolId:'school',status:'ACTIVE'};
const classroom={id:'class',name:'行政一班',subjectRules:[],termId:term.id,gradeId:'grade',isActive:true,type:'ADMIN_CLASS',term};
const binding={id:'screen',schoolId:'school',administrativeClassId:'class',isActive:true,npepBindingRevision:1,administrativeClass:classroom};
const session={sessionId:randomUUID(),deviceId:id,runId:randomUUID(),statusEpoch:1,expiresAt:new Date(Date.now()+120000)};
const device={id,credentialId,secretHash:secretHash(secret),...deployment,schoolId:'school',administrativeClassId:'class',screenBindingId:'screen',bindingRevision:1,
  state:'ACTIVE',sessionId:session.sessionId,statusEpoch:1,controlEpoch:randomUUID(),credentialExpiresAt:new Date(Date.now()+120000)};
const settings=defaultStudySettings();settings.schedule.effectiveFrom='2026-10-12';settings.schedule.rules[0]={days:[1],start:'19:00',end:'19:01'}; // Short synthetic window, not a school default.
settings.noise.redLineDbfs=-40;settings.noise.mediumLineDbfs=-50; // Explicit synthetic fixture thresholds; never a calibrated school default.
let policy=null,stored=null,noiseStored=null;
const requests=new Map(),audits=[];
const tx={
  account:{findUnique:async()=>({id:'fixture-admin',tokenVersion:1,localDisabled:false})},
  accountSession:{findUnique:async()=>({id:'fixture-session',accountId:'fixture-admin',revokedAt:null,expiresAt:new Date(Date.now()+120000)})},
  schoolMember:{findUnique:async q=>q.where.schoolId_accountId.schoolId==='school'?{role:'OWNER'}:null},
  npepDeployment:{findUnique:async()=>deployment},
  npepDevice:{findUnique:async q=>q.where.credentialId===credentialId || q.where.id===id?device:null,findMany:async()=>[device]},
  classroomScreenBinding:{findUnique:async q=>q.where.id==='screen'?binding:null,findMany:async()=>[binding]},
  workspace:{findUnique:async q=>q.where.id==='class'?classroom:null,findMany:async q=>{
    if(q.where.type!=='ADMIN_CLASS'||q.where.termId!=='term'||q.where.term && q.where.term.schoolId!=='school')throw new Error('Unexpected class scope');return [classroom];}},
  publication:{findMany:async q=>{
    if(q.where.type!=='ASSIGNMENT'||q.where.status!=='PUBLISHED'||q.where.boardDate.toISOString().slice(0,10)!=='2026-10-12')throw new Error('Unexpected homework date/visibility');
    return [{id:'work',revision:3,title:'实验练习',content:'长作业🙂\n'.repeat(4000),subject:{name:'物理'},targets:[{workspaceId:'class'}]}];}},
  academicTerm:{findUnique:async()=>term,findMany:async()=>[term]},
  grade:{findUnique:async()=>({id:'grade',termId:'term'}),findMany:async()=>[{id:'grade',termId:'term',name:'隔离测试年级'}]},
  npepAudit:{create:async record=>{audits.push(record.data);return record.data;}},
  npepSessionReceipt:{findUnique:async q=>q.where.sessionId===session.sessionId?session:null},
  $queryRaw:async(strings,...values)=>{
    const sql=strings.join('?');
    if(sql.includes('FROM "NpepStudySettingRequest"'))return requests.has(values[1])?[requests.get(values[1])]:[];
    if(sql.includes('FROM "NpepStudySetting"'))return policy?[structuredClone(policy)]:[];
    if(sql.includes('FROM "NpepStudyDevice"'))return stored?[{data:stored}]:[];
    if(sql.includes('FROM "NpepNoiseDevice"'))return noiseStored?[{data:noiseStored}]:[];
    return [{id:values[0]}];
  },
  $executeRaw:async(strings,...values)=>{
    const sql=strings.join('?');
    if(sql.includes('INSERT INTO "NpepStudySettingRequest"'))requests.set(values[1],{actorId:values[2],digest:values[3],result:JSON.parse(values[4])});
    else if(sql.includes('INSERT INTO "NpepStudySetting"'))policy={targetType:values[2],targetId:values[3],revision:values[4],policy:JSON.parse(values[5])};
    else if(sql.includes('INSERT INTO "NpepStudyDevice"'))stored=JSON.parse(values[1]);
    else if(sql.includes('INSERT INTO "NpepNoiseDevice"'))noiseStored=JSON.parse(values[1]);
    else throw new Error('Unexpected mutation');return 1;
  },
};
const client={...tx,$transaction:async action=>action(tx)};
const adminBearer=`fixture-${randomUUID()}`;
const app=express();app.use('/api/v2/npep',createNpepRouter({client,deployment:()=>deployment,rateLimits:false,
  authenticate:token=>{if(token!==adminBearer)throw new Error('Wrong isolated admin token');return {accountId:'fixture-admin',sessionId:'fixture-session',tokenVersion:1};}}));
const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
let child;
try{
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function admin(action,body){
    const response=await fetch(`${origin}/api/v2/npep/schools/school/study-settings${action}`,{method:body?'POST':'GET',
      headers:{Authorization:`Bearer ${adminBearer}`,'X-NPEP-Version':'0.10','X-Request-Id':body?.requestId??randomUUID(),...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    const envelope=await response.json();if(!response.ok)throw new Error(`Admin fixture failed: ${response.status} ${envelope.error?.code}`);return envelope.data;
  }
  const body={requestId:randomUUID(),termId:'term',targetType:'GRADE',targetId:'grade',expectedRevision:0,policy:{mode:'Override',settings}};
  const preview=await admin('/preview',{...body,previewDate:'2026-10-12'});
  if(preview.changedClasses!==1 || preview.pairedDevices!==1 || preview.items[0].windows[0].start!=='2026-10-12T19:00:00')throw new Error('Admin preview mismatch');
  const write={...body,expectedPreviewFingerprint:preview.previewFingerprint};
  const saved=await admin('',write),repeated=await admin('',write),listed=await admin('?termId=term');
  if(saved.revision!==1 || repeated.revision!==1 || listed.settings[0].revision!==1 || audits.length!==1 || requests.size!==1)throw new Error('Admin save/idempotency/readback mismatch');
  fs.writeFileSync(path.join(output,'admin-save-result.json'),JSON.stringify({passed:4,checks:['actual OWNER HTTP preview','actual HTTP save with preview fingerprint','same-request save is idempotent','actual HTTP readback of saved policy'],realDatabase:false},null,2));
  process.stdout.write('PASS admin save/readback: 4 checks, in-memory persistence adapter\n');
  const identity={...deployment,deviceId:id,bindingRevision:1,credentialGeneration:1};
  fs.writeFileSync(fixturePath,JSON.stringify({isolatedStudyFixture:true,origin:`http://127.0.0.1:${server.address().port}`,
    deviceBearer:`npep1.${credentialId}.${secret}`,adminBearer,noiseControlEpoch:device.controlEpoch,context:{identity,runId:session.runId,sessionId:session.sessionId,statusEpoch:1}}));
  child=spawn('dotnet',[path.resolve(dll),'--study-http-local',fixturePath,path.join(output,'http-chain-result.json')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',v=>log+=v);child.stderr.on('data',v=>log+=v);
  const timeout=setTimeout(()=>child.kill(),30000);
  const exit=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});clearTimeout(timeout);
  fs.writeFileSync(path.join(output,'http-chain.log'),log);process.stdout.write(log);
  if(exit!==0)throw new Error('Native HTTP chain failed');
  if(stored?.sequence<3 || stored.status.phase!=='Outside' || stored.status.captureState!=='NOT_INTEGRATED')throw new Error('Final native receipt mismatch');
  if(stored.execution?.status.signalFresh!==false || stored.execution?.status.reason!=='OUTSIDE_WINDOW')throw new Error('Final native execution mismatch');
  if(stored.commands?.length!==1 || stored.commands[0].receipt?.outcome!=='ACCEPTED')throw new Error('Actual resume exchange lacks the persisted device receipt');
  if(noiseStored?.reports?.length!==3)throw new Error('Final uploaded report count mismatch');
}finally{
  if(child && child.exitCode===null)child.kill();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  fs.unlinkSync(fixturePath); // Only the exact random fixture created by this run; no recursive removal.
}
