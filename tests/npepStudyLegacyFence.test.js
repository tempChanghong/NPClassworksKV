import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {noiseScheduleRuntimeRepository} from '../services/npepNoiseScheduleRuntime.js';
import {defaultStudySettings} from '../domain/npep/studySettings.js';
import {digest} from '../domain/npep/wire.js';
import {identityOf} from '../domain/npep/runtimeControl.js';

test('actual legacy policy resolver retains old fingerprint when unconfigured and fences clients unable to execute study calendars',async()=>{
  const d={id:randomUUID(),serverInstanceId:randomUUID(),deploymentEpoch:randomUUID(),bindingRevision:1,schoolId:'school',administrativeClassId:'class'};
  const c={id:'class',termId:'term',gradeId:'grade',type:'ADMIN_CLASS',isActive:true};
  const old={targetType:'GRADE',targetId:'grade',revision:1,policy:{mode:'Override',rules:[{days:[1],start:'19:15',end:'21:30'}]}};
  let study=[];
  const tx={workspace:{findUnique:async()=>c},academicTerm:{findUnique:async()=>({schoolId:'school',status:'ACTIVE'})},grade:{findUnique:async()=>({termId:'term'})},
    $queryRaw:async strings=>strings.join('?').includes('NpepNoiseSchedulePolicy')?[old]:strings.join('?').includes('NpepStudySetting')?structuredClone(study):[{id:'locked'}]};
  const first=await noiseScheduleRuntimeRepository.policy(tx,d);
  assert.equal(first.source,'Grade');assert.equal(first.rules[0].start,'19:15');
  assert.equal(first.version,digest({identity:identityOf(d),term:'term',classId:'class',gradeId:'grade',gradeRevision:1,classRevision:0,effective:{source:'Grade',rules:old.policy.rules}}));
  const settings=defaultStudySettings();settings.schedule.effectiveFrom='2026-10-12';settings.schedule.rules[0].days=[1];
  study=[{targetType:'GRADE',targetId:'grade',revision:1,policy:{mode:'Override',settings}}];
  const takeover=await noiseScheduleRuntimeRepository.policy(tx,d);assert.equal(takeover.source,'Disabled');assert.deepEqual(takeover.rules,[]);
  assert.notEqual(takeover.version,first.version);
  study.push({targetType:'CLASS',targetId:'class',revision:1,policy:{mode:'Disabled',settings:null}});
  const closed=await noiseScheduleRuntimeRepository.policy(tx,d);assert.equal(closed.source,'Disabled');assert.notEqual(closed.version,takeover.version);
  study=[];assert.deepEqual(await noiseScheduleRuntimeRepository.policy(tx,d),first);
});
