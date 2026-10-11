import seatingCases from '../domain/npep/seating-cases.json' with {type:'json'};
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {readSeatingPng, pngCrc, validateSeating} from '../domain/npep/seating.js';
import {createNpepSeatingRouter} from '../routes/v2/npepSeating.js';
import {png, chunk, fixture} from './helpers/npepSeatingFixture.js';
const write = extra=>({requestId:randomUUID(),termId:'term',classId:'one',expectedRevision:0,action:'image',image:png().toString('base64'),...extra});
test('PNG rejects malformed CRC, metadata, inflated surplus, giant dimensions and wrong type',()=>{
  const p=png();assert.equal(readSeatingPng(p.toString('base64')).width,2);
  const bad=Buffer.from(p);bad[29]^=1;assert.throws(()=>readSeatingPng(bad.toString('base64')));
  assert.throws(()=>readSeatingPng(png(2,2,1).toString('base64')));
  const giant=Buffer.from(p);giant.writeUInt32BE(4097,16);giant.writeUInt32BE(pngCrc(giant.subarray(12,29)),29);assert.throws(()=>readSeatingPng(giant.toString('base64')));
  assert.throws(()=>readSeatingPng('AAAA'));assert.throws(()=>readSeatingPng(p.toString('base64')+'='));
  const metadata=Buffer.concat([p.subarray(0,33),chunk('tEXt',Buffer.from('secret')),p.subarray(33)]);assert.throws(()=>readSeatingPng(metadata.toString('base64')));
});
test('publication scopes, optimistic revision, idempotency, restore, withdrawal and five-image bound',async()=>{
  const f=fixture(),body=write();assert.equal((await f.service.publish(f.claims,'school',body)).revision,1);
  assert.equal((await f.service.publish(f.claims,'school',body)).revision,1);assert.equal(f.rows.length,1);
  await assert.rejects(f.service.publish(f.claims,'school',{...body,image:png(3,2).toString('base64')}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  await assert.rejects(f.service.publish(f.claims,'school',write()),e=>e.code==='SEATING_CHANGED');
  await assert.rejects(f.service.publish(f.claims,'school',write({classId:'foreign'})),e=>e.code==='NOT_FOUND');
  f.setRole('TEACHER');await assert.rejects(f.service.publish(f.claims,'school',write()));f.setRole('ADMIN');
  const withdrawn=await f.service.publish(f.claims,'school',write({expectedRevision:1,action:'withdraw',image:undefined}));assert.equal(withdrawn.hash,null);
  const restored=await f.service.publish(f.claims,'school',write({expectedRevision:2,action:'restore',image:undefined,restoreRevision:1}));assert.equal(restored.revision,3);assert.equal(restored.hash,f.rows[0].hash);
  for(let i=3;i<8;i++)await f.service.publish(f.claims,'school',write({expectedRevision:i}));
  assert.equal(f.rows.filter(r=>r.imageBytes).length,5);
  await assert.rejects(f.service.publish(f.claims,'school',write({expectedRevision:8,action:'restore',image:undefined,restoreRevision:1})),e=>e.code==='IMAGE_NO_LONGER_RETAINED');
  assert.equal((await f.service.publish(f.claims,'school',body)).revision,1,'old retry retains metadata after image pruning');
});
test('device transfer is exact-context/version fenced and publication change prevents mixed chunks',async()=>{
  const f=fixture();await f.service.publish(f.claims,'school',write());
  const body={requestId:randomUUID(),version:f.version,context:f.context,downloaded:null,observation:null};
  assert.ok(validateSeating('manifestRequest',body));const m=await f.service.manifest({id:f.device.id},body);assert.ok(validateSeating('manifest',m));
  const chunkBody={...body,revision:1,hash:m.asset.hash,index:0};delete chunkBody.observation;delete chunkBody.downloaded;
  const c=await f.service.chunk({id:f.device.id},chunkBody);assert.ok(validateSeating('chunk',c));assert.equal(Buffer.from(c.data,'base64').length,m.asset.byteCount);
  await assert.rejects(f.service.manifest({id:f.device.id},{...body,context:{...f.context,runId:randomUUID()}}),e=>e.code==='SESSION_SUPERSEDED');
  await assert.rejects(f.service.manifest({id:f.device.id},{...body,version:'b'.repeat(64)}),e=>e.code==='POLICY_CHANGED');
  f.applied.receivedAt=new Date(0).toISOString();await assert.rejects(f.service.manifest({id:f.device.id},body),e=>e.code==='STUDY_NOT_APPLIED');f.applied.receivedAt=new Date().toISOString();
  await f.service.publish(f.claims,'school',write({expectedRevision:1,action:'withdraw',image:undefined}));
  await assert.rejects(f.service.chunk({id:f.device.id},chunkBody),e=>e.code==='SEATING_CHANGED');
  assert.equal((await f.service.manifest({id:f.device.id},body)).asset,null);
});
test('duplicate and out-of-order observations do not refresh receipt time',async()=>{
  const f=fixture();await f.service.publish(f.claims,'school',write());
  const o={appInstanceId:randomUUID(),sequence:4,revision:1,appliedHash:f.rows[0].hash,visible:true,renderAgeMs:100};
  const body={requestId:randomUUID(),version:f.version,context:f.context,downloaded:null,observation:o};await f.service.manifest({id:f.device.id},body);
  const first=f.receipts.get(f.device.id);await f.service.manifest({id:f.device.id},{...body,observation:{...o,sequence:3}});assert.equal(f.receipts.get(f.device.id).receivedAt,first.receivedAt);
  await f.service.manifest({id:f.device.id},body);assert.equal(f.receipts.get(f.device.id).receivedAt,first.receivedAt);
});
test('isolated HTTP parser rejects non-admin, wrong version, request mismatch and keeps old protocol isolated',async t=>{
  const f=fixture();const app=express();app.use('/npep',createNpepSeatingRouter({base:f.base,study:f.study,authenticate:()=>f.claims,rateLimits:false}));
  app.use((_r,s)=>s.status(418).end());const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>{server.closeAllConnections();server.close();});
  const path=`http://127.0.0.1:${server.address().port}/npep/schools/school/seating`;
  const body=write(),headers={'Content-Type':'application/json','X-NPEP-Version':'0.14','X-Request-Id':body.requestId,Authorization:'Bearer token'};
  assert.equal((await fetch(path,{method:'POST',headers:{...headers,Authorization:''},body:JSON.stringify(body)})).status,401);
  assert.equal((await fetch(path,{method:'POST',headers:{...headers,'X-NPEP-Version':'0.10'},body:JSON.stringify(body)})).status,426);
  assert.equal((await fetch(path,{method:'POST',headers,body:JSON.stringify({...body,requestId:randomUUID()})})).status,400);
  f.setRole('TEACHER');assert.equal((await fetch(path,{method:'POST',headers,body:JSON.stringify(body)})).status,403);
  assert.equal((await fetch(path.replace('/seating','/study-settings'),{headers})).status,418);
});


test('current device binding/policy authorization fences both transfer and displayed receipt claims',async()=>{
  const f=fixture();await f.service.publish(f.claims,'school',write());
  const body={requestId:randomUUID(),version:f.version,context:f.context,downloaded:{revision:1,hash:f.rows[0].hash},observation:{appInstanceId:randomUUID(),sequence:1,revision:1,appliedHash:f.rows[0].hash,visible:true,renderAgeMs:30}};
  await f.service.manifest({id:f.device.id},body);
  let list=await f.service.list(f.claims,'school','term','one');assert.equal(list.receipts[0].fresh,true);assert.equal(list.receipts[0].downloaded,true);
  f.device.state='REVOKED';list=await f.service.list(f.claims,'school','term','one');assert.equal(list.receipts[0].fresh,false);assert.equal(list.receipts[0].downloaded,false);
  f.device.state='ACTIVE';f.config.version='b'.repeat(64);list=await f.service.list(f.claims,'school','term','one');assert.equal(list.receipts[0].fresh,false);
  f.config.version=f.version;f.tx.classroomScreenBinding.findUnique=async()=>({schoolId:'school',administrativeClassId:'one',npepBindingRevision:2,isActive:true});
  list=await f.service.list(f.claims,'school','term','one');assert.equal(list.receipts[0].fresh,false);
});
test('actual seating HTTP routes and default SQL repository store, preview, read manifests/chunks and withdraw',async t=>{
  const f=fixture(),rows=[];let receipt=null;
  f.tx.$queryRaw=async(strings,...values)=>{
    const sql=strings.join('?');
    if(sql.includes('NpepStudyDevice'))return [{data:f.applied}];
    if(sql.includes('NpepSeatingReceipt'))return receipt?[{deviceId:f.device.id,data:receipt}]:[];
    if(sql.includes('NpepSeatingVersion')) {
      if(sql.includes('"requestId"=?::uuid')) return rows.filter(r=>r.requestId===values[1]);
      if(sql.includes('substring'))return [{bytes:rows.find(r=>r.revision===values[4])?.imageBytes?.subarray(values[0]-1,values[0]-1+16384)}];
      const scopeRows=rows.filter(r=>r.schoolId===values[0]&&r.termId===values[1]&&r.classId===values[2]).sort((a,b)=>b.revision-a.revision);
      if(sql.includes('octet_length')) return scopeRows.slice(0,1).map(r=>({...r,byteCount:r.imageBytes?.length??null}));
      return scopeRows;
    }
    return [];
  };
  f.tx.$executeRaw=async(strings,...values)=>{
    const sql=strings.join('?');
    if(sql.includes('INSERT INTO "NpepSeatingVersion"')) {
      const [schoolId,termId,classId,revision,hash,width,height,imageBytes,requestId,digest,actorId,createdAt]=values;
      rows.push({schoolId,termId,classId,revision,hash,width,height,imageBytes,requestId,digest,actorId,createdAt});
    } else if(sql.includes('UPDATE "NpepSeatingVersion"')) { for(const r of rows)if(r.revision<=values[3])r.imageBytes=null; }
    else if(sql.includes('INSERT INTO "NpepSeatingReceipt"'))receipt=JSON.parse(values[4]);
    return 1;
  };
  const app=express();app.use('/npep',createNpepSeatingRouter({base:f.base,study:f.study,authenticate:()=>f.claims,rateLimits:false}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>{server.closeAllConnections();server.close();});
  async function request(path,body,auth='Bearer token') {
    const id=body?.requestId??randomUUID();const res=await fetch(`http://127.0.0.1:${server.address().port}/npep${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-NPEP-Version':'0.14','X-Request-Id':id,Authorization:auth},...(body?{body:JSON.stringify(body)}:{})});
    const response=await res.json();assert.equal(response.requestId,id);assert.equal(res.headers.get('cache-control'),'no-store');return {status:res.status,...response};
  }
  const body=write();assert.equal((await request('/schools/school/seating',body)).status,200);
  const preview=await request('/schools/school/seating/image?termId=term&classId=one&revision=1');assert.equal(preview.data.image,body.image);
  assert.equal((await request('/schools/school/seating?termId=term&classId=one')).data.current.revision,1);
  const manifestBody={requestId:randomUUID(),context:f.context,version:f.version,observation:null,downloaded:null};
  const auth=`Bearer npep1.${f.device.id}.${'A'.repeat(43)}`;const m=await request('/device/study-settings/seating',manifestBody,auth);assert.equal(m.status,200);assert.ok(validateSeating('manifest',m.data));
  const c=await request('/device/study-settings/seating/chunk',{requestId:randomUUID(),context:f.context,version:f.version,revision:1,hash:m.data.asset.hash,index:0},auth);
  assert.equal(c.status,200);assert.equal(c.data.data,body.image);
  await request('/schools/school/seating',write({expectedRevision:1,action:'withdraw',image:undefined}));
  assert.equal((await request('/device/study-settings/seating',{...manifestBody,requestId:randomUUID()},auth)).data.asset,null);
});

for(const c of seatingCases)test(`shared seating contract: ${c.name}`,()=>assert.equal(validateSeating(c.definition,c.value),c.expected));
