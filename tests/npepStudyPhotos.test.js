import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import jpeg from 'jpeg-js';
import express from 'express';
import {once} from 'node:events';
import {createNpepPhotoRouter} from '../routes/v2/npepPhotos.js';
import {cleanupStudyPhotos} from '../services/npepPhotoMaintenance.js';
import {fixture as seatingFixture} from './helpers/npepSeatingFixture.js';
import {defaultStudySettings} from '../domain/npep/studySettings.js';
import {createNpepPhotoService} from '../services/npepPhotoService.js';
import {sanitizePhoto, NpepPhotoStore} from '../services/npepPhotoStore.js';
import {photoHash, validatePhotoMetadata, jpegDimensions} from '../domain/npep/studyPhotos.js';
function fixture(options = {}) {
  const f = seatingFixture(), leases = new Map(), rows = new Map(), files = new Map();
  let now = Date.now();
  f.config.effective.settings = defaultStudySettings();
  f.config.effective.settings.photos.enabled = true;
  f.config.effective.settings.noise.redLineDbfs = -30;
  const sessionId = randomUUID();
  f.applied.execution = {version: f.version, context: f.context, receivedAt: new Date(now).toISOString(), status: {
    owner: 'Schedule', state: 'Active', signalFresh: true, clockReady: true, reason: 'WINDOW_ACTIVE', sessionId,
    schoolNow: '2026-10-11T20:00:00.000', window: {start: '2026-10-11T19:00:00.000', end: '2026-10-11T21:30:00.000'}}};
  f.tx.npepSessionReceipt.findUnique = async () => ({...f.context, deviceId: f.device.id, expiresAt: new Date(now + 60000)});
  const repo = {lease: async (_t, id) => leases.get(id), saveLease: async (_t, r) => leases.set(r.id, r),
    event: async (_t, id) => rows.get(id), usage: async () => [...rows.values()].filter(r => ['Stored', 'Uploading', 'DeletePending'].includes(r.state)).reduce((a,r) => a+r.byteCount, 0),
    neighboring: async (_t, d, at, seconds) => [...rows.values()].find(r => r.deviceId === d && Math.abs(r.capturedAt-at)<seconds*1000),
    saveEvent: async (_t, r) => rows.set(r.eventId, r), state: async (_t, id, state) => {rows.get(id).state = state;},
    list: async (_t, school, term, classroom) => [...rows.values()].filter(r => r.schoolId === school && r.termId === term && r.classId === classroom && r.state === 'Stored' && r.expiresAt.getTime()>now)};
  const store = {put: async (id, b) => files.set(id, b), read: async id => files.get(id), remove: async id => files.delete(id)};
  const service = createNpepPhotoService(f.base, f.study, {repo, store, clock: () => now, encode: async bytes => ({bytes, width: 2, height: 2}), ...options});
  const body = {requestId: randomUUID(), version: f.version, context: f.context};
  const bytes = jpeg.encode({width: 2, height: 2, data: Buffer.alloc(16, 255)}, 60).data;
  const meta = lease => ({eventId: randomUUID(), leaseId: lease.leaseId, sessionId, version: f.version,
    capturedAt: new Date(now).toISOString(), schoolNow: '2026-10-11T20:00:00.000', reason: 'Noise', unit: 'Dbfs',
    level: -20, high: -30, continuousSeconds: 3, calibrationId: null, hash: photoHash(bytes), width: 2, height: 2, byteCount: bytes.length});
  return {...f, repo, rows, files, leases, service, body, bytes, meta, auth: {id:f.device.id}, clock:()=>now, advance: ms => {now += ms;}};
}
test('photo permission is separate and requires fresh actual scheduled sampling', async () => {
  const f=fixture(); const lease=await f.service.lease(f.auth,f.body);
  assert.equal(lease.leaseSeconds,60); assert.equal(lease.sessionId,f.applied.execution.status.sessionId);
  for(const patch of [{owner:'Manual'},{state:'Idle'},{signalFresh:false},{clockReady:false}]) {
    const original={...f.applied.execution.status}; Object.assign(f.applied.execution.status,patch);
    await assert.rejects(f.service.lease(f.auth,f.body), e=>e.code==='PHOTO_EXECUTION_NOT_FRESH'); f.applied.execution.status=original;
  }
  f.advance(15000); await assert.rejects(f.service.lease(f.auth,f.body),e=>e.code==='PHOTO_EXECUTION_NOT_FRESH');
});
test('disabled photographs and stale/replaced bindings cannot grant permission', async () => {
  const f=fixture();f.config.effective.settings.photos.enabled=false;
  await assert.rejects(f.service.lease(f.auth,f.body),e=>e.code==='PHOTOS_DISABLED');
  f.config.effective.settings.photos.enabled=true;f.device.bindingRevision++;
  await assert.rejects(f.service.lease(f.auth,f.body),e=>e.code==='AUTH_INVALID');
});
test('photo upload is idempotent; shared noise/exit cooldown; conflicting bytes rejected', async () => {
  const f=fixture(), lease=await f.service.lease(f.auth,f.body), meta=f.meta(lease);
  assert.equal((await f.service.upload(f.auth,meta,f.bytes)).state,'Stored');
  assert.deepEqual(await f.service.upload(f.auth,meta,f.bytes),await f.service.upload(f.auth,meta,f.bytes));
  assert.equal(f.rows.size,1);
  await assert.rejects(f.service.upload(f.auth,{...meta,eventId:randomUUID(),reason:'ExitAttempt',level:null},f.bytes),e=>e.code==='PHOTO_COOLDOWN');
  await assert.rejects(f.service.upload(f.auth,{...meta,level:-21},f.bytes),e=>e.code==='IDEMPOTENCY_CONFLICT');
  f.advance(30000);assert.equal((await f.service.upload(f.auth,{...f.meta(lease),reason:'ExitAttempt',level:null},f.bytes)).state,'Stored');
});
test('capture outside permission and stale delayed uploads are rejected', async () => {
  const f=fixture(),lease=await f.service.lease(f.auth,f.body),meta=f.meta(lease);
  await assert.rejects(f.service.upload(f.auth,{...meta,capturedAt:new Date(Date.parse(meta.capturedAt)+1).toISOString()},f.bytes),e=>e.code==='PHOTO_TIME_INVALID');
  f.advance(60000);await assert.rejects(f.service.upload(f.auth,f.meta(lease),f.bytes),e=>e.code==='PHOTO_TIME_INVALID');
  f.advance(86400000);await assert.rejects(f.service.upload(f.auth,meta,f.bytes),e=>e.code==='PHOTO_TIME_INVALID');
});
test('deletion prevents late retry resurrection and access is checked for every operation', async () => {
  const f=fixture(), lease=await f.service.lease(f.auth,f.body),meta=f.meta(lease);
  await f.service.upload(f.auth,meta,f.bytes);assert.equal((await f.service.list(f.claims,'school','term','one')).items.length,1);
  f.setRole('TEACHER');await assert.rejects(f.service.image(f.claims,'school',meta.eventId),e=>e.code==='ADMIN_REQUIRED');
  await assert.rejects(f.service.remove(f.claims,'school',meta.eventId),e=>e.code==='ADMIN_REQUIRED');
  f.setRole('ADMIN');await f.service.remove(f.claims,'school',meta.eventId);assert.equal(f.files.size,0);
  await assert.rejects(f.service.upload(f.auth,meta,f.bytes),e=>e.code==='PHOTO_DELETED');
});
test('expiry applies to capture time, not server receive time; storage quota fails closed', async () => {
  const f=fixture({quotaBytes:1}), lease=await f.service.lease(f.auth,f.body);
  await assert.rejects(f.service.upload(f.auth,f.meta(lease),f.bytes),e=>e.code==='PHOTO_STORAGE_QUOTA');
  const g=fixture();g.config.effective.settings.photos.retentionDays=1;
  const l=await g.service.lease(g.auth,g.body),m=g.meta(l);await g.service.upload(g.auth,m,g.bytes);g.advance(86400000);
  await assert.rejects(g.service.image(g.claims,'school',m.eventId),e=>e.code==='NOT_FOUND');
});

