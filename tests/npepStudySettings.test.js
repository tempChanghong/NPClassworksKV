import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {defaultStudySettings, validateStudyPolicy, validateStudyWrite, resolveStudyPolicy, studyWindowsForDate} from '../domain/npep/studySettings.js';
import {createNpepStudySettingsService} from '../services/npepStudySettingsService.js';
import {studySettingsRepository} from '../services/npepStudySettingsRepository.js';

function enabled() {
  const settings = defaultStudySettings();
  settings.schedule.effectiveFrom = '2026-10-12'; settings.schedule.rules[0].days = [1,2,3,4,5];
  return {mode: 'Override', settings};
}
const body = extra => ({requestId: randomUUID(), termId: 'term', targetType: 'GRADE', targetId: 'grade',
  expectedRevision: 0, policy: enabled(), ...extra});
function fixture() {
  const rows = [], requests = new Map(), audit = [];
  const catalog = {termId:'term', terms:[{id:'term',name:'本学期'}], grades:[{id:'grade',name:'高二'}],
    classes:[{id:'one',name:'一班',gradeId:'grade',pairedDevices:1},{id:'two',name:'二班',gradeId:'grade',pairedDevices:0}]};
  const repo = {catalog: async (_tx, school, term) => {
    assert.equal(school, 'school'); assert.equal(term, 'term'); return structuredClone(catalog);
  }, settings: async () => structuredClone(rows), request: async (_tx,_school,id) => requests.get(id),
  homeworkSources: async (_tx,_school,_term,ids) => ids.flatMap(id => [{id,name:id,type:'ADMIN_CLASS',sourceClassIds:[id]},
    {id:'walk-'+id,name:'物理走班 '+id,type:'COURSE_GROUP',subjectName:'物理',sourceClassIds:[id]}]),
  save: async (_tx,_school,actorId,request,result,fingerprint) => {
    const row = {targetType:request.targetType,targetId:request.targetId,revision:result.revision,policy:structuredClone(request.policy)};
    const index = rows.findIndex(r => r.targetType===row.targetType && r.targetId===row.targetId);
    if (index<0) rows.push(row); else rows[index]=row;
    requests.set(request.requestId,{actorId,digest:fingerprint,result:structuredClone(result)});
  }};
  const base = {withScheduleAdmin: async (claims, school, work) => { assert.equal(claims.accountId,'admin'); return work({npepAudit:{create:async row=>audit.push(row)}},{}); }};
  return {service:createNpepStudySettingsService(base,repo),claims:{accountId:'admin'},rows,requests,audit,catalog};
}
async function prepared(f, request) {
  const result = await f.service.preview(f.claims,'school',request);
  return {...request,expectedPreviewFingerprint:result.previewFingerprint};
}

test('estimated thresholds have explicit acoustic units without changing legacy digital values', async () => {
  const p=enabled();p.settings.noise.redLineDbfs=-35;p.settings.noise.mediumLineDbfs=-45;
  p.settings.noise.estimated={highDbA:65,mediumDbA:55};
  assert.equal(validateStudyPolicy(p),null);
  const f=fixture(),request=body({policy:p});
  await f.service.save(f.claims,'school',await prepared(f,request));
  const read=await f.service.list(f.claims,'school','term');
  assert.deepEqual(read.settings[0].policy.settings.noise,p.settings.noise);
  const oldClient=structuredClone(p);delete oldClient.settings.noise.estimated;
  await assert.rejects(f.service.preview(f.claims,'school',body({expectedRevision:1,policy:oldClient})),{code:'STUDY_SETTING_UPGRADE_REQUIRED'});
  const digital=structuredClone(p);digital.settings.noise.estimated=null;
  assert.equal(validateStudyPolicy(digital),null);
  await f.service.preview(f.claims,'school',body({expectedRevision:1,policy:digital}));
  for(const e of [{highDbA:40,mediumDbA:50},{highDbA:131,mediumDbA:55},{highDbA:null,mediumDbA:55},{highDbA:'65',mediumDbA:55},{highDbA:65,mediumDbA:55,unit:'dBFS'}]){
    assert.equal(validateStudyPolicy({...p,settings:{...p.settings,noise:{...p.settings.noise,estimated:e}}}),'INVALID_NOISE');
  }
});

