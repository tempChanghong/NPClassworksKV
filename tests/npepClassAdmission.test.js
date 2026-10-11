import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createClassAdmission} from '../services/npepClassAdmission.js';
import {managementVerifier} from '../domain/npep/schoolManagement.js';
const config={serverInstanceId:randomUUID(),deploymentEpoch:randomUUID()};
function fixture(){
  const pairs=[],b={id:'screen',schoolId:'school',administrativeClassId:'class',npepPairingEnabled:true,npepPairingRevision:3,npepBindingRevision:1,credentialVersion:1,school:{name:'school'},administrativeClass:{name:'class'},name:'screen'};
  const credential={revision:2,verifier:managementVerifier('school-password')};
  const tx={$queryRaw:async()=>[],classroomScreenBinding:{findUnique:async()=>b},npepPairing:{findUnique:async({where})=>where.installationId_requestId?pairs.find(p=>p.installationId===where.installationId_requestId.installationId&&p.requestId===where.installationId_requestId.requestId):pairs.find(p=>p.userCode===where.userCode),count:async()=>0,create:async({data})=>{pairs.push(data);return data;}}};
  const service=createClassAdmission({transaction:fn=>fn(tx,config),schoolLock:async()=>{},binding:async()=>b,available:async()=>{},audit:async()=>{},pairValid:()=>{},management:{credential:async()=>credential}});
  return {service,pairs,b,credential};
}
const body=()=>({...config,requestId:randomUUID(),installationId:randomUUID(),screenBindingId:'screen',deviceName:'device',appVersion:'test',pairingSecret:'A'.repeat(43),requestedCapabilities:['device.status']});
test('class application stays pending and carries only exact requested binding',async()=>{
  const f=fixture();await f.service.createClassPairing(body(),false);assert.equal(f.pairs[0].state,'PENDING');assert.deepEqual(f.pairs[0].approvalSnapshot,{requestedBindingId:'screen'});assert.equal(f.pairs[0].approvalSource,'CLASS_APPLY');
});
test('password admission requires preauthorization and current password, with same-request replay',async()=>{
  const f=fixture(),request={...body(),secret:'school-password'};
  await assert.rejects(f.service.createClassPairing({...request,secret:'wrong-password'},true),{code:'MANAGEMENT_SECRET_INVALID'});
  f.b.npepPairingEnabled=false;await assert.rejects(f.service.createClassPairing(request,true),{code:'MANAGEMENT_SECRET_INVALID'});f.b.npepPairingEnabled=true;
  const first=await f.service.createClassPairing(request,true),second=await f.service.createClassPairing(request,true);assert.equal(first.data.pairingId,second.data.pairingId);assert.equal(f.pairs.length,1);
  assert.equal(f.pairs[0].state,'APPROVED');assert.equal(f.pairs[0].approvalSnapshot.managementRevision,2);assert(!JSON.stringify(f.pairs).includes('school-password'));
  f.credential.verifier=managementVerifier('changed-password');await assert.rejects(f.service.createClassPairing(request,true),{code:'MANAGEMENT_SECRET_INVALID'});
});
test('reused admission request cannot silently change its target or device identity',async()=>{
  const f=fixture(),request=body();await f.service.createClassPairing(request,false);
  await assert.rejects(f.service.createClassPairing({...request,deviceName:'other'},false),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.service.createClassPairing({...request,deploymentEpoch:randomUUID()},false),{code:'INSTANCE_MISMATCH'});
});
