import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

export async function verifyNoiseScheduleDatabase(t, {fixture, request, prisma, req, activate}) {
  const policy = {mode:'Override',rules:[{days:[1,2,3,4,5],start:'19:00',end:'21:00'}]};
  async function setup() {
    const f = await fixture();
    f.grade = await prisma.grade.create({data:{termId:f.term.id,code:'TWO',name:'高二'}});
    await prisma.workspace.update({where:{id:f.workspace.id},data:{gradeId:f.grade.id}});
    f.path = `/schools/${f.school.id}/noise-schedules`;
    f.body = extra => req({termId:f.term.id,targetType:'GRADE',targetId:f.grade.id,expectedRevision:0,policy,...extra});
    f.call = (path = '', body, auth = f.admin) => request(f.path+path,{body,auth,headers:{'X-NPEP-Version':'0.7'}});
    return f;
  }
  await t.test('N4.3b real SQL: grade/class preview, pairing count, save audit and reload', async () => {
    const f = await setup(); await activate(f);
    const second = await prisma.workspace.create({data:{termId:f.term.id,gradeId:f.grade.id,type:'ADMIN_CLASS',code:'TWO',name:'二班'}});
    assert.equal((await f.call('',f.body({targetType:'CLASS',targetId:second.id,policy:{mode:'Disabled',rules:[]}}))).status,200);
    const preview = await f.call('/preview',f.body());
    assert.equal(preview.status,200); assert.equal(preview.data.changedClasses,1); assert.equal(preview.data.pairedDevices,1);
    assert.equal(preview.data.executionEnabled,true);
    assert.equal((await prisma.$queryRaw`SELECT * FROM "NpepNoiseSchedulePolicy" WHERE "schoolId"=${f.school.id}`).length,1);
    assert.equal((await f.call('',f.body())).data.revision,1);
    const list = await f.call(`?termId=${f.term.id}`);
    assert.equal(list.status,200); assert.equal(list.data.policies.length,2);
    assert.equal(list.data.classes.find(c=>c.id===f.workspace.id).pairedDevices,1);
    assert.equal(await prisma.npepAudit.count({where:{schoolId:f.school.id,action:'NOISE_SCHEDULE_SAVED'}}),2);
  });
  await t.test('N4.3b real SQL: concurrent saves serialize; response-loss retry never overwrites', async () => {
    const f = await setup(), first = f.body(), second = f.body();
    const responses = await Promise.all([f.call('',first),f.call('',second)]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
    const winner = responses[0].status===200 ? first : second;
    const saved = responses.find(r=>r.status===200).data;
    assert.equal(responses.find(r=>r.status===409).error.code,'SCHEDULE_VERSION_CONFLICT');
    assert.equal((await f.call('',f.body({expectedRevision:1,policy:{mode:'Disabled',rules:[]}}))).data.revision,2);
    assert.deepEqual((await f.call('',winner)).data,saved);
    const rows = await prisma.$queryRaw`SELECT revision,policy FROM "NpepNoiseSchedulePolicy" WHERE "schoolId"=${f.school.id}`;
    assert.equal(rows[0].revision,2); assert.equal(rows[0].policy.mode,'Disabled');
    assert.equal((await f.call('',{...winner,policy:{mode:'Disabled',rules:[]}})).error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal(await prisma.npepAudit.count({where:{schoolId:f.school.id,action:'NOISE_SCHEDULE_SAVED'}}),2);
  });
  await t.test('N4.3b real HTTP: school/term/class isolation, membership removal and strict parsing', async () => {
    const f = await setup(), foreign = await setup();
    assert.equal((await f.call('',f.body({targetId:foreign.grade.id}))).status,404);
    assert.equal((await f.call(`?termId=${foreign.term.id}`)).status,404);
    assert.equal((await f.call('',f.body(),foreign.admin)).status,403);
    const group = await prisma.workspace.create({data:{termId:f.term.id,type:'COURSE_GROUP',code:'COURSE',name:'走班'}});
    assert.equal((await f.call('',f.body({targetType:'CLASS',targetId:group.id}))).status,404);
    await prisma.workspace.update({where:{id:f.workspace.id},data:{isActive:false}});
    assert.equal((await f.call('',f.body({targetType:'CLASS',targetId:f.workspace.id}))).status,404);
    assert.equal((await f.call('',f.body({policy:{mode:'Override',rules:[{days:[1],start:'19:00',end:'22:01'}]}}))).status,400);
    assert.equal((await f.call('?termId=x&termId=y')).status,400);
    assert.equal((await f.call('?secret=x')).status,400);
    assert.equal((await request(f.path,{auth:f.admin})).status,426);
    const duplicate = await request(f.path,{auth:f.admin,raw:JSON.stringify(f.body()).replace('"targetType":"GRADE"','"targetType":"GRADE","targetType":"CLASS"'),headers:{'X-NPEP-Version':'0.7'}});
    assert.equal(duplicate.status,400);
    await prisma.schoolMember.update({where:{schoolId_accountId:{schoolId:f.school.id,accountId:f.account.id}},data:{role:'VIEWER'}});
    assert.equal((await f.call()).status,403); assert.equal((await f.call('',f.body())).status,403);
    await prisma.schoolMember.delete({where:{schoolId_accountId:{schoolId:f.school.id,accountId:f.account.id}}});
    assert.equal((await f.call()).status,403);
    assert.equal((await prisma.$queryRaw`SELECT * FROM "NpepNoiseSchedulePolicy" WHERE "schoolId"=${f.school.id}`).length,0);
  });
  await t.test('N4.3b real SQL: inactive term is not editable', async () => {
    const f = await setup();
    await prisma.academicTerm.update({where:{id:f.term.id},data:{status:'ARCHIVED'}});
    assert.equal((await f.call('',f.body())).error.code,'TERM_NOT_ACTIVE');
    assert.equal((await f.call()).data.termId,null);
  });
}
