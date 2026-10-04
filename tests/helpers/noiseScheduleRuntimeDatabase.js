import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import bcrypt from 'bcrypt';
import {hash} from '../../domain/npep/wire.js';
export async function verifyNoiseScheduleRuntimeDatabase(t,{fixture,request,prisma,req,activate,open,identity,directory,origin}) {
  const policy={mode:'Override',rules:[{days:[4],start:'19:00',end:'20:00'}]};
  const n7=(path,options={})=>request(path,{...options,headers:{'X-NPEP-Version':'0.7',...options.headers}});
  async function setup() {
    const f=await fixture();
    f.grade=await prisma.grade.create({data:{termId:f.term.id,code:'TWO',name:'高二'}});
    await prisma.workspace.update({where:{id:f.workspace.id},data:{gradeId:f.grade.id}});
    assert.equal((await n7(`/schools/${f.school.id}/noise-schedules`,{auth:f.admin,body:req({termId:f.term.id,targetType:'GRADE',targetId:f.grade.id,expectedRevision:0,policy})})).status,200);
    return f;
  }
  await t.test('N4.3c real HTTP/SQL policy version, scope, session, schema and state freshness',async()=>{
    const f=await setup(),d=await activate(f),session=await open(d);
    const context={identity:{...identity,deviceId:d.deviceId,bindingRevision:d.bindingRevision,credentialGeneration:1},runId:session.body.runId,sessionId:session.sessionId,statusEpoch:session.statusEpoch,controlEpoch:randomUUID()};
    const status={capability:'noise.schedule',version:null,source:'None',owner:'None',reason:'POLICY_EXPIRED',schoolNow:null,clockReady:false,dateNeedsReview:false,window:null,next:null,sessionId:null,leaseRemainingSeconds:0,receipt:null};
    const b=req({context,sequence:1,status}),first=await n7('/device/noise-schedule',{auth:d.auth,body:b});
    assert.equal(first.status,200,first.error?.code);assert.equal(first.data.policy.source,'Grade');assert.equal(first.data.confirmed,true);
    assert.equal((await n7('/device/noise-schedule',{auth:d.auth,body:b})).data.confirmed,false);
    assert.equal((await n7('/device/noise-schedule',{auth:d.auth,body:{...b,status:{...status,reason:'DISABLED'}}})).error.code,'SEQUENCE_CONFLICT');
    const management=`/schools/${f.school.id}/devices/${d.deviceId}/noise-schedule`;
    assert.equal((await n7(management,{auth:f.admin})).data.applied,false);
    const applied=req({context,sequence:2,status:{...status,source:'Grade',version:first.data.policy.version}});
    assert.equal((await n7('/device/noise-schedule',{auth:d.auth,body:applied})).status,200);
    assert.equal((await n7(management,{auth:f.admin})).data.applied,true);
    const moved=await prisma.grade.create({data:{termId:f.term.id,code:'OTHER',name:'其他年级'}});
    await prisma.workspace.update({where:{id:f.workspace.id},data:{gradeId:moved.id}});
    const changed=await n7('/device/noise-schedule',{auth:d.auth,body:req({context,sequence:3,status:applied.status})});
    assert.notEqual(changed.data.policy.version,first.data.policy.version); assert.equal(changed.data.policy.source,'None');
    assert.equal((await n7(management,{auth:f.admin})).data.applied,false);
    assert.equal((await n7('/device/noise-schedule',{auth:d.auth,body:req({context:{...context,sessionId:randomUUID()},sequence:4,status})})).error.code,'SESSION_SUPERSEDED');
    assert.equal((await n7('/device/noise-schedule',{auth:d.auth,body:req({context,sequence:4,status:{...status,schoolNow:'2026-02-30T10:00:00.000'}})})).status,400);
    const other=await fixture(); assert.equal((await n7(management,{auth:other.admin})).status,403);
  });
  await t.test('N4.3c actual .NET scheduler and 0.6/0.7 transport through disposable SQL', {skip:!process.env.NPEP_N3_ACCEPTANCE_DLL,timeout:120000},async()=>{
    const f=await setup(),screenToken=randomUUID(),screenPin='725316';
    await prisma.classroomScreenBinding.update({where:{id:f.binding.id},
      data:{tokenHash:hash(screenToken),pinHash:await bcrypt.hash(screenPin,10)}});
    const file=join(directory,'noise-schedule-fixture.json');
    await writeFile(file,JSON.stringify({kind:'NOISE_SCHEDULE_DISPOSABLE_DATABASE',origin:origin.replace('/api/v2/npep',''),adminToken:f.admin,
      screenToken,screenPin,schoolId:f.school.id,screenBindingId:f.binding.id}));
    const child=spawn('dotnet',[process.env.NPEP_N3_ACCEPTANCE_DLL,'--noise-schedule-http',file,join(directory,'desktop-schedule')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',c=>{output+=c;});child.stderr.on('data',c=>{output+=c;});
    const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',done);});
    assert.equal(code,0,output);assert.match(output,/PASS NOISE SCHEDULE/);
    const result=await n7('/screen/noise-schedule',{headers:{'X-Classworks-Screen-Token':screenToken}});
    assert.equal(result.data.sessions.length,2);assert.equal(result.data.commands[0].receipt.outcome,'ACCEPTED');
    await prisma.classroomScreenBinding.update({where:{id:f.binding.id},data:{tokenHash:hash(randomUUID()),credentialVersion:{increment:1}}});
    assert.equal((await n7('/screen/noise-schedule',{headers:{'X-Classworks-Screen-Token':screenToken}})).status,401);
  });
}