test('new defaults require dates/weekdays and do not invent the school activation date or threshold', () => {
  const s=defaultStudySettings();
  assert.deepEqual(s.schedule.rules,[{days:[],start:'19:00',end:'21:30'}]);
  assert.equal(s.schedule.effectiveFrom,''); assert.equal(s.noise.redLineDbfs,null);
  assert.equal(s.presentation.noiseDisplay,'StatusTrend'); assert.equal(s.homework.rotationSeconds,60);
  assert.equal(s.presentation.temporaryHideSeconds,180); assert.equal(s.photos.enabled,false);
  assert.equal(s.photos.continuousSeconds,3); assert.equal(s.photos.cooldownSeconds,30); assert.equal(s.photos.retentionDays,30);
  assert.equal(validateStudyPolicy({mode:'Override',settings:s},true),'INVALID_DATES');
  assert.equal(validateStudyPolicy(enabled(),true),null);
  for (const mode of ['Disabled','Inherit']) assert.equal(validateStudyPolicy({mode,settings:null}),null);
  assert.equal(validateStudyPolicy({mode:'Inherit',settings:null},true),'INVALID_MODE');
});

test('photo hard limits, redline and extended retention acknowledgment cannot be bypassed by coercion', () => {
  const p=enabled(), s=p.settings; s.photos.enabled=true;
  assert.equal(validateStudyPolicy(p),'PHOTO_THRESHOLD_REQUIRED');
  s.noise.redLineDbfs=-35; assert.equal(validateStudyPolicy(p),null);
  s.photos.retentionDays=180; assert.equal(validateStudyPolicy(p),'RETENTION_ACK_REQUIRED');
  s.photos.extendedRetentionAcknowledged=true; assert.equal(validateStudyPolicy(p),null);
  for (const value of [181,0,'30']) { s.photos.retentionDays=value; assert.equal(validateStudyPolicy(p),'INVALID_PHOTOS'); }
  s.photos.retentionDays=30;
  for (const value of [29,301,'30']) { s.photos.cooldownSeconds=value; assert.equal(validateStudyPolicy(p),'INVALID_PHOTOS'); }
  s.photos.cooldownSeconds=30; s.photos.captureOnExit=false; assert.equal(validateStudyPolicy(p),'INVALID_PHOTOS');
  s.photos.captureOnExit=true; s.noise.enabled=false; assert.equal(validateStudyPolicy(p),'PHOTO_THRESHOLD_REQUIRED');
  s.noise.enabled=true; s.presentation.temporaryHideSeconds=181; assert.equal(validateStudyPolicy(p),'INVALID_PRESENTATION');
});

test('calendar exceptions and cross-midnight windows use explicit start-date school calendars', () => {
  const s=enabled().settings;
  assert.equal(studyWindowsForDate(s,'2026-10-11').length,0);
  assert.deepEqual(studyWindowsForDate(s,'2026-10-12'),[{start:'2026-10-12T19:00:00',end:'2026-10-12T21:30:00'}]);
  s.schedule.exceptions=[{date:'2026-10-12',kind:'Skip',weekday:null},{date:'2026-10-18',kind:'UseWeekday',weekday:1}];
  assert.equal(studyWindowsForDate(s,'2026-10-12').length,0);
  assert.equal(studyWindowsForDate(s,'2026-10-18').length,1);
  s.schedule.rules=[{days:[1],start:'23:00',end:'01:00'}];
  assert.deepEqual(studyWindowsForDate(s,'2026-10-18'),[{start:'2026-10-18T23:00:00',end:'2026-10-19T01:00:00'}]);
  s.schedule.effectiveTo='2026-10-18'; assert.equal(studyWindowsForDate(s,'2026-10-19').length,0);
  s.schedule.exceptions.push({date:'2026-10-18',kind:'Skip',weekday:null}); assert.equal(validateStudyPolicy({mode:'Override',settings:s}),'INVALID_CALENDAR');
  s.schedule.exceptions=[{date:'2026-02-30',kind:'Skip',weekday:null}]; assert.equal(validateStudyPolicy({mode:'Override',settings:s}),'INVALID_CALENDAR');
});

test('calendar substitutions cannot produce a merged window longer than three hours', () => {
  const p=enabled(); p.settings.schedule.rules=[{days:[1],start:'23:00',end:'01:00'},{days:[3],start:'01:00',end:'03:00'}];
  assert.equal(validateStudyPolicy(p),null);
  p.settings.schedule.exceptions=[{date:'2026-10-13',kind:'UseWeekday',weekday:3}];
  assert.equal(validateStudyPolicy(p),'MERGED_WINDOW_TOO_LONG');
});

