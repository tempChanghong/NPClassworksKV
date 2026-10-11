import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture as seatingFixture} from './helpers/npepSeatingFixture.js';
import {defaultStudySettings} from '../domain/npep/studySettings.js';
import {createNpepStudyExitService} from '../services/npepStudyExitService.js';
import express from 'express';
import {once} from 'node:events';
import {createNpepPhotoRouter} from '../routes/v2/npepPhotos.js';
function fixture(){
  const f=seatingFixture(),rows=new Map(),now=Date.now();f.config.effective.settings=defaultStudySettings();
  const body={requestId:randomUUID(),context:f.context,event:{eventId:randomUUID(),version:f.version,sessionId:randomUUID(),reason:'WrongPassword',
    deviceTime:new Date(now).toISOString(),schoolNow:'2026-10-11T20:00:00.000',photoEventId:null}};
  f.tx.npepSessionReceipt.findUnique=async()=>({...f.context,deviceId:f.device.id,expiresAt:new Date(now+60000)});
  const exitRepo={event:async(_t,id)=>rows.get(id),save:async(_t,r)=>rows.set(r.eventId,r),
    list:async(_t,s,t,c)=>[...rows.values()].filter(r=>r.schoolId===s&&r.termId===t&&r.classId===c).map(r=>({...r,photoState:'Unavailable'}))};
  const service=createNpepStudyExitService(f.base,f.study,{exitRepo,clock:()=>now});return{...f,service,body,rows,exitRepo,auth:{id:f.device.id},now};
}
test('exit failure records are private, idempotent, distinct from any photo acknowledgment and never contain a secret',async()=>{
  const f=fixture();assert.equal((await f.service.store(f.auth,f.body)).state,'Stored');await f.service.store(f.auth,{...f.body,requestId:randomUUID()});assert.equal(f.rows.size,1);
  const list=await f.service.list(f.claims,'school','term','one');assert.equal(list.items[0].photoState,'Unavailable');assert.equal(list.items[0].reason,'WrongPassword');
  f.setRole('TEACHER');await assert.rejects(f.service.list(f.claims,'school','term','one'),e=>e.code==='ADMIN_REQUIRED');
  await assert.rejects(f.service.store(f.auth,{...f.body,event:{...f.body.event,reason:'Timeout'}}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  await assert.rejects(f.service.store(f.auth,{...f.body,event:{...f.body.event,eventId:randomUUID(),secret:'password'}}),e=>e.code==='INVALID_REQUEST');
});
test('changed bindings, sessions, policy or a foreign photo cannot be attached to an exit failure',async()=>{
  const f=fixture();await assert.rejects(f.service.store(f.auth,{...f.body,event:{...f.body.event,photoEventId:randomUUID()}}),e=>e.code==='INVALID_REQUEST');
  await assert.rejects(f.service.store(f.auth,{...f.body,event:{...f.body.event,schoolNow:'2026-02-30T20:00:00.000'}}),e=>e.code==='INVALID_REQUEST');
  await assert.rejects(f.service.store(f.auth,{...f.body,event:{...f.body.event,version:'b'.repeat(64)}}),e=>e.code==='POLICY_CHANGED');
  f.device.bindingRevision++;await assert.rejects(f.service.store(f.auth,f.body),e=>e.code==='BINDING_CHANGED');
});
test('failure record retention uses trusted server receipt time while device clocks remain diagnostics',async()=>{
  const f=fixture();f.body.event.deviceTime='2000-01-01T00:00:00.000Z';await f.service.store(f.auth,f.body);
  const record=[...f.rows.values()][0];assert.equal(record.createdAt.getTime(),f.now);assert.equal(record.expiresAt.getTime()-f.now,30*86400000);
  f.config.effective.settings.noise.enabled=false;await assert.rejects(f.service.store(f.auth,{...f.body,event:{...f.body.event,eventId:randomUUID()}}),e=>e.code==='EXIT_NOT_ELIGIBLE');
});
test('actual loopback exit event route is scoped, rejects secrets and protects administrator queries',async t=>{
  const f=fixture();f.base.preflightDevice=async auth=>assert.equal(auth.id,f.device.id);
  const app=express();app.use(createNpepPhotoRouter({base:f.base,study:f.study,rateLimits:false,
    authenticate:token=>{if(token!=='admin-token')throw Error();return f.claims;},options:{exitRepo:f.exitRepo,clock:()=>f.now}}));
  const server=app.listen(0,'127.0.0.1');t.after(()=>new Promise(resolve=>server.close(resolve)));await once(server,'listening');
  const root='http://127.0.0.1:'+server.address().port;
  const headers={'X-NPEP-Version':'0.15','X-Request-Id':f.body.requestId,Authorization:`Bearer npep1.${f.device.id}.${Buffer.alloc(32,1).toString('base64url')}`,'Content-Type':'application/json'};
  let res=await fetch(root+'/device/study-settings/photos/exit-events',{method:'POST',headers,body:JSON.stringify(f.body)});
  assert.equal(res.status,200);assert.equal((await res.json()).data.eventId,f.body.event.eventId);assert.equal(f.rows.size,1);
  res=await fetch(root+'/device/study-settings/photos/exit-events',{method:'POST',headers,body:JSON.stringify({...f.body,event:{...f.body.event,password:'synthetic-secret'}})});
  assert.equal(res.status,400);assert.equal(f.rows.size,1);
  const admin={'X-NPEP-Version':'0.15','X-Request-Id':randomUUID(),Authorization:'Bearer admin-token'};
  const list=root+'/schools/school/study-exit-events?termId=term&classId=one';
  res=await fetch(list,{headers:admin});assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'private, no-store');
  assert.equal((await res.json()).data.items[0].photoState,'Unavailable');
  f.setRole('TEACHER');assert.equal((await fetch(list,{headers:admin})).status,403);
  f.setRole('ADMIN');assert.equal((await fetch(root+'/schools/foreign/study-exit-events?termId=term&classId=one',{headers:admin})).status,403);
});
