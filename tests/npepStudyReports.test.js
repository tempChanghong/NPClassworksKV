import test from 'node:test';
import assert from 'node:assert/strict';
import {createNpepStudyReportsService} from '../services/npepStudyReportsService.js';
function fixture() {
  const audit=[],calls=[];
  const tx={workspace:{findUnique:async()=>({id:'class',termId:'term'})},academicTerm:{findUnique:async()=>({schoolId:'school'})},
    npepAudit:{create:async r=>audit.push(r)}};
  const fragments=[{sessionId:'one',study:{mode:'Exam',clockSource:'Windows',window:{start:'2026-10-12T19:00:00.000',end:'2026-10-12T21:30:00.000'}}},
    {sessionId:'two',study:{mode:'Exam',clockSource:'Windows',window:{start:'2026-10-12T19:00:00.000',end:'2026-10-12T21:30:00.000'}}}];
  const repo={groups:async(...args)=>{calls.push(args.slice(1));return [{key:'key',start:fragments[0].study.window.start,deviceId:'device',fragments}];},
    evidence:async(_tx,school,term,c,ids)=>{assert.deepEqual([school,term,c],['school','term','class']);assert.deepEqual(ids,['one','two']);return {photos:[],events:[],truncated:false};}};
  const base={withScheduleAdmin:async(_claims,school,work)=>{assert.equal(school,'school');return work(tx);}};
  return {service:createNpepStudyReportsService(base,repo),calls,tx,audit};
}
const q={termId:'term',classId:'class'};
test('one study detail preserves restart fragments and scopes evidence to their sessions', async()=>{
  const f=fixture();const list=await f.service.list({accountId:'admin'},'school',{...q,mode:'Exam',date:'2026-10-12'});
  assert.equal(list.items[0].clockSource,'Windows');assert.equal(list.items[0].fragmentCount,2);
  assert(!Object.hasOwn(list.items[0],'fragments'));
  const detail=await f.service.list({accountId:'admin'},'school',{...q,groupId:list.items[0].groupId});
  assert.deepEqual(detail.items[0].photos,[]);assert.equal(detail.items[0].fragments.length,2);assert.equal(f.audit.length,2);
  assert.deepEqual(f.calls[0].slice(0,5),['school','term','class','Exam','2026-10-12']);
});
test('foreign term, malformed filters and null group selectors are rejected', async()=>{
  const f=fixture();
  for(const extra of [{mode:'Other'},{date:'2026-02-30'},{classId:['class']},{unknown:'x'},{groupId:Buffer.from('null').toString('base64url')},
    {cursor:'!',groupId:'!'}])await assert.rejects(f.service.list({accountId:'admin'},'school',{...q,...extra}),e=>e.code==='INVALID_REQUEST');
  f.tx.academicTerm.findUnique=async()=>({schoolId:'other'});
  await assert.rejects(f.service.list({accountId:'admin'},'school',q),e=>e.code==='NOT_FOUND');
  assert.equal(f.calls.length,0);
});