test('a failed physical deletion remains invisible and continues consuming quota until retry succeeds', async () => {
  let failRemoval=true;
  const f=fixture({quotaBytes:1000,store:{
    put:async(id,bytes)=>f.files.set(id,bytes),read:async id=>f.files.get(id),
    remove:async id=>{if(failRemoval)throw Error('simulated unlink failure');f.files.delete(id);},
  }});
  const lease=await f.service.lease(f.auth,f.body),first=f.meta(lease);
  await f.service.upload(f.auth,first,f.bytes);
  await assert.rejects(f.service.remove(f.claims,'school',first.eventId),/simulated unlink failure/);
  assert.equal(f.rows.get(first.eventId).state,'DeletePending');assert.equal(f.files.size,1);
  assert.equal((await f.service.list(f.claims,'school','term','one')).items.length,0);
  f.advance(30000);const next=f.meta(lease);
  await assert.rejects(f.service.upload(f.auth,next,f.bytes),e=>e.code==='PHOTO_STORAGE_QUOTA');
  failRemoval=false;await f.service.remove(f.claims,'school',first.eventId);
  assert.equal(f.files.size,0);assert.equal((await f.service.upload(f.auth,next,f.bytes)).state,'Stored');
});
test('estimated acoustic and raw levels remain separate and malformed metadata cannot pass', async () => {
  const f=fixture(),lease=await f.service.lease(f.auth,f.body),m=f.meta(lease);
  assert.equal(validatePhotoMetadata({...m,reason:'ExitAttempt',level:null}),true);
  assert.equal(validatePhotoMetadata({...m,unit:'EstimatedDbA'}),false);
  for(const p of [{width:1281},{byteCount:262145},{high:NaN},{schoolNow:'2026-02-30T20:00:00.000'}])assert.equal(validatePhotoMetadata({...m,...p}),false);
  await assert.rejects(f.service.upload(f.auth,{...m,unit:'EstimatedDbA',high:70,level:75,calibrationId:'a'.repeat(64)},f.bytes),e=>e.code==='PHOTO_THRESHOLD_CHANGED');
  f.config.effective.settings.noise.estimated={highDbA:70,mediumDbA:60};
  const acoustic=await f.service.lease(f.auth,f.body),exit={...f.meta(acoustic),reason:'ExitAttempt',unit:'EstimatedDbA',level:null,high:70,calibrationId:null};
  assert.equal(validatePhotoMetadata(exit),true);
  assert.equal((await f.service.upload(f.auth,exit,f.bytes)).state,'Stored');
  assert.equal(validatePhotoMetadata({...exit,reason:'Noise'}),false);
});
test('bounded JPEG worker decodes real synthetic pixels, strips metadata and private storage round trips', async t => {
  const f=fixture(), root=await mkdtemp(path.join(tmpdir(),'npep-photo-test-'));
  assert.equal(path.dirname(path.resolve(root)),path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('npep-photo-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const image=await sanitizePhoto(f.bytes);assert.equal(image.width,2);assert.equal(image.height,2);
  const store=new NpepPhotoStore(root), id=randomUUID();await store.put(id,image.bytes);
  assert.deepEqual(await store.read(id,photoHash(image.bytes)),image.bytes);await store.remove(id);await store.remove(id);
  await assert.rejects(store.read(id,photoHash(image.bytes)));
  await assert.rejects(sanitizePhoto(Buffer.from('not an image')),e=>e.code==='INVALID_PHOTO');
});
test('new defaults are three seconds while explicitly saved five seconds is preserved', () => {
  const settings=defaultStudySettings();assert.equal(settings.noise.highContinuousSeconds,3);assert.equal(settings.photos.continuousSeconds,3);
  settings.noise.highContinuousSeconds=settings.photos.continuousSeconds=5;
  assert.equal(settings.noise.highContinuousSeconds,5);
});
test('actual loopback HTTP photo flow keeps private bytes, strict headers and current role checks', async t => {
  const f=fixture(); f.base.preflightDevice=async auth=>{assert.equal(auth.id,f.device.id);};
  const app=express();app.use(createNpepPhotoRouter({base:f.base,study:f.study,rateLimits:false,
    authenticate:token=>{if(token!=='admin-token')throw Error();return f.claims;},
    options:{repo:f.repo,store:{put:async(id,b)=>f.files.set(id,b),read:async id=>f.files.get(id),remove:async id=>f.files.delete(id)},
      clock:f.clock, encode:async bytes=>({bytes,width:2,height:2})}}));
  const server=app.listen(0,'127.0.0.1');t.after(()=>new Promise(resolve=>server.close(resolve)));await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const deviceHeaders=()=>({'X-NPEP-Version':'0.15','X-Request-Id':randomUUID(),Authorization:`Bearer npep1.${f.device.id}.${Buffer.alloc(32,1).toString('base64url')}`});
  const h=deviceHeaders();h['Content-Type']='application/json'; const body={...f.body,requestId:h['X-Request-Id']};
  let response=await fetch(origin+'/device/study-settings/photos/lease',{method:'POST',headers:h,body:JSON.stringify(body)});
  assert.equal(response.status,200);const lease=(await response.json()).data;
  const meta=f.meta(lease), up=deviceHeaders();up['Content-Type']='image/jpeg';up['X-NPEP-Photo']=Buffer.from(JSON.stringify(meta)).toString('base64url');
  response=await fetch(origin+'/device/study-settings/photos/upload',{method:'POST',headers:up,body:f.bytes});assert.equal(response.status,200);
  const admin=()=>({'X-NPEP-Version':'0.15','X-Request-Id':randomUUID(),Authorization:'Bearer admin-token'});
  response=await fetch(origin+'/schools/school/study-photos?termId=term&classId=one',{headers:admin()});
  assert.equal(response.status,200);assert.equal((await response.json()).data.items.length,1);
  const image=origin+'/schools/school/study-photos/'+meta.eventId+'/image';
  response=await fetch(image,{headers:admin()});assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'private, no-store');assert.equal(response.headers.get('content-type'),'image/jpeg');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),f.bytes);
  f.setRole('TEACHER');assert.equal((await fetch(image,{headers:admin()})).status,403);
  f.setRole('ADMIN');const del=admin();del['Content-Type']='application/json';
  response=await fetch(origin+'/schools/school/study-photos/'+meta.eventId+'/delete',{method:'POST',headers:del,body:JSON.stringify({requestId:del['X-Request-Id']})});assert.equal(response.status,200);
  assert.equal((await fetch(image,{headers:admin()})).status,404);
  response=await fetch(origin+'/device/study-settings/photos/upload?classId=foreign',{method:'POST',headers:up,body:f.bytes});assert.equal(response.status,400);
  response=await fetch(origin+'/device/study-settings/photos/upload',{method:'POST',headers:{...up,'X-NPEP-Photo':'bad+'},body:f.bytes});assert.equal(response.status,400);
  response=await fetch(origin+'/device/study-settings/photos/upload',{method:'POST',headers:up,body:Buffer.alloc(262145)});assert.equal(response.status,413);
});
test('cleanup retries failed file removal and keeps deletion tombstones', async () => {
  const id=randomUUID(), failed=randomUUID(), states=[];
  const tx={$queryRaw:async strings=>strings.join('').includes('advisory')?[{locked:true}]:[{eventId:id},{eventId:failed}],
    $executeRaw:async(strings,...values)=>{states.push({sql:strings.join(''),values});}};
  let removed=[];
  await cleanupStudyPhotos({$transaction:async work=>work(tx)},{remove:async event=>{removed.push(event);if(event===failed)throw Error('simulated filesystem failure');}});
  assert.deepEqual(removed,[id,failed]);
  const final=states.filter(s=>s.sql.includes("SET state='Deleted'"));assert.equal(final.length,1);assert.equal(final[0].values[0],id);
  assert.ok(states.some(s=>s.sql.includes("interval '2 days'")));
});
test('failed storage publication is not visible; retry publishes once; window boundary is excluded', async () => {
  const f=fixture(), lease=await f.service.lease(f.auth,f.body), meta=f.meta(lease);
  await assert.rejects(f.service.upload(f.auth,{...meta,schoolNow:'2026-10-11T21:30:00.000'},f.bytes),e=>e.code==='PHOTO_OUTSIDE_WINDOW');
  let failed=true;
  const g=fixture({store:{put:async(id,bytes)=>{if(failed)throw Error('simulated I/O');g.files.set(id,bytes);}}}), l=await g.service.lease(g.auth,g.body),m=g.meta(l);
  await assert.rejects(g.service.upload(g.auth,m,g.bytes),/simulated I\/O/);
  assert.equal(g.rows.get(m.eventId).state,'Uploading');
  assert.equal((await g.service.list(g.claims,'school','term','one')).items.length,0);
  failed=false;await g.service.upload(g.auth,m,g.bytes);assert.equal(g.rows.size,1);assert.equal(g.rows.get(m.eventId).state,'Stored');
});
test('malformed JPEG marker padding is rejected before decoding', () => {
  const bytes=Buffer.from([255,216,255,255,255,255,255,255,217]);
  assert.throws(()=>jpegDimensions(bytes),e=>e.code==='INVALID_PHOTO');
});