test('strict writes reject extra permissions, blank sources, invalid dates and missing preview fingerprints', () => {
  const request=body(); assert.equal(validateStudyWrite(request,true),true); assert.equal(validateStudyWrite(request),false);
  const write={...request,expectedPreviewFingerprint:'a'.repeat(64)}; assert.equal(validateStudyWrite(write),true);
  for (const bad of [{...write,photoViewRoles:['TEACHER']},{...write,expectedRevision:'0'},{...write,previewDate:'2026-10-12'},
    {...request,previewDate:'2026-02-30'},{...write,policy:{mode:'Override',settings:{...enabled().settings,video:true}}}]) assert.equal(validateStudyWrite(bad),false);
  const p=enabled(); p.settings.homework.sourceMode='SelectedClasses'; assert.equal(validateStudyPolicy(p),'INVALID_HOMEWORK');
  p.settings.homework.sourceClassIds=['one','one']; assert.equal(validateStudyPolicy(p),'INVALID_HOMEWORK');
});

test('grade preview respects class overrides/closures and computes source scope without writes', async () => {
  const f=fixture(); f.rows.push({targetType:'CLASS',targetId:'two',revision:1,policy:{mode:'Disabled',settings:null}});
  const result=await f.service.preview(f.claims,'school',body({previewDate:'2026-10-12'}));
  assert.equal(result.totalClasses,2); assert.equal(result.changedClasses,1); assert.equal(result.pairedDevices,1);
  assert.equal(result.items[0].effective.source,'Grade'); assert.equal(result.items[1].effective.source,'Disabled');
  assert.equal(result.items[0].homeworkSources.length,2); assert.equal(result.items[1].homeworkSources.length,0);
  assert.equal(result.integration.executionState,'NOT_VERIFIED'); assert.equal(result.integration.backupRetention,'UNKNOWN');
  assert.equal(f.audit.length,0); assert.equal(f.rows.length,1);
  assert.deepEqual(resolveStudyPolicy(enabled(),{mode:'Inherit',settings:null}).settings,enabled().settings);
});

test('save/read is versioned, idempotent, audited, and rejects a changed preview or foreign source', async () => {
  const f=fixture(), request=await prepared(f,body());
  const first=await f.service.save(f.claims,'school',request);
  assert.equal(first.revision,1); assert.equal(f.audit.length,1);
  const list=await f.service.list(f.claims,'school','term'); assert.equal(list.settings[0].policy.settings.homework.rotationSeconds,60);
  assert.deepEqual(await f.service.save(f.claims,'school',request),first); assert.equal(f.audit.length,1);
  await assert.rejects(f.service.save(f.claims,'school',{...request,policy:{mode:'Disabled',settings:null}}),{code:'IDEMPOTENCY_CONFLICT'});
  await assert.rejects(f.service.preview(f.claims,'school',body()),{code:'STUDY_SETTING_VERSION_CONFLICT'});
  const next=await prepared(f,body({expectedRevision:1}));
  f.rows.push({targetType:'CLASS',targetId:'two',revision:1,policy:{mode:'Disabled',settings:null}});
  await assert.rejects(f.service.save(f.claims,'school',next),{code:'STUDY_PREVIEW_CHANGED'});
  assert.equal(f.rows[0].revision,1);
  const p=enabled(); p.settings.homework.sourceMode='SelectedClasses'; p.settings.homework.sourceClassIds=['foreign'];
  await assert.rejects(f.service.preview(f.claims,'school',body({expectedRevision:1,policy:p})),{code:'STUDY_SOURCE_UNAVAILABLE'});
  await assert.rejects(f.service.preview(f.claims,'school',body({targetId:'foreign'})),{code:'NOT_FOUND'});
});

