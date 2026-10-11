import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {managementVerifier, verifyManagementSecret} from '../domain/npep/schoolManagement.js';
import {createSchoolManagementService} from '../services/npepSchoolManagementService.js';

function fixture() {
  const credentials=new Map(),requests=new Map(),equipment=new Map(),inventories=new Map(),audits=[];
  const d={id:randomUUID(),schoolId:'school',administrativeClassId:'class',serverInstanceId:randomUUID(),deploymentEpoch:randomUUID(),bindingRevision:1,sessionId:randomUUID()};
  const context={identity:{serverInstanceId:d.serverInstanceId,deploymentEpoch:d.deploymentEpoch,deviceId:d.id,bindingRevision:1,credentialGeneration:1},sessionId:d.sessionId,runId:randomUUID(),statusEpoch:1};
  const b={id:'screen',administrativeClassId:'class',npepPairingRevision:0,npepPairingEnabled:false};
  const tx={classroomScreenBinding:{update:async({data})=>{b.npepPairingEnabled=data.npepPairingEnabled;b.npepPairingRevision++;}},npepScreenPairingTicket:{updateMany:async()=>{}},
    npepAudit:{create:async x=>audits.push(x)},npepSessionReceipt:{findUnique:async()=>({deviceId:d.id,...context,expiresAt:new Date(Date.now()+60000)})}};
  const base={withScheduleAdmin:async(_c,_s,fn)=>fn(tx),withRuntimeDevice:async(_a,fn)=>fn(tx,d),withRuntimeAdmin:async(_c,_s,_id,fn)=>fn(tx,d)};
  const repo={binding:async()=>b,credential:async()=>credentials.get('class')??null,saveCredential:async(_t,_s,_c,x)=>credentials.set('class',x),
    request:async(_t,_s,id)=>requests.get(id),saveRequest:async(_t,_s,id,x)=>requests.set(id,x),equipment:async()=>equipment.get(d.id)??{revision:0,locked:false,microphoneId:null,cameraId:null},
    saveEquipment:async(_t,_d,x)=>equipment.set(d.id,x),inventory:async()=>inventories.get(d.id),saveInventory:async(_t,_d,x)=>inventories.set(d.id,x)};
  return {service:createSchoolManagementService(base,repo),d,context,b,credentials,requests,equipment,inventories,audits};
}
const claims={accountId:'admin'};
const command=(extra={})=>({requestId:randomUUID(),expectedRevision:0,enabled:true,secret:'school-password',...extra});
function inventory(f,extra={}){return {requestId:randomUUID(),context:f.context,sequence:1,microphones:[{id:'mic',name:'麦克风'}],cameras:[{id:'cam',name:'摄像头'}],unlocked:false,appliedRevision:0,credentialRevision:0,selectedMicrophoneId:'mic',selectedCameraId:'cam',error:null,...extra};}

test('password verifier uses randomized salt and does not accept malformed credentials',()=>{
  const a=managementVerifier('school-password'),b=managementVerifier('school-password');
  assert.notEqual(a.salt,b.salt);assert(verifyManagementSecret('school-password',a));assert(!verifyManagementSecret('another-password',a));assert(!verifyManagementSecret('school-password',{...a,iterations:1}));
});
test('class must have a password before preauthorization; CAS, replay and reset stay separate',async()=>{
  const f=fixture();await assert.rejects(f.service.write(claims,'school','screen',command({secret:null})),{code:'MANAGEMENT_NOT_CONFIGURED'});
  const body=command();const first=await f.service.write(claims,'school','screen',body);assert.equal(first.revision,1);assert.equal(first.enabled,true);
  assert.deepEqual(await f.service.write(claims,'school','screen',body),first);assert.equal(f.audits.length,1);
  await assert.rejects(f.service.write(claims,'school','screen',{...body,secret:'changed-password'}),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.service.write(claims,'school','screen',command()),{code:'REVISION_CONFLICT'});
  await f.service.write(claims,'school','screen',command({expectedRevision:1,secret:'new-password'}));
  const read=await f.service.read(claims,'school','screen');assert.equal(read.revision,2);assert(!Object.hasOwn(read,'verifier'));assert(!JSON.stringify(f.requests.values().next().value).includes('school-password'));
});
test('device policy is authenticated scope and inventory must match the live session',async()=>{
  const f=fixture(),body=inventory(f);await f.service.observe({},body);
  assert.equal((await f.service.devicePolicy({})).identity.deviceId,f.d.id);
  await assert.rejects(f.service.observe({},inventory(f,{context:{...f.context,runId:randomUUID()}})),{code:'SESSION_SUPERSEDED'});
  await assert.rejects(f.service.observe({},inventory(f,{context:{...f.context,identity:{...f.context.identity,deviceId:randomUUID()}}})),{code:'SESSION_SUPERSEDED'});
  await assert.rejects(f.service.observe({},inventory(f,{context:{...f.context,sessionId:'bad'}})),{code:'INVALID_REQUEST'});
});
test('inventory sequence rejects stale observations and changed same-sequence content',async()=>{
  const f=fixture(),body=inventory(f,{sequence:2});await f.service.observe({},body);await f.service.observe({},body);
  await assert.rejects(f.service.observe({},inventory(f)),{code:'SEQUENCE_CONFLICT'});
  await assert.rejects(f.service.observe({},{...body,unlocked:true}),{code:'SEQUENCE_CONFLICT'});
});
test('malformed inventory cannot inject duplicated devices, unbounded state, or extra authority',async()=>{
  const f=fixture();
  for(const extra of [{cameras:[null]},{microphones:[{id:'mic',name:'one'},{id:'mic',name:'two'}]},{selectedCameraId:{}},{error:'x'.repeat(101)},{owner:true},{appliedRevision:-1}])
    await assert.rejects(f.service.observe({},inventory(f,extra)),{code:'INVALID_REQUEST'});
});
test('remote selection only uses fresh inventory and exact device IDs; it acknowledges configuration only',async()=>{
  const f=fixture(),body={requestId:randomUUID(),expectedRevision:0,locked:true,microphoneId:'mic',cameraId:'cam'};
  await assert.rejects(f.service.setEquipment(claims,'school',f.d.id,body),{code:'EQUIPMENT_INVENTORY_STALE'});
  await f.service.observe({},inventory(f));
  const p=await f.service.setEquipment(claims,'school',f.d.id,body);assert.equal(p.revision,1);assert.equal(p.locked,true);
  assert.deepEqual(await f.service.setEquipment(claims,'school',f.d.id,body),p);
  await assert.rejects(f.service.setEquipment(claims,'school',f.d.id,{...body,requestId:randomUUID(),expectedRevision:1,microphoneId:'unknown'}),{code:'EQUIPMENT_UNAVAILABLE'});
  f.inventories.get(f.d.id).receivedAt='invalid';
  await assert.rejects(f.service.setEquipment(claims,'school',f.d.id,{...body,requestId:randomUUID(),expectedRevision:1}),{code:'EQUIPMENT_INVENTORY_STALE'});
});
