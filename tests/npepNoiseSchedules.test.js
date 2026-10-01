import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateScheduleWrite, validateScheduleQuery} from '../domain/npep/noiseSchedules.js';
import {createNpepNoiseScheduleService} from '../services/npepNoiseScheduleService.js';

const policy = {mode: 'Override', rules: [{days: [1,2,3,4,5], start: '19:00', end: '21:00'}]};
const body = extra => ({requestId: randomUUID(), termId: 'term', targetType: 'GRADE', targetId: 'grade', expectedRevision: 0, policy: structuredClone(policy), ...extra});
function fixture() {
  const policies = [], requests = new Map(), audit = [];
  const tx = {npepAudit: {create: async value => audit.push(value)}};
  const base = {withScheduleAdmin: async (claims, school, work) => {
    assert.equal(school, 'school'); assert.equal(claims.accountId, 'admin'); return work(tx, {});
  }};
  const catalog = {terms: [{id: 'term', name: '本学期'}], termId: 'term', grades: [{id: 'grade', name: '高二'}],
    classes: [{id:'one',name:'一班',gradeId:'grade',pairedDevices:1}, {id:'two',name:'二班',gradeId:'grade',pairedDevices:0}]};
  const repo = {
    catalog: async (_tx, _school, term) => { assert.equal(term, 'term'); return structuredClone(catalog); },
    policies: async () => structuredClone(policies), request: async (_tx, _school, id) => requests.get(id),
    save: async (_tx, _school, actorId, value, result, digest) => {
      const index = policies.findIndex(p => p.targetId === value.targetId && p.targetType === value.targetType);
      const row = {targetType: value.targetType, targetId: value.targetId, policy: value.policy, revision: result.revision};
      if (index < 0) policies.push(row); else policies[index] = row;
      requests.set(value.requestId, {actorId, digest, result});
    },
  };
  return {service: createNpepNoiseScheduleService(base, repo), policies, audit, claims: {accountId:'admin'}};
}

test('write/query validation rejects coercion, extra fields, oversized and invalid merged policies', () => {
  assert.equal(validateScheduleWrite(body()), true);
  for (const bad of [body({expectedRevision:'0'}),body({expectedRevision:-1}),body({requestId:'not-a-uuid'}),body({targetType:'SCHOOL'}),body({policy:null}),body({extra:true}),
    body({policy:{mode:'Inherit',rules:[]}}),body({policy:{mode:'Override',rules:[{days:[1],start:'19:00',end:'22:01'}]}}),
    body({policy:{mode:'Override',rules:[{days:[1],start:'19:00',end:'21:00'},{days:[1],start:'21:00',end:'23:00'}]}})])
    assert.equal(validateScheduleWrite(bad), false);
  assert.equal(validateScheduleQuery({termId:'term'}), true);
  assert.equal(validateScheduleQuery({}), true);
  for (const query of [{termId:['one','two']},{termId:''},{classId:'one'}]) assert.equal(validateScheduleQuery(query), false);
});
test('grade preview preserves class override/disabled, and preview performs no writes', async () => {
  const f = fixture(); f.policies.push({targetType:'CLASS',targetId:'two',revision:1,policy:{mode:'Disabled',rules:[]}});
  const result = await f.service.preview(f.claims,'school',body());
  assert.equal(result.totalClasses,2); assert.equal(result.changedClasses,1); assert.equal(result.pairedDevices,1);
  assert.equal(result.items[0].effective.source,'Grade'); assert.equal(result.items[1].changed,false);
  assert.equal(result.executionEnabled,true); assert.equal(f.audit.length,0); assert.equal(f.policies.length,1);
});
test('save retries return immutable original receipt; stale revision and altered id reject', async () => {
  const f = fixture(), request = body();
  const first = await f.service.save(f.claims,'school',request);
  await f.service.save(f.claims,'school',body({expectedRevision:1,policy:{mode:'Disabled',rules:[]}}));
  assert.deepEqual(await f.service.save(f.claims,'school',request),first);
  assert.equal(f.policies[0].revision,2); assert.equal(f.audit.length,2);
  await assert.rejects(f.service.save(f.claims,'school',{...request,policy:{mode:'Disabled',rules:[]}}),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.service.save(f.claims,'school',body()),{code:'SCHEDULE_VERSION_CONFLICT'});
  await assert.rejects(f.service.preview(f.claims,'school',body({targetId:'foreign'})),{code:'NOT_FOUND'});
});
test('class policies replace rather than add grade rules', async () => {
  const f = fixture(); await f.service.save(f.claims,'school',body());
  const result = await f.service.preview(f.claims,'school',body({targetType:'CLASS',targetId:'one',policy:{mode:'Override',rules:[{days:[2],start:'20:00',end:'21:00'}]}}));
  assert.equal(result.items[0].effective.source,'Class'); assert.equal(result.items[0].effective.rules.length,1);
});