test('source repository includes every related same-subject walk group, excludes unrelated groups and deduplicates shared sources', async () => {
  const classes=[{id:'one',name:'一班',gradeId:'grade',termId:'term',type:'ADMIN_CLASS',subjectRules:[{subjectId:'physics',deliveryMode:'COURSE_GROUP'}]},
    {id:'two',name:'二班',gradeId:'grade',termId:'term',type:'ADMIN_CLASS',subjectRules:[{subjectId:'physics',deliveryMode:'COURSE_GROUP'}]}];
  const course=(id,source,extra={})=>({id,name:id,type:'COURSE_GROUP',gradeId:'grade',termId:'term',subjectId:'physics',subject:{name:'物理'},sourceClasses:source.map(administrativeClassId=>({administrativeClassId})),...extra});
  const courses=[course('walk1',['one','two']),course('walk2',['one']),course('other',['three']),course('foreignGrade',['one'],{gradeId:'foreign'}),course('wrongSubject',['one'],{subjectId:'chemistry'})];
  const queries=[];
  const tx={workspace:{findMany:async query=>{queries.push(query); return query.where.type==='ADMIN_CLASS'?classes:courses;}}};
  const result=await studySettingsRepository.homeworkSources(tx,'school','term',['one','two']);
  assert.deepEqual(result.map(row=>row.id).sort(),['one','two','walk1','walk2']);
  assert.deepEqual(result.find(row=>row.id==='walk1').sourceClassIds,['one','two']);
  assert.deepEqual(queries[0].where.term,{schoolId:'school',status:'ACTIVE'});
  assert.equal(queries[1].where.isActive,true); assert.equal(queries[1].where.termId,'term');
  await assert.rejects(studySettingsRepository.homeworkSources(tx,'school','term',['one','two','missing']),{code:'STUDY_SOURCE_UNAVAILABLE'});
});

test('dual thresholds validate order and independent cooldown while legacy reads preserve customs',async()=>{
  const p=enabled();p.settings.noise.redLineDbfs=-35;p.settings.noise.mediumLineDbfs=-45;
  assert.equal(validateStudyPolicy(p),null);
  for(const bad of [-35,-30,'-45',Infinity,NaN]){p.settings.noise.mediumLineDbfs=bad;assert.equal(validateStudyPolicy(p),'INVALID_NOISE');}
  p.settings.noise.mediumLineDbfs=-45;
  for(const bad of [0,-1,'600',Infinity,86401]){p.settings.noise.disciplineCooldownSeconds=bad;assert.equal(validateStudyPolicy(p),'INVALID_NOISE');}
  p.settings.noise.disciplineCooldownSeconds=720;p.settings.photos.cooldownSeconds=30;
  assert.equal(validateStudyPolicy(p),null);
  const legacy=enabled();legacy.settings.photos.continuousSeconds=2;legacy.settings.noise={enabled:true,redLineDbfs:-37};legacy.settings.schedule.rules[0].start='19:10';
  const before=structuredClone(legacy),f=fixture();f.rows.push({targetType:'GRADE',targetId:'grade',revision:4,policy:legacy});
  const read=await f.service.list(f.claims,'school','term');
  assert.deepEqual(read.settings[0].policy.settings.noise,{enabled:true,redLineDbfs:-37,mediumLineDbfs:null,disciplineCooldownSeconds:600,highContinuousSeconds:2});
  assert.equal(read.settings[0].policy.settings.schedule.rules[0].start,'19:10');
  assert.deepEqual(legacy,before);assert.deepEqual(f.rows[0].policy,before);
  assert.equal(resolveStudyPolicy(legacy,{mode:'Inherit',settings:null}).settings.noise.mediumLineDbfs,null);
  f.rows[0].policy=structuredClone(p);
  await assert.rejects(f.service.preview(f.claims,'school',body({expectedRevision:4,policy:legacy})),error=>error.code==='STUDY_SETTING_UPGRADE_REQUIRED');
  assert.deepEqual(f.rows[0].policy,p);
});

test('high qualification default is three seconds and legacy photo duration is a consistent compatibility mirror',()=>{
  const p=enabled();assert.equal(p.settings.noise.highContinuousSeconds,3);assert.equal(p.settings.photos.continuousSeconds,3);
  p.settings.noise.highContinuousSeconds=4;assert.equal(validateStudyPolicy(p),'INCONSISTENT_THRESHOLD_DURATION');
  p.settings.photos.continuousSeconds=4;assert.equal(validateStudyPolicy(p),null);
  for(const bad of [0,11,'5',NaN]){p.settings.noise.highContinuousSeconds=bad;assert.equal(validateStudyPolicy(p),'INVALID_NOISE');}
});
