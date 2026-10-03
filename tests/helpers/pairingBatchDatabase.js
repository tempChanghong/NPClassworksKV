import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {hash} from '../../domain/npep/wire.js';

export async function verifyPairingBatchDatabase(t, {fixture, request, prisma, req, activate, identity}) {
  async function setup() {
    const f = await fixture();
    f.scope = {termId:f.term.id,targetType:'SCHOOL',targetId:null,enabled:true};
    f.preview = (extra = {}) => request(`/schools/${f.school.id}/pairing-access/preview`,{auth:f.admin,body:req({...f.scope,...extra})});
    f.apply = (preview, extra = {}) => request(`/schools/${f.school.id}/pairing-access/batch`,{auth:f.admin,
      body:req({...f.scope,previewDigest:preview.data.previewDigest,...extra})});
    f.add = async (extra = {}, bindingExtra = {}) => {
      const w = await prisma.workspace.create({data:{termId:f.term.id,name:'批量测试班',code:randomUUID(),type:'ADMIN_CLASS',...extra}});
      return prisma.classroomScreenBinding.create({data:{schoolId:f.school.id,administrativeClassId:w.id,name:'批量测试屏',
        tokenHash:randomBytes(32).toString('hex'),createdByAccountId:f.account.id,...bindingExtra}});
    };
    return f;
  }
  await t.test('Batch grade scope excludes other grades, inactive screens/classes and old terms', async () => {
    const f = await setup();
    const grade = await prisma.grade.create({data:{termId:f.term.id,name:'高一',code:'G1'}});
    const otherGrade = await prisma.grade.create({data:{termId:f.term.id,name:'高二',code:'G2'}});
    await prisma.workspace.update({where:{id:f.workspace.id},data:{gradeId:grade.id}});
    const same = await f.add({gradeId:grade.id}), other = await f.add({gradeId:otherGrade.id});
    await f.add({gradeId:grade.id,isActive:false});
    await f.add({gradeId:grade.id},{isActive:false});
    await f.add({gradeId:grade.id,type:'COURSE_GROUP'});
    const oldTerm = await prisma.academicTerm.create({data:{schoolId:f.school.id,name:'旧学期',academicYear:2098,semester:1,status:'ARCHIVED'}});
    const old = await f.add({termId:oldTerm.id});
    f.scope = {...f.scope,targetType:'GRADE',targetId:grade.id};
    const preview = await f.preview(); assert.equal(preview.status,200,preview.error?.code);
    assert.equal(preview.data.totalScreens,2); assert.equal(preview.data.excludedScreens,3);
    assert.deepEqual(preview.data.items.map(i=>i.screenBindingId).sort(),[f.binding.id,same.id].sort());
    assert.equal((await f.apply(preview)).status,200);
    for (const id of [f.binding.id,same.id]) assert.equal((await prisma.classroomScreenBinding.findUnique({where:{id}})).npepPairingEnabled,true);
    for (const id of [other.id,old.id]) assert.equal((await prisma.classroomScreenBinding.findUnique({where:{id}})).npepPairingEnabled,false);
    const school = await f.preview({targetType:'SCHOOL',targetId:null});
    assert.equal(school.data.totalScreens,3); assert.equal(school.data.changedScreens,1); assert.equal(school.data.unchangedScreens,2);
  });
  await t.test('Batch preview fences changed settings, membership, login credentials and simultaneous commits', async () => {
    const f = await setup(), b = await f.add();
    const stale = await f.preview();
    await prisma.classroomScreenBinding.update({where:{id:b.id},data:{credentialVersion:{increment:1}}});
    assert.equal((await f.apply(stale)).error.code,'PREAUTHORIZATION_CHANGED');
    assert.equal((await prisma.classroomScreenBinding.findUnique({where:{id:f.binding.id}})).npepPairingEnabled,false);
    const beforeNew = await f.preview(); await f.add();
    assert.equal((await f.apply(beforeNew)).status,409);
    const beforeSetting = await f.preview();
    await prisma.classroomScreenBinding.update({where:{id:b.id},data:{npepPairingEnabled:true,npepPairingRevision:{increment:1}}});
    assert.equal((await f.apply(beforeSetting)).status,409);
    const fresh = await f.preview();
    const results = await Promise.all([f.apply(fresh),f.apply(fresh)]);
    assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
    assert.equal(await prisma.npepAudit.count({where:{schoolId:f.school.id,action:'SCREEN_PAIRING_BATCH_ENABLED'}}),1);
    assert.equal((await f.apply(fresh)).status,409,'uncertain-result retry requires fresh preview');
    assert.equal((await f.add()).npepPairingEnabled,false,'future screens do not inherit');
  });
  await t.test('Batch no-op preserves codes; closing invalidates pending claims without revoking connected devices', async () => {
    const f = await setup(), active = await activate(f), token = randomBytes(32).toString('base64url');
    const b = await f.add({}, {tokenHash:hash(token)});
    assert.equal((await f.apply(await f.preview())).status,200);
    const code = await request('/screen/pairing',{headers:{'X-Classworks-Screen-Token':token},body:req({})});
    assert.equal(code.status,201);
    const ticket = await prisma.npepScreenPairingTicket.findUnique({where:{userCode:code.data.userCode}});
    const revision = (await prisma.classroomScreenBinding.findUnique({where:{id:b.id}})).npepPairingRevision;
    const noop = await f.preview(); assert.equal(noop.data.changedScreens,0);
    assert.equal((await f.apply(noop)).status,200);
    assert.equal((await prisma.npepScreenPairingTicket.findUnique({where:{id:ticket.id}})).state,'READY');
    assert.equal((await prisma.classroomScreenBinding.findUnique({where:{id:b.id}})).npepPairingRevision,revision);
    const body = req({...identity,installationId:randomUUID(),deviceName:'批量授权测试',appVersion:'test',
      pairingSecret:randomBytes(32).toString('base64url'),requestedCapabilities:['device.status'],userCode:code.data.userCode});
    const claim = await request('/pairings/claim',{body}); assert.equal(claim.status,201);
    const ready = await request('/screen/pairing',{headers:{'X-Classworks-Screen-Token':token},body:req({})});
    f.scope.enabled = false;
    assert.equal((await f.apply(await f.preview())).status,200);
    assert.equal((await prisma.npepScreenPairingTicket.findUnique({where:{userCode:ready.data.userCode}})).state,'CANCELLED');
    assert.equal((await request(`/pairings/${claim.data.pairingId}`,{auth:`npepp1.${claim.data.pairingId}.${body.pairingSecret}`})).error.code,'SCREEN_PAIRING_DISABLED');
    assert.equal((await prisma.npepDevice.findUnique({where:{id:active.deviceId}})).state,'ACTIVE');
    assert.equal((await request('/device/me',{auth:active.auth})).status,200);
  });
  await t.test('Batch enforces administrator, term/grade ownership and strict scope bodies', async () => {
    const f = await setup(), other = await setup();
    const grade = await prisma.grade.create({data:{termId:other.term.id,name:'别校年级',code:'G'}});
    assert.equal((await f.preview({termId:other.term.id})).status,404);
    assert.equal((await f.preview({targetType:'GRADE',targetId:grade.id})).status,404);
    assert.equal((await request(`/schools/${f.school.id}/pairing-access/preview`,{auth:other.admin,body:req(f.scope)})).status,403);
    for (const extra of [{targetId:'grade'},{targetType:'GRADE',targetId:null},{enabled:'true'},{unexpected:true}]) assert.equal((await f.preview(extra)).status,400);
    const preview = await f.preview();
    assert.equal((await f.apply(preview,{previewDigest:'invalid'})).status,400);
    await prisma.schoolMember.update({where:{schoolId_accountId:{schoolId:f.school.id,accountId:f.account.id}},data:{role:'VIEWER'}});
    assert.equal((await f.apply(preview)).status,403);
    assert.equal((await prisma.classroomScreenBinding.findUnique({where:{id:f.binding.id}})).npepPairingEnabled,false);
  });
  await t.test('Batch checks revoked administrator sessions and archived terms again at commit', async () => {
    const f = await setup(), preview = await f.preview();
    await prisma.accountSession.update({where:{id:f.session.id},data:{revokedAt:new Date()}});
    assert.equal((await f.apply(preview)).status,401);
    const g = await setup(), p = await g.preview();
    await prisma.academicTerm.update({where:{id:g.term.id},data:{status:'ARCHIVED'}});
    assert.equal((await g.apply(p)).error.code,'BINDING_CHANGED');
  });
  await t.test('Batch list is bounded to 50 while applying the complete explicit scope', async () => {
    const f = await setup();
    await Promise.all(Array.from({length:50},()=>f.add()));
    const p = await f.preview(); assert.equal(p.data.totalScreens,51); assert.equal(p.data.items.length,50); assert.equal(p.data.truncated,true);
    const r = await f.apply(p); assert.equal(r.status,200,r.error?.code); assert.equal(r.data.changedScreens,51);
    assert.equal(await prisma.classroomScreenBinding.count({where:{schoolId:f.school.id,npepPairingEnabled:true}}),51);
  });
}
