import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {createNpepRouter} from '../routes/v2/npep.js';
import {defaultStudySettings} from '../domain/npep/studySettings.js';

// Actual Express routes, authorization and repository queries; an in-memory
// Prisma adapter replaces PostgreSQL. No database migration is run by this test.
test('study settings HTTP contract enforces school/session authority, preview freshness and retry identity', async t => {
  const config={serverInstanceId:randomUUID(),deploymentEpoch:randomUUID()};
  const rows=[], requests=new Map(), audit=[];
  let role='OWNER', revokedAt=null;
  const classroom={id:'one',name:'一班',gradeId:'grade',termId:'term',type:'ADMIN_CLASS',isActive:true,
    subjectRules:[{subjectId:'physics',deliveryMode:'COURSE_GROUP'}]};
  const courses=['walk-a','walk-b'].map(id=>({id,name:id,gradeId:'grade',termId:'term',type:'COURSE_GROUP',subjectId:'physics',
    subject:{name:'物理'},sourceClasses:[{administrativeClassId:'one'}]}));
  const tx={
    npepDeployment:{findUnique:async()=>config},
    account:{findUnique:async()=>({id:'admin',tokenVersion:1,localDisabled:false})},
    accountSession:{findUnique:async()=>({id:'session',accountId:'admin',revokedAt,expiresAt:new Date(Date.now()+60000)})},
    schoolMember:{findUnique:async query=>query.where.schoolId_accountId.schoolId==='school'?{role}:null},
    academicTerm:{findMany:async()=>[{id:'term',name:'本学期'}],findUnique:async query=>({id:query.where.id,schoolId:query.where.id==='term'?'school':'other',status:'ACTIVE'})},
    grade:{findMany:async()=>[{id:'grade',name:'高二'}]},
    workspace:{findMany:async query=>query.where.type==='COURSE_GROUP'?structuredClone(courses):
      query.where.id && !query.where.id.in.includes('one')?[]:[structuredClone(classroom)]},
    classroomScreenBinding:{findMany:async()=>[{id:'screen',administrativeClassId:'one',npepBindingRevision:1}]},
    npepDevice:{findMany:async()=>[{screenBindingId:'screen',administrativeClassId:'one',bindingRevision:1}]},
    npepAudit:{create:async row=>audit.push(row)},
    $queryRaw:async(strings,...values)=>{
      const sql=strings.join('?');
      if(sql.includes('FROM "NpepStudySettingRequest"')) return requests.has(values[1])?[structuredClone(requests.get(values[1]))]:[];
      if(sql.includes('FROM "NpepStudySetting"')) return structuredClone(rows.filter(row=>row.schoolId===values[0] && row.termId===values[1]));
      return [{id:values[0]}];
    },
    $executeRaw:async(strings,...values)=>{
      const sql=strings.join('?');
      if(sql.includes('INSERT INTO "NpepStudySettingRequest"')) requests.set(values[1],{actorId:values[2],digest:values[3],result:JSON.parse(values[4])});
      else if(sql.includes('INSERT INTO "NpepStudySetting"')) {
        const [schoolId,termId,targetType,targetId,revision,policy]=values;
        const row={schoolId,termId,targetType,targetId,revision,policy:JSON.parse(policy)};
        const index=rows.findIndex(r=>r.schoolId===schoolId && r.termId===termId && r.targetType===targetType && r.targetId===targetId);
        if(index<0) rows.push(row); else rows[index]=row;
      } else if (sql.includes('UPDATE "NpepStudyPhoto"') || sql.includes('UPDATE "NpepStudyExitEvent"')) return 0;
      else throw new Error(`Unexpected write: ${sql}`);
      return 1;
    },
  };
  const app=express(); app.use('/api/v2/npep',createNpepRouter({client:{$transaction:async work=>work(tx)},
    deployment:()=>config,authenticate:()=>({accountId:'admin',sessionId:'session',tokenVersion:1}),rateLimits:false}));
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const root=`http://127.0.0.1:${server.address().port}/api/v2/npep/schools`;
  async function request(path,body,extra={}) {
    const requestId=body?.requestId || randomUUID();
    const res=await fetch(root+path,{method:body?'POST':'GET',...(body?{body:JSON.stringify(body)}:{}),
      headers:{'Content-Type':'application/json','X-NPEP-Version':'0.10','X-Request-Id':requestId,Authorization:'Bearer local-fixture',...extra},signal:AbortSignal.timeout(5000)});
    const result=await res.json(); assert.equal(result.requestId,requestId); assert.equal(result.protocolVersion,'0.10');
    assert.equal(res.headers.get('cache-control'),'no-store'); return {status:res.status,...result};
  }
  const settings=defaultStudySettings(); settings.schedule.effectiveFrom='2026-10-12';settings.schedule.rules[0].days=[1];
  const draft=()=>({requestId:randomUUID(),termId:'term',targetType:'GRADE',targetId:'grade',expectedRevision:0,policy:{mode:'Override',settings:structuredClone(settings)}});
  const path='/school/study-settings';
  await t.test('OWNER and ADMIN can read while other roles and revoked sessions cannot',async()=>{
    for(const allowed of ['OWNER','ADMIN']) { role=allowed;assert.equal((await request(path+'?termId=term')).status,200); }
    for(const denied of ['TEACHER','MANAGER','STUDENT']) { role=denied;const result=await request(path+'?termId=term');assert.equal(result.status,403);assert.equal(result.error.code,'SCHOOL_ADMIN_REQUIRED'); }
    role='OWNER'; revokedAt=new Date();assert.equal((await request(path+'?termId=term')).status,401);revokedAt=null;
    assert.equal((await request('/other/study-settings?termId=term')).status,403);
    assert.equal((await request(path+'?termId=foreign')).status,404);
    assert.equal(rows.length,0);
  });
  await t.test('new protocol and strict payloads do not allow implicit scope or retention overrides',async()=>{
    assert.equal((await request(path+'?termId=term',null,{'X-NPEP-Version':'0.7'})).status,426);
    const missing=draft();assert.equal((await request(path,missing)).status,400);
    const over=draft();over.policy.settings.photos.retentionDays=181;assert.equal((await request(path+'/preview',over)).status,400);
    const foreign=draft();foreign.policy.settings.homework.sourceMode='SelectedClasses';foreign.policy.settings.homework.sourceClassIds=['foreign'];
    assert.equal((await request(path+'/preview',foreign)).status,404);
    assert.equal(rows.length,0);
  });
  await t.test('preview is read only, real repository save/read and audit are idempotent',async()=>{
    const body=draft(), preview=await request(path+'/preview',{...body,previewDate:'2026-10-12'});
    assert.equal(preview.status,200);assert.equal(rows.length,0);assert.equal(audit.length,0);
    assert.deepEqual(preview.data.items[0].homeworkSources.map(row=>row.id),['one','walk-a','walk-b']);
    assert.equal(preview.data.items[0].windows[0].start,'2026-10-12T19:00:00');
    body.expectedPreviewFingerprint=preview.data.previewFingerprint;
    const saved=await request(path,body);assert.equal(saved.status,200);assert.equal(saved.data.revision,1);
    const repeated=await request(path,body);assert.deepEqual(repeated.data,saved.data);assert.equal(audit.length,1);
    const read=await request(path+'?termId=term');assert.deepEqual(read.data.settings[0].policy,body.policy);
    assert.equal(read.data.integration.nativeDisplay,'PENDING_INTEGRATION');
    const mutated=structuredClone(body);mutated.policy.settings.homework.rotationSeconds=90;
    assert.equal((await request(path,mutated)).error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal(rows[0].revision,1);
  });
  await t.test('walk-class source changes after preview block saving even when target revision is unchanged',async()=>{
    const body={...draft(),expectedRevision:1},preview=await request(path+'/preview',body);
    courses.pop(); body.expectedPreviewFingerprint=preview.data.previewFingerprint;
    const result=await request(path,body);assert.equal(result.status,409);assert.equal(result.error.code,'STUDY_PREVIEW_CHANGED');
    assert.equal(rows[0].revision,1);assert.equal(audit.length,1);
  });
});
