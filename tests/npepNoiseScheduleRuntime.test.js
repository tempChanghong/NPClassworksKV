import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {createNpepNoiseScheduleRuntime} from '../services/npepNoiseScheduleRuntime.js';
import {validateNoiseScheduleWire} from '../domain/npep/noiseScheduleWire.js';
for(const c of JSON.parse(readFileSync(new URL('../domain/npep/noise-schedule-wire-cases.json',import.meta.url))))
  test('shared wire: '+c.name,()=>assert.equal(validateNoiseScheduleWire(c.definition,c.value),c.expected));
const identity={serverInstanceId:randomUUID(),deploymentEpoch:randomUUID(),deviceId:randomUUID(),bindingRevision:1,credentialGeneration:1};
const context={identity,sessionId:randomUUID(),runId:randomUUID(),statusEpoch:1,controlEpoch:randomUUID()};
const window={start:'2026-10-01T19:00:00.000',end:'2026-10-01T20:00:00.000'};
const version='a'.repeat(64);
const status=()=>({capability:'noise.schedule',version,source:'Grade',owner:'None',reason:'WINDOW_SKIPPED',schoolNow:'2026-10-01T19:30:00.000',
  clockReady:true,dateNeedsReview:false,window,next:null,sessionId:null,leaseRemainingSeconds:86400,receipt:null});
const request=(sequence=1,extra={})=>({requestId:randomUUID(),context,sequence,status:status(),...extra});
function fixture() {
  let data={status:null,commands:[],sessions:[]};
  const d={id:identity.deviceId,...identity,sessionId:context.sessionId,statusEpoch:1};
  const tx={npepSessionReceipt:{findUnique:async()=>({deviceId:d.id,runId:context.runId,statusEpoch:1})}};
  const base={withRuntimeDevice:async(_auth,work)=>work(tx,d),withNoiseScreen:async(_token,work)=>work(tx,d),withRuntimeAdmin:async(_a,_b,_c,work)=>work(tx,d)};
  let policy={version,source:'Grade',rules:[{days:[4],start:'19:00',end:'20:00'}]};
  const repo={read:async()=>structuredClone(data),save:async(_tx,_id,value)=>{data=structuredClone(value);},policy:async()=>structuredClone(policy)};
  return {service:createNpepNoiseScheduleRuntime(base,repo),data:()=>data,setPolicy:p=>{policy=p;},d};
}
test('0.7 wire rejects missing capability, raw PCM, invalid dates and coercion',()=>{
  assert.equal(validateNoiseScheduleWire('exchangeRequest',request()),true);
  for(const bad of [request(1,{sequence:'1'}),request(0),request(1,{audio:'raw'}),request(1,{status:{...status(),capability:'device.status'}}),
    request(1,{status:{...status(),schoolNow:'2026-02-30T19:00:00.000'}}),request(1,{status:{...status(),schoolNow:'2026-10-01T19:30:00.000Z'}})])
    assert.equal(validateNoiseScheduleWire('exchangeRequest',bad),false);
});
test('fresh exchange confirms lease; duplicate cannot refresh status or lease; sequence and context fenced',async()=>{
  const f=fixture(),body=request(); const first=await f.service.exchange({},body);
  assert.equal(validateNoiseScheduleWire('exchangeResponse',first),true); assert.equal(first.confirmed,true);
  const at=f.data().receivedAt; const replay=await f.service.exchange({},body);
  assert.equal(replay.confirmed,false); assert.equal(replay.command,null); assert.equal(f.data().receivedAt,at);
  await assert.rejects(f.service.exchange({}, {...body,status:{...body.status,reason:'OUTSIDE_WINDOW'}}),{code:'SEQUENCE_CONFLICT'});
  await assert.rejects(f.service.exchange({},request(2,{context:{...context,runId:randomUUID()}})),{code:'SESSION_SUPERSEDED'});
  await assert.rejects(f.service.exchange({},request(2,{context:{...context,identity:{...identity,deviceId:randomUUID()}}})),{code:'AUTH_INVALID'});
});
test('resume uses exact current version/window, stable ID and durable receipt',async()=>{
  const f=fixture(); await f.service.exchange({},request());
  const b={requestId:randomUUID(),version,window},c=await f.service.resume('screen',b);
  assert.deepEqual(await f.service.resume('screen',b),c);
  await assert.rejects(f.service.resume('screen',{...b,version:'b'.repeat(64)}),{code:'IDEMPOTENCY_CONFLICT'});
  const second=await f.service.exchange({},request(2)); assert.deepEqual(second.command,c.command);
  await f.service.exchange({},request(3,{status:{...status(),receipt:{commandId:c.command.commandId,outcome:'ACCEPTED'}}}));
  assert.equal((await f.service.screen('screen')).commands[0].receipt.outcome,'ACCEPTED');
});
test('saved/applied/active separate; policy edits and old Host never report current applied',async()=>{
  const f=fixture(); assert.equal((await f.service.screen('screen')).supported,false);
  await f.service.exchange({},request(1,{status:{...status(),owner:'Schedule',sessionId:randomUUID()}}));
  const active=await f.service.screen('screen'); assert.equal(active.applied,true); assert.equal(active.sessions.length,1);
  f.setPolicy({version:'b'.repeat(64),source:'Disabled',rules:[]});
  assert.equal((await f.service.screen('screen')).applied,false);
  await assert.rejects(f.service.resume('screen',{requestId:randomUUID(),version,window}),{code:'SCHEDULE_VERSION_CONFLICT'});
  f.d.sessionId=randomUUID(); assert.equal((await f.service.screen('screen')).online,false);
});
