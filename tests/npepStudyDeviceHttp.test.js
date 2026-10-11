import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, randomBytes} from 'node:crypto';
import express from 'express';
import {createNpepRouter} from '../routes/v2/npep.js';
import {defaultStudySettings} from '../domain/npep/studySettings.js';
import {secretHash, fail} from '../domain/npep/wire.js';
import {createNpepStudyDeviceService} from '../services/npepStudyDeviceService.js';

test('device study configuration uses actual router/auth/repository without granting execution',async t=>{
  const config={serverInstanceId:randomUUID(),deploymentEpoch:randomUUID()};
  let enabled=true;
  const secret=randomBytes(32).toString('base64url'), credentialId=randomUUID();
  const term={id:'term',schoolId:'school',status:'ACTIVE'};
  const classroom={id:'one',name:'行政一班',subjectRules:[],gradeId:'grade',termId:'term',type:'ADMIN_CLASS',isActive:true,term};
  const grade={id:'grade',termId:'term'};
  const binding={id:'screen',schoolId:'school',administrativeClassId:'one',isActive:true,
    npepBindingRevision:1,administrativeClass:classroom};
  const session={sessionId:randomUUID(),runId:randomUUID(),statusEpoch:1,expiresAt:new Date(Date.now()+600000)};
  const device={id:randomUUID(),credentialId,secretHash:secretHash(secret),state:'ACTIVE',sessionId:session.sessionId,statusEpoch:1,
    ...config,credentialExpiresAt:new Date(Date.now()+600000),schoolId:'school',
    administrativeClassId:'one',screenBindingId:'screen',bindingRevision:1};
  session.deviceId=device.id;
  let stored=null, writes=0, role='OWNER', revokedAt=null;
  const settings=defaultStudySettings();settings.schedule.effectiveFrom='2026-10-12';settings.schedule.rules[0].days=[1];
  const rows=[{schoolId:'school',termId:'term',targetType:'GRADE',targetId:'grade',revision:3,policy:{mode:'Override',settings}}];
  const tx={
    account:{findUnique:async()=>({id:'admin',tokenVersion:1,localDisabled:false})},
    accountSession:{findUnique:async()=>({id:'admin-session',accountId:'admin',revokedAt,expiresAt:new Date(Date.now()+600000)})},
    schoolMember:{findUnique:async query=>query.where.schoolId_accountId.schoolId==='school'?{role}:null},
    npepDeployment:{findUnique:async()=>config},
    npepDevice:{findUnique:async q=>q.where.credentialId===credentialId || q.where.id===device.id?device:null},
    classroomScreenBinding:{findUnique:async q=>q.where.id==='screen'?binding:null},
    workspace:{findUnique:async q=>q.where.id==='one'?classroom:null},
    academicTerm:{findUnique:async q=>q.where.id==='term'?term:null},
    grade:{findUnique:async q=>q.where.id==='grade'?grade:null},
    npepSessionReceipt:{findUnique:async q=>q.where.sessionId===session.sessionId?session:null},
    $queryRaw:async(strings,...values)=>{
      const sql=strings.join('?');
      if(sql.includes('FROM "NpepStudySetting"')){
        assert.deepEqual(values,['school','term']);
        return structuredClone(rows.filter(row=>row.schoolId===values[0]&&row.termId===values[1]));
      }
      if(sql.includes('FROM "NpepStudyDevice"'))return stored?[{data:structuredClone(stored)}]:[];
      return [{id:values[0]}];
    },
    $executeRaw:async(strings,...values)=>{
      assert.ok(strings.join('?').includes('INSERT INTO "NpepStudyDevice"'));assert.equal(values[0],device.id);
      stored=JSON.parse(values[1]);writes++;return 1;
    },
  };
  const client={...tx,$transaction:async work=>work(tx)};
  const app=express();app.use('/api/v2/npep',createNpepRouter({client,
    deployment:()=>{if(!enabled)fail(503,'TEMPORARILY_UNAVAILABLE');return config;},
    authenticate:()=>({accountId:'admin',sessionId:'admin-session',tokenVersion:1}),rateLimits:false}));
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  async function request(query='',auth=`Bearer npep1.${credentialId}.${secret}`,version='0.10'){
    const requestId=randomUUID();const res=await fetch(`http://127.0.0.1:${server.address().port}/api/v2/npep/device/study-settings${query}`,{
      headers:{'X-NPEP-Version':version,'X-Request-Id':requestId,Authorization:auth},signal:AbortSignal.timeout(5000)});
    const body=await res.json();assert.equal(body.requestId,requestId);assert.equal(body.protocolVersion,'0.10');
    assert.equal(res.headers.get('cache-control'),'no-store');return {status:res.status,...body};
  }
  await t.test('current paired device gets only its grade inheritance with stable version and no applied claim',async()=>{
    rows.push({schoolId:'foreign',termId:'foreign-term',targetType:'CLASS',targetId:'one',revision:9,policy:{mode:'Disabled',settings:null}});
    const first=await request(),second=await request();assert.equal(first.status,200);
    assert.equal(first.data.effective.source,'Grade');assert.equal(first.data.effective.settings.noise.highContinuousSeconds,5);
    assert.deepEqual(first.data.scope,{schoolId:'school',termId:'term',classId:'one',gradeId:'grade'});
    assert.equal(first.data.identity.deviceId,device.id);assert.equal(first.data.version,second.data.version);
    assert.equal(first.data.executionState,'NOT_VERIFIED');assert.equal(Object.hasOwn(first.data,'applied'),false);
    assert.equal(writes,0);
    assert.deepEqual(first.data.presentationTiming,{prepareSeconds:120,preparationUntilStart:true,startNoticeSeconds:5,endNoticeSeconds:5});
  });
  await t.test('class closure/override and policy edits change the feed fingerprint',async()=>{
    const before=await request();const local={schoolId:'school',termId:'term',targetType:'CLASS',targetId:'one',revision:1,policy:{mode:'Disabled',settings:null}};
    rows.push(local);const closed=await request();assert.equal(closed.data.effective.source,'Disabled');assert.equal(closed.data.effective.settings,null);
    assert.notEqual(closed.data.version,before.data.version);
    local.policy={mode:'Override',settings:structuredClone(settings)};local.policy.settings.schedule.rules[0].start='19:10';local.revision++;
    const override=await request();assert.equal(override.data.effective.source,'Class');assert.equal(override.data.effective.settings.schedule.rules[0].start,'19:10');
    assert.notEqual(override.data.version,closed.data.version);rows.pop();
  });
  await t.test('query scope overrides, wrong protocol and user/screen credentials are rejected',async()=>{
    assert.equal((await request('?classId=foreign')).status,400);
    assert.equal((await request('',undefined,'0.7')).status,426);
    assert.equal((await request('','Bearer local-admin')).status,401);
    assert.equal((await request('',`Bearer npep1.${randomUUID()}.${secret}`)).status,401);
    assert.equal((await request('',`Bearer npepp1.${credentialId}.${secret}`)).status,401);
  });
  await t.test('unbinding, credential expiry, changed binding, inactive term and wrong grade scope close access',async()=>{
    device.state='REVOKED';assert.equal((await request()).status,401);device.state='ACTIVE';
    const expires=device.credentialExpiresAt;device.credentialExpiresAt=new Date(0);assert.equal((await request()).status,401);device.credentialExpiresAt=expires;
    binding.npepBindingRevision=2;assert.equal((await request()).status,401);binding.npepBindingRevision=1;
    term.status='ARCHIVED';assert.equal((await request()).status,401);term.status='ACTIVE';
    grade.termId='foreign';assert.equal((await request()).status,409);grade.termId='term';
    enabled=false;assert.equal((await request()).status,503);enabled=true;
  });
  await t.test('missing or malformed policy never produces a guessed active schedule',async()=>{
    const saved=rows.shift();const empty=await request();assert.equal(empty.data.effective.source,'None');assert.equal(empty.data.effective.settings,null);
    rows.unshift(saved);const old=settings.schedule.effectiveFrom;settings.schedule.effectiveFrom='';
    const invalid=await request();assert.equal(invalid.status,503);assert.equal(invalid.error.code,'INVALID_STUDY_POLICY');settings.schedule.effectiveFrom=old;
  });
  const configView=(await request()).data;
  const makeReceipt=()=>({requestId:randomUUID(),context:{identity:configView.identity,runId:session.runId,sessionId:session.sessionId,statusEpoch:1},sequence:1,
    status:{version:configView.version,policyState:'APPLIED',presentationState:'NOT_INTEGRATED',captureState:'NOT_INTEGRATED',phase:'Blocked',
      reason:'SCHOOL_CLOCK_UNAVAILABLE',clockReady:false,schoolNow:null,window:null}});
  async function post(body, auth=`Bearer npep1.${credentialId}.${secret}`){
    const res=await fetch(`http://127.0.0.1:${server.address().port}/api/v2/npep/device/study-settings/receipt`,{method:'POST',
      headers:{'Content-Type':'application/json','X-NPEP-Version':'0.10','X-Request-Id':body.requestId,Authorization:auth},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    const data=await res.json();assert.equal(data.requestId,body.requestId);return {status:res.status,...data};
  }
  const management=createNpepStudyDeviceService({withRuntimeAdmin:(_claims,_school,_id,operation)=>operation(tx,device)});
  await t.test('receipt records policy application but never capture or visible display; replay does not renew freshness',async()=>{
    const body=makeReceipt();const first=await post(body);assert.equal(first.status,200);assert.equal(first.data.confirmed,true);
    const observed=await management.management({},'school',device.id);assert.equal(observed.configurationApplied,true);
    assert.equal(observed.captureVerified,false);assert.equal(observed.presentationVerified,false);
    stored.receivedAt=new Date(Date.now()-16000).toISOString();const before=stored.receivedAt;
    const replay=await post(body);assert.equal(replay.status,200);assert.equal(replay.data.confirmed,false);assert.equal(stored.receivedAt,before);
    assert.equal((await management.management({},'school',device.id)).configurationApplied,false);
    const changed=structuredClone(body);changed.status.reason='WAITING';assert.equal((await post(changed)).error.code,'SEQUENCE_CONFLICT');
  });
  await t.test('policy changes, old sessions and claims of real capture or presentation are rejected',async()=>{
    const body=makeReceipt();body.sequence=2;body.status.captureState='Active';assert.equal((await post(body)).status,400);
    body.status.captureState='NOT_INTEGRATED';body.status.presentationState='VISIBLE';assert.equal((await post(body)).status,400);
    body.status.presentationState='NOT_INTEGRATED';body.context.runId=randomUUID();assert.equal((await post(body)).error.code,'SESSION_SUPERSEDED');
    body.context.runId=session.runId;const expires=session.expiresAt;session.expiresAt=new Date(0);assert.equal((await post(body)).error.code,'SESSION_SUPERSEDED');session.expiresAt=expires;
    body.context.identity.deviceId=randomUUID();assert.equal((await post(body)).error.code,'AUTH_INVALID');body.context.identity.deviceId=device.id;
    const before=settings.schedule.rules[0].start;settings.schedule.rules[0].start='19:10';assert.equal((await post(body)).error.code,'POLICY_CHANGED');
    assert.equal((await management.management({},'school',device.id)).configurationApplied,false);settings.schedule.rules[0].start=before;
    assert.equal((await post(body,'Bearer local-admin')).status,401);
  });
  await t.test('current-session fencing and increasing sequence apply to management freshness',async()=>{
    const body=makeReceipt();body.sequence=2;assert.equal((await post(body)).data.confirmed,true);
    assert.equal((await management.management({},'school',device.id)).fresh,true);
    const previous=device.sessionId;device.sessionId=randomUUID();assert.equal((await management.management({},'school',device.id)).fresh,false);
    device.sessionId=previous;body.sequence=1;assert.equal((await post(body)).error.code,'SEQUENCE_CONFLICT');
  });
  async function execute(body) {
    const res=await fetch(`http://127.0.0.1:${server.address().port}/api/v2/npep/device/study-settings/execution`,{method:'POST',
      headers:{'Content-Type':'application/json','X-NPEP-Version':'0.10','X-Request-Id':body.requestId,Authorization:`Bearer npep1.${credentialId}.${secret}`},
      body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    const envelope=await res.json();assert.equal(envelope.protocolVersion,'0.10');return {status:res.status,...envelope};
  }
  const execBody=()=>({requestId:randomUUID(),context:makeReceipt().context,sequence:1,version:configView.version,
    status:{owner:'None',state:'Idle',sessionId:null,reason:'POLICY_EXPIRED',clockReady:false,schoolNow:null,window:null,signalFresh:false}});
  await t.test('execution needs a fresh applied current-session policy; duplicate grants cannot renew evidence',async()=>{
    const body=execBody();stored.receivedAt=new Date(Date.now()-16000).toISOString();
    assert.equal((await execute(body)).error.code,'STUDY_NOT_APPLIED');
    const applied=makeReceipt();applied.sequence=3;assert.equal((await post(applied)).data.confirmed,true);
    const reply=await execute(body);assert.equal(reply.status,200);assert.deepEqual(reply.data,{confirmed:true,version:configView.version,leaseSeconds:86400});
    assert.equal((await management.management({},'school',device.id)).captureVerified,false);
    stored.execution.receivedAt=new Date(Date.now()-16000).toISOString();const before=stored.execution.receivedAt;
    assert.equal((await execute(body)).data.confirmed,false);assert.equal(stored.execution.receivedAt,before);
    assert.equal((await management.management({},'school',device.id)).executionFresh,false);
    const changed=structuredClone(body);changed.status.reason='WAITING';assert.equal((await execute(changed)).error.code,'SEQUENCE_CONFLICT');
  });
  await t.test('capture evidence requires fresh actual frames, current version and connection; start acceptance is insufficient',async()=>{
    const body=execBody();body.sequence=2;body.status={owner:'Schedule',state:'Active',sessionId:randomUUID(),reason:'WINDOW_ACTIVE',clockReady:true,
      schoolNow:'2026-10-12T19:00:05.000',window:{start:'2026-10-12T19:00:00.000',end:'2026-10-12T21:30:00.000'},signalFresh:true};
    assert.equal((await execute(body)).data.confirmed,true);assert.equal((await management.management({},'school',device.id)).captureVerified,true);
    stored.execution.receivedAt=new Date(Date.now()-16000).toISOString();assert.equal((await management.management({},'school',device.id)).captureVerified,false);
    body.sequence++;body.requestId=randomUUID();body.status.state='Starting';body.status.reason='CAPTURE_STARTING';body.status.signalFresh=false;
    assert.equal((await execute(body)).data.confirmed,true);assert.equal((await management.management({},'school',device.id)).captureVerified,false);
    body.sequence++;body.requestId=randomUUID();body.status.signalFresh=true;assert.equal((await execute(body)).status,400);
    body.status.signalFresh=false;body.context.runId=randomUUID();assert.equal((await execute(body)).error.code,'SESSION_SUPERSEDED');
    body.context.runId=session.runId;const old=settings.schedule.rules[0].end;settings.schedule.rules[0].end='21:00';
    assert.equal((await execute(body)).error.code,'POLICY_CHANGED');assert.equal((await management.management({},'school',device.id)).captureVerified,false);
    settings.schedule.rules[0].end=old;
    settings.schedule.exceptions=[{date:'2026-10-12',kind:'Skip',weekday:null}];
    const holiday=(await request()).data;const holidayReceipt=makeReceipt();holidayReceipt.sequence=4;holidayReceipt.status.version=holiday.version;
    assert.equal((await post(holidayReceipt)).data.confirmed,true);
    const holidayClaim=execBody();holidayClaim.sequence=5;holidayClaim.version=holiday.version;holidayClaim.status={owner:'Schedule',state:'Active',sessionId:randomUUID(),
      reason:'WINDOW_ACTIVE',clockReady:true,schoolNow:'2026-10-12T19:00:05.000',window:{start:'2026-10-12T19:00:00.000',end:'2026-10-12T21:30:00.000'},signalFresh:true};
    assert.equal((await execute(holidayClaim)).error.code,'STATE_CHANGED');settings.schedule.exceptions=[];
    const snapshot=structuredClone(rows);rows.length=0;body.version=(await request()).data.version;
    assert.equal((await execute(body)).error.code,'STUDY_NOT_CONFIGURED');rows.push(...snapshot);
  });

  const window={start:'2026-10-12T19:00:00.000',end:'2026-10-12T21:30:00.000'};
  const context=makeReceipt().context;
  const appliedBody=makeReceipt();appliedBody.sequence=99;appliedBody.status={...appliedBody.status,phase:'Active',reason:'WINDOW_ACTIVE',
    clockReady:true,schoolNow:'2026-10-12T19:02:00.000',window};
  await post(appliedBody);
  const stopped=execBody();stopped.sequence=99;stopped.status={...stopped.status,state:'Stopped',reason:'WINDOW_SKIPPED',
    clockReady:true,schoolNow:'2026-10-12T19:02:00.000',window};await execute(stopped);
  const probe=()=>({requestId:randomUUID(),context,sequence:1,version:configView.version,receipt:null});
  const restore=()=>({requestId:randomUUID(),version:configView.version,window});
  async function resumeHttp(path, body, auth=`Bearer npep1.${credentialId}.${secret}`, version='0.11') {
    const res=await fetch(`http://127.0.0.1:${server.address().port}/api/v2/npep/${path}`,{method:'POST',
      headers:{'Content-Type':'application/json','X-NPEP-Version':version,'X-Request-Id':body.requestId,Authorization:auth},
      body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    const result=await res.json();assert.equal(result.requestId,body.requestId);assert.equal(result.protocolVersion,'0.11');
    return {status:res.status,...result};
  }
  const exchange=body=>resumeHttp('device/study-settings/resume-exchange',body);
  const resume=(body,path=`schools/school/devices/${device.id}/study-settings/resume`)=>resumeHttp(path,body,'Bearer isolated-admin');
  await t.test('old configuration/execution support alone does not expose the new resume capability',async()=>{
    assert.equal((await resume(restore())).error.code,'STUDY_RESUME_UNAVAILABLE');
    assert.equal((await exchange(probe())).data.confirmed,true);
    assert.equal((await management.management({},'school',device.id)).resumeSupported,true);
  });
  const baseline=structuredClone(stored);
  await t.test('resume requires OWNER or ADMIN of the exact school and a live account session',async()=>{
    for(const forbidden of ['TEACHER','STUDENT']){role=forbidden;assert.equal((await resume(restore())).error.code,'SCHOOL_ADMIN_REQUIRED');}
    role='ADMIN';assert.equal((await resume(restore())).status,200);stored=structuredClone(baseline);role='OWNER';
    revokedAt=new Date();assert.equal((await resume(restore())).error.code,'AUTH_INVALID');revokedAt=null;
    assert.equal((await resume(restore(),`schools/other/devices/${device.id}/study-settings/resume`)).status,403);
  });
  await t.test('request acceptance, durable redelivery, device application and actual collection remain separate facts',async()=>{
    stored=structuredClone(baseline);const body=restore(),accepted=await resume(body);assert.equal(accepted.status,200);
    assert.equal(accepted.data.receipt,null);assert.equal(accepted.data.actorId,'admin');
    const first=probe();first.sequence=2;const delivered=await exchange(first);assert.deepEqual(delivered.data.command,accepted.data.command);
    const same=await resume(body);assert.deepEqual(same.data.command,accepted.data.command);assert.equal(same.data.requestId,accepted.data.requestId);
    assert.ok(same.data.remainingMs <= accepted.data.remainingMs);assert.equal(stored.commands.length,1);
    const repeated=await exchange(first);assert.deepEqual(repeated.data,{confirmed:false,version:configView.version,command:null});
    const next=probe();next.sequence=3;assert.deepEqual((await exchange(next)).data.command,accepted.data.command);
    next.sequence=4;next.requestId=randomUUID();next.receipt={commandId:accepted.data.command.commandId,outcome:'ACCEPTED'};
    assert.equal((await exchange(next)).data.command,null);
    const view=await management.management({},'school',device.id);assert.equal(view.resumeCommands.at(-1).receipt.outcome,'ACCEPTED');
    assert.equal(view.captureVerified,false);assert.equal(view.execution.reason,'WINDOW_SKIPPED');
    const conflicting=structuredClone(next);conflicting.sequence++;conflicting.requestId=randomUUID();conflicting.receipt.outcome='REJECTED';
    assert.equal((await exchange(conflicting)).error.code,'IDEMPOTENCY_CONFLICT');
  });
  await t.test('freshness, manual ownership, wrong window, clock loss and exclusive end fence request creation',async()=>{
    const variants=[r=>r.receivedAt=new Date(Date.now()-16000).toISOString(),r=>r.resume.receivedAt=new Date(Date.now()-16000).toISOString(),
      r=>r.execution.receivedAt=new Date(Date.now()-16000).toISOString(),r=>r.execution.status.owner='Manual',
      r=>r.execution.status.clockReady=false,r=>r.execution.status.schoolNow=window.end,
      r=>r.execution.status.window={...window,start:'2026-10-12T18:59:00.000'},r=>r.execution.status.reason='WINDOW_ACTIVE'];
    for(const change of variants){stored=structuredClone(baseline);change(stored);assert.equal((await resume(restore())).status,409);assert.equal(stored.commands?.length??0,0);}
    stored=structuredClone(baseline);const wrong=restore();wrong.window={...window,end:'2026-10-12T21:29:00.000'};
    assert.equal((await resume(wrong)).error.code,'STATE_CHANGED');
  });
  await t.test('policy/session changes and command expiry withdraw delivery without implicit recovery',async()=>{
    stored=structuredClone(baseline);const created=await resume(restore());assert.equal((await resume(restore())).error.code,'COMMAND_PENDING');
    stored.commands[0].expiresAt=new Date(0).toISOString();const req=probe();req.sequence=2;
    assert.equal((await exchange(req)).data.command,null);assert.equal(stored.commands[0].receipt.outcome,'UNKNOWN');
    stored=structuredClone(baseline);await resume(restore());stored.commands[0].command.version='b'.repeat(64);
    assert.equal((await exchange(req)).data.command,null);assert.equal(stored.commands[0].receipt.outcome,'UNKNOWN');
    stored=structuredClone(baseline);await resume(restore());stored.commands[0].context.runId=randomUUID();
    assert.equal((await exchange(req)).data.command,null);
    req.context={...context,runId:randomUUID()};assert.equal((await exchange(req)).error.code,'SESSION_SUPERSEDED');
    req.context=context;req.version='b'.repeat(64);assert.equal((await exchange(req)).error.code,'POLICY_CHANGED');
    assert.ok(created.data.command.commandId);
  });
  await t.test('strict 0.11 routing rejects old versions, scope overrides and impossible calendar windows',async()=>{
    stored=structuredClone(baseline);const body=restore();
    assert.equal((await resumeHttp(`schools/school/devices/${device.id}/study-settings/resume`,body,'Bearer isolated-admin','0.10')).status,426);
    assert.equal((await resume(body,`schools/school/devices/${device.id}/study-settings/resume?classId=other`)).status,400);
    body.window={start:'2026-02-30T19:00:00.000',end:'2026-02-30T21:30:00.000'};assert.equal((await resume(body)).status,400);
    body.window={...window,end:'2026-10-12T22:01:00.000'};assert.equal((await resume(body)).status,400);
    body.window=window;body.context=context;assert.equal((await resume(body)).status,400);
  });
  await t.test('read-only 0.12 homework requires fresh applied current context/date/version and never changes capture receipts',async()=>{
    stored=structuredClone(baseline); stored.receivedAt=new Date().toISOString();
    tx.workspace.findMany=async query=>{assert.equal(query.where.term.schoolId,'school');return [classroom];};
    tx.publication={findMany:async query=>{
      assert.equal(query.where.type,'ASSIGNMENT');assert.equal(query.where.status,'PUBLISHED');
      assert.deepEqual(query.where.targets.some.workspaceId.in,['one']);
      return [{id:'work',revision:2,title:'',content:'当天作业\n第二行',subject:{name:'物理'},targets:[{workspaceId:'one'}]}];
    }};
    const body=()=>({requestId:randomUUID(),context,version:configView.version,date:'2026-10-12',index:0,snapshotId:null});
    async function homework(value=body(),auth=`Bearer npep1.${credentialId}.${secret}`,version='0.12',query='') {
      const res=await fetch(`http://127.0.0.1:${server.address().port}/api/v2/npep/device/study-settings/homework${query}`,{method:'POST',
        headers:{'Content-Type':'application/json','X-NPEP-Version':version,'X-Request-Id':value.requestId,Authorization:auth},body:JSON.stringify(value)});
      const json=await res.json();assert.equal(json.requestId,value.requestId);assert.equal(json.protocolVersion,'0.12');return {status:res.status,...json};
    }
    const initialWrites=writes, initialStored=structuredClone(stored);
    const first=await homework();assert.equal(first.status,200);assert.equal(first.data.count,1);
    const value=JSON.parse(Buffer.from(first.data.data,'base64'));assert.equal(value.date,'2026-10-12');assert.equal(value.items[0].content,'当天作业\n第二行');
    assert.equal(writes,initialWrites);assert.deepEqual(stored,initialStored);
    assert.equal((await homework({...body(),date:'2026-10-13'})).error.code,'STUDY_NOT_APPLIED');
    assert.equal((await homework({...body(),version:'b'.repeat(64)})).error.code,'POLICY_CHANGED');
    assert.equal((await homework({...body(),context:{...context,runId:randomUUID()}})).error.code,'SESSION_SUPERSEDED');
    assert.equal((await homework(body(),'Bearer isolated-admin')).status,401);
    assert.equal((await homework(body(),undefined,'0.10')).status,426);
    assert.equal((await homework(body(),undefined,'0.12','?classId=other')).status,400);
    assert.equal((await homework({...body(),date:'2026-02-30'})).status,400);
    assert.equal((await homework({...body(),index:1})).status,400);
    stored.status.clockReady=false;assert.equal((await homework()).error.code,'STUDY_NOT_APPLIED');stored.status.clockReady=true;
    stored.receivedAt=new Date(Date.now()-15000).toISOString();assert.equal((await homework()).error.code,'STUDY_NOT_APPLIED');
    stored=structuredClone(initialStored);device.state='REVOKED';assert.equal((await homework()).status,401);device.state='ACTIVE';
  });
  await t.test('WPF visibility is a separate bounded current-session observation, not policy or capture acceptance',async()=>{
    const initial=structuredClone(stored), window={start:'2026-10-12T19:00:00.000',end:'2026-10-12T21:30:00.000'};
    const context={identity:configView.identity,runId:session.runId,sessionId:session.sessionId,statusEpoch:1};
    stored.receivedAt=new Date().toISOString();stored.status={...stored.status,version:configView.version,phase:'Active',clockReady:true,
      schoolNow:'2026-10-12T19:10:00.000',window};
    const value=()=>({requestId:randomUUID(),context,sequence:1,version:configView.version,status:{state:'Visible',reason:'FRAME_CURRENT',phase:'Active',
      clockReady:true,schoolNow:'2026-10-12T19:10:00.000',window,hostInstanceId:randomUUID(),appInstanceId:randomUUID(),pulse:1,remainingMs:4000}});
    async function present(body,auth=`Bearer npep1.${credentialId}.${secret}`,version='0.13',query='') {
      const res=await fetch(`http://127.0.0.1:${server.address().port}/api/v2/npep/device/study-settings/presentation${query}`,{method:'POST',
        headers:{'Content-Type':'application/json','X-NPEP-Version':version,'X-Request-Id':body.requestId,Authorization:auth},body:JSON.stringify(body)});
      const json=await res.json();assert.equal(json.requestId,body.requestId);assert.equal(json.protocolVersion,'0.13');return {status:res.status,...json};
    }
    const beforeCapture=structuredClone(stored.execution), body=value();delete stored.presentation;
    assert.equal((await management.management({},'school',device.id)).presentationVerified,false);
    assert.equal((await present(body)).data.confirmed,true);
    let view=await management.management({},'school',device.id);assert.equal(view.presentationVerified,true);assert.equal(view.presentationFresh,true);
    assert.ok(view.presentationRemainingMs>0 && view.presentationRemainingMs<=4000);assert.deepEqual(stored.execution,beforeCapture);
    const expiry=stored.presentation.expiresAt,stamp=stored.presentation.receivedAt;
    assert.equal((await present(body)).data.confirmed,false);assert.equal(stored.presentation.expiresAt,expiry);assert.equal(stored.presentation.receivedAt,stamp);
    assert.equal((await present({...body,status:{...body.status,state:'Hidden'}})).error.code,'SEQUENCE_CONFLICT');
    assert.equal((await present({...body,requestId:randomUUID(),sequence:2})).status,200);assert.ok(stored.presentation.expiresAt<=expiry);
    stored.presentation.expiresAt=new Date(Date.now()-1).toISOString();
    assert.equal((await present({...body,requestId:randomUUID(),sequence:3})).status,200);
    assert.equal((await management.management({},'school',device.id)).presentationVerified,false);
    const hidden={...body,requestId:randomUUID(),sequence:4,status:{...body.status,state:'Hidden',reason:'TEMPORARY_HIDE',pulse:2}};
    assert.equal((await present(hidden)).status,200);view=await management.management({},'school',device.id);
    assert.equal(view.presentationFresh,true);assert.equal(view.presentationVerified,false);assert.equal(view.presentation.state,'Hidden');
    const pulse3={...body,requestId:randomUUID(),sequence:5,status:{...body.status,pulse:3}};
    assert.equal((await present(pulse3)).status,200);assert.equal((await management.management({},'school',device.id)).presentationVerified,true);
    assert.equal((await present({...pulse3,requestId:randomUUID(),sequence:6,status:{...pulse3.status,pulse:2}})).error.code,'SEQUENCE_CONFLICT');
    assert.equal((await present({...pulse3,requestId:randomUUID(),sequence:6,status:{...pulse3.status,state:'Hidden'}})).error.code,'SEQUENCE_CONFLICT');
    const delayed=structuredClone(pulse3);delayed.requestId=randomUUID();delayed.sequence=6;delayed.status.pulse=4;
    const savedPresentation=structuredClone(stored.presentation);
    const delayedService=createNpepStudyDeviceService({withRuntimeDevice:(_auth,work)=>work(tx,device)});
    await delayedService.presentation(null,delayed,performance.now()-5000);
    assert.equal((await management.management({},'school',device.id)).presentationVerified,false);stored.presentation=savedPresentation;
    stored.status.phase='Outside';stored.status.window=null;assert.equal((await management.management({},'school',device.id)).presentationVerified,false);
    stored.status.phase='Active';stored.status.window=window;
    stored.presentation.context={...context,sessionId:randomUUID()};assert.equal((await management.management({},'school',device.id)).presentationFresh,false);
    stored.presentation.context=context;
    stored.presentation.version='b'.repeat(64);assert.equal((await management.management({},'school',device.id)).presentationFresh,false);stored.presentation.version=configView.version;
    const invalid=value();invalid.sequence=6;
    assert.equal((await present({...invalid,status:{...invalid.status,remainingMs:5001}})).status,400);
    assert.equal((await present({...invalid,status:{...invalid.status,image:'no pixels'}})).status,400);
    assert.equal((await present({...invalid,status:{...invalid.status,appInstanceId:null}})).status,400);
    assert.equal((await present({...invalid,status:{...invalid.status,window:{...window,start:'19:00'}}})).status,400);
    assert.equal((await present({...invalid,status:{...invalid.status,window:{...window,start:'2026-10-12T19:01:00.000'}}})).error.code,'STATE_CHANGED');
    assert.equal((await present({...invalid,version:'b'.repeat(64)})).error.code,'POLICY_CHANGED');
    assert.equal((await present({...invalid,context:{...context,runId:randomUUID()}})).error.code,'SESSION_SUPERSEDED');
    assert.equal((await present(invalid,'Bearer isolated-admin')).status,401);
    assert.equal((await present(invalid,undefined,'0.10')).status,426);
    assert.equal((await present(invalid,undefined,'0.13','?classId=other')).status,400);
    device.state='REVOKED';assert.equal((await present(invalid)).status,401);device.state='ACTIVE';
    stored.receivedAt=new Date(Date.now()-15000).toISOString();assert.equal((await present(invalid)).error.code,'STUDY_NOT_APPLIED');
    stored=initial;
  });
});
