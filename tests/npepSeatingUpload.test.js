import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import express from 'express';
import {createNpepSeatingRouter} from '../routes/v2/npepSeating.js';
import {createNpepSeatingService} from '../services/npepSeatingService.js';
import {validateSeating} from '../domain/npep/seating.js';
import {fixture,png,chunk} from './helpers/npepSeatingFixture.js';
const upload=(f,extra={})=>({requestId:randomUUID(),context:f.context,version:f.version,expectedRevision:0,image:png().toString('base64'),...extra});
const admin=(extra={})=>({requestId:randomUUID(),termId:'term',classId:'one',expectedRevision:0,action:'image',image:png().toString('base64'),...extra});
test('bound device can first-publish and replace without administrator password; replay has one version and audit',async()=>{
  const f=fixture(),auth={id:f.device.id},body=upload(f);
  const before=await f.service.uploadStatus(auth,{requestId:randomUUID(),context:f.context,version:f.version});
  assert.ok(validateSeating('uploadResult',before));assert.equal(before.classId,'one');assert.equal(before.revision,0);
  const first=await f.service.upload(auth,body);assert.equal(first.revision,1);
  assert.deepEqual(await f.service.upload(auth,body),first);assert.equal(f.rows.length,1);assert.equal(f.audits.length,1);
  assert.equal(f.audits[0].action,'DEVICE_SEATING_PUBLISHED');assert.equal(f.audits[0].actorId,`device:${f.device.id}`);
  assert.equal(f.audits[0].objectId,'one');assert.equal(f.rows[0].classId,'one');assert.equal(f.rows[0].termId,'term');
  const list=await f.service.list(f.claims,'school','term','one');
  assert.equal(list.versions[0].source,'Device');assert.equal(list.versions[0].deviceId,f.device.id);
  await assert.rejects(f.service.upload(auth,{...body,image:png(3,2).toString('base64')}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  assert.equal((await f.service.upload(auth,upload(f,{expectedRevision:1}))).revision,2);
});
test('administrator/device race is fenced by shared revision in either order',async()=>{
  for(const first of ['admin','device']){
    const f=fixture(),auth={id:f.device.id},a=admin(),d=upload(f);
    if(first==='admin'){
      await f.service.publish(f.claims,'school',a);
      await assert.rejects(f.service.upload(auth,d),e=>e.code==='SEATING_CHANGED');
    }else{
      await f.service.upload(auth,d);
      await assert.rejects(f.service.publish(f.claims,'school',a),e=>e.code==='SEATING_CHANGED');
    }
    assert.equal(f.rows.length,1);
    assert.equal((await f.service.upload(auth,upload(f,{expectedRevision:1}))).revision,2);
  }
});
test('concurrent administrator/device commands under school lock have exactly one winner',async()=>{
  const f=fixture();let tail=Promise.resolve();
  const locked=async(work)=>{const previous=tail;let release;tail=new Promise(resolve=>release=resolve);await previous;try{return await work();}finally{release();}};
  const base={withScheduleAdmin:(...args)=>locked(()=>f.base.withScheduleAdmin(...args)),withRuntimeDevice:(...args)=>locked(()=>f.base.withRuntimeDevice(...args))};
  const service=createNpepSeatingService(base,f.study,{
    versions:async()=>[...f.rows].reverse(),
    current:async()=>f.rows.at(-1),request:async(_t,_s,id)=>f.rows.find(r=>r.requestId===id),
    save:async(_t,_s,actorId,body,row,digest)=>{await new Promise(resolve=>setImmediate(resolve));f.rows.push({...row,actorId,digest,termId:body.termId,classId:body.classId,requestId:body.requestId});}
  });
  const results=await Promise.allSettled([service.upload({id:f.device.id},upload(f)),service.publish(f.claims,'school',admin())]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(results.find(r=>r.status==='rejected').reason.code,'SEATING_CHANGED');assert.equal(f.rows.length,1);
});
test('device upload rejects stale receipt, expired session, binding revision and policy change',async()=>{
  for(const change of ['receipt','session','binding','policy','class']){
    const f=fixture(),body=upload(f);
    if(change==='receipt')f.applied.receivedAt=new Date(0).toISOString();
    if(change==='session')f.device.sessionId=randomUUID();
    if(change==='binding')f.device.bindingRevision=2;
    if(change==='policy')f.config.version='b'.repeat(64);
    if(change==='class')f.tx.workspace.findUnique=async()=>({termId:'term',type:'ADMIN_CLASS',isActive:false});
    await assert.rejects(f.service.upload({id:f.device.id},body));assert.equal(f.rows.length,0);assert.equal(f.audits.length,0);
  }
});
test('upload wire cannot nominate another class/school/term or carry administrator password',()=>{
  const f=fixture(),b=upload(f);assert.ok(validateSeating('uploadRequest',b));
  for(const key of ['classId','schoolId','termId','password','actorId'])assert.equal(validateSeating('uploadRequest',{...b,[key]:'other'}),false);
});
test('new HTTP endpoints admit >64KiB normalized image, derive binding and reject invalid/excess body',async t=>{
  const f=fixture(),rows=[];
  f.tx.$queryRaw=async(strings,...values)=>{
    const sql=strings.join('?');
    if(sql.includes('NpepStudyDevice'))return[{data:f.applied}];
    if(sql.includes('NpepSeatingVersion'))return sql.includes('"requestId"=?::uuid')?rows.filter(r=>r.requestId===values[1]):rows.slice(-1);
    return[];
  };
  f.tx.$executeRaw=async(strings,...values)=>{
    if(strings.join('').includes('INSERT INTO "NpepSeatingVersion"')){
      const [schoolId,termId,classId,revision,hash,width,height,imageBytes,requestId,digest,actorId,createdAt]=values;
      rows.push({schoolId,termId,classId,revision,hash,width,height,imageBytes,requestId,digest,actorId,createdAt});
    } return 1;
  };
  const app=express();app.use('/npep',createNpepSeatingRouter({base:f.base,study:f.study,authenticate:()=>f.claims,rateLimits:false}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>{server.closeAllConnections();server.close();});
  async function send(path,body,auth=`Bearer npep1.${f.device.id}.${'A'.repeat(43)}`){
    const response=await fetch(`http://127.0.0.1:${server.address().port}/npep/device/study-settings/seating/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-NPEP-Version':'0.14','X-Request-Id':body.requestId,Authorization:auth},body:JSON.stringify(body)});
    return{status:response.status,...await response.json()};
  }
  const scope=await send('upload-status',{requestId:randomUUID(),context:f.context,version:f.version});assert.equal(scope.status,200);assert.equal(scope.data.classId,'one');
  const width=180,height=130,header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const pixels=randomBytes((width*4+1)*height);for(let y=0;y<height;y++)pixels[y*(width*4+1)]=0;
  const image=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
  assert.ok(image.length>65536);const body=upload(f,{image});
  const first=await send('upload',body);assert.equal(first.status,200);assert.ok(validateSeating('uploadResult',first.data));assert.equal(first.data.revision,1);
  assert.equal((await send('upload',body)).data.revision,1);assert.equal(rows.length,1);assert.equal(f.audits.length,1);
  assert.equal((await send('upload',upload(f,{classId:'foreign'}))).status,400);
  assert.equal((await send('upload',upload(f,{expectedRevision:1,image:'AAAA'}))).status,400);
  assert.equal((await send('upload',upload(f,{image:'A'.repeat(2850000)}))).status,413);
  assert.equal((await send('upload',body,'Bearer token')).status,401);
});
