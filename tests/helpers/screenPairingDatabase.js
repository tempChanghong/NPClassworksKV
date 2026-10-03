import assert from 'node:assert/strict';
import {randomUUID, randomBytes} from 'node:crypto';
import {hash} from '../../domain/npep/wire.js';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';

// Real HTTP + real transactions, always inside the disposable integration cluster.
export async function verifyScreenPairingDatabase(t, {fixture, request, prisma, req, identity, activate, directory, origin}) {
  const secret = () => randomBytes(32).toString('base64url');
  async function setup(enabled = true) {
    const f = await fixture(), token = secret();
    await prisma.classroomScreenBinding.update({where:{id:f.binding.id},data:{tokenHash:hash(token)}});
    f.policy = (extra = {}) => request(`/schools/${f.school.id}/screen-bindings/${f.binding.id}/pairing-access`,
      {auth:f.admin,body:req({enabled,expectedRevision:1,...extra})});
    f.screen = body => request('/screen/pairing',{body,headers:{'X-Classworks-Screen-Token':token}});
    if (enabled) assert.equal((await f.policy()).status,200);
    f.claimBody = code => req({...identity,installationId:randomUUID(),deviceName:'网页配对测试',appVersion:'test',pairingSecret:secret(),requestedCapabilities:['device.status'],userCode:code});
    f.claim = body => request('/pairings/claim',{body});
    f.confirm = async (pair, body) => {
      const auth = `npepp1.${pair.data.pairingId}.${body.pairingSecret}`;
      const approval = await request(`/pairings/${pair.data.pairingId}`,{auth});
      const result = await request(`/pairings/${pair.data.pairingId}/confirm`,{auth,body:req({...identity,approvalId:approval.data?.approvalId,credentialId:randomUUID(),deviceSecret:secret()})});
      return {approval,result};
    };
    return f;
  }
  await t.test('Web pairing: disabled by default, isolated screen and school credentials, strict bodies', async () => {
    const f = await setup(false), other = await fixture();
    assert.equal((await f.screen()).data.enabled,false);
    assert.equal((await f.screen(req({}))).error.code,'SCREEN_PAIRING_DISABLED');
    assert.equal((await request('/screen/pairing',{auth:f.admin})).status,401);
    assert.equal((await request(`/schools/${f.school.id}/pairing-access`,{auth:other.admin})).status,403);
    assert.equal((await f.policy({enabled:true})).status,200);
    assert.equal((await f.policy({enabled:true})).error.code,'REVISION_CONFLICT');
    assert.equal((await f.screen(req({screenBindingId:other.binding.id}))).status,400);
    const ticket = await f.screen(req({}));
    assert.equal((await f.claim({...f.claimBody(ticket.data.userCode),schoolId:other.school.id})).status,400);
  });
  await t.test('Web pairing: administrator can log out before claim and confirmation; assignment cannot be changed', async () => {
    const f = await setup(), ticket = await f.screen(req({}));
    const body = f.claimBody(ticket.data.userCode);
    await prisma.accountSession.update({where:{id:f.session.id},data:{revokedAt:new Date()}});
    const pair = await f.claim(body); assert.equal(pair.status,201,pair.error?.code);
    assert.equal((await f.claim(body)).data.pairingId,pair.data.pairingId,'response-loss retry is idempotent');
    assert.equal((await f.claim({...body,deviceName:'changed'})).error.code,'IDEMPOTENCY_CONFLICT');
    assert.equal((await f.claim(f.claimBody(ticket.data.userCode))).error.code,'PAIRING_CODE_UNAVAILABLE');
    const {approval,result} = await f.confirm(pair,body);
    assert.equal(approval.data.state,'APPROVED'); assert.equal(approval.data.screenBindingId,f.binding.id);
    assert.equal(approval.data.administrativeClassId,f.workspace.id);
    assert.equal(result.status,201,result.error?.code);
    assert.equal((await f.screen()).data.occupied,true);
    assert.equal((await f.screen(req({}))).error.code,'BINDING_OCCUPIED');
    assert.equal(await prisma.npepDevice.count({where:{screenBindingId:f.binding.id,state:'ACTIVE'}}),1);
  });
  await t.test('Web pairing: concurrent redemption gives only one claimant the code', async () => {
    const f = await setup(), ticket = await f.screen(req({}));
    const responses = await Promise.all([f.claim(f.claimBody(ticket.data.userCode)),f.claim(f.claimBody(ticket.data.userCode))]);
    assert.deepEqual(responses.map(r=>r.status).sort(),[201,410]);
    assert.equal(await prisma.npepPairing.count({where:{screenBindingId:f.binding.id,approvalSource:'SCREEN'}}),1);
  });
  await t.test('Web pairing: lost issue response is idempotent; replacement and expired codes are unusable', async () => {
    const f = await setup(), issue = req({}), first = await f.screen(issue);
    assert.equal((await f.screen(issue)).data.userCode,first.data.userCode);
    const second = await f.screen(req({}));
    assert.equal((await f.claim(f.claimBody(first.data.userCode))).error.code,'PAIRING_CODE_UNAVAILABLE');
    await prisma.npepScreenPairingTicket.update({where:{userCode:second.data.userCode},data:{expiresAt:new Date(Date.now()-1000)}});
    assert.equal((await f.claim(f.claimBody(second.data.userCode))).status,410);
  });
  await t.test('Web pairing: disabling and re-enabling authorization cannot resurrect unfinished claims', async () => {
    const f = await setup(), ticket = await f.screen(req({})), body = f.claimBody(ticket.data.userCode), pair = await f.claim(body);
    assert.equal(pair.status,201);
    assert.equal((await f.policy({enabled:false,expectedRevision:2})).status,200);
    const auth = `npepp1.${pair.data.pairingId}.${body.pairingSecret}`;
    assert.equal((await request(`/pairings/${pair.data.pairingId}`,{auth})).error.code,'SCREEN_PAIRING_DISABLED');
    assert.equal((await f.policy({enabled:true,expectedRevision:3})).status,200);
    assert.equal((await request(`/pairings/${pair.data.pairingId}`,{auth})).error.code,'PREAUTHORIZATION_CHANGED');
    assert.equal(await prisma.npepDevice.count({where:{screenBindingId:f.binding.id}}),0);
  });
  await t.test('Web pairing: rotated screen login invalidates an already displayed local approval', async () => {
    const f = await setup(), ticket = await f.screen(req({})), body = f.claimBody(ticket.data.userCode), pair = await f.claim(body);
    const auth = `npepp1.${pair.data.pairingId}.${body.pairingSecret}`;
    const approval = await request(`/pairings/${pair.data.pairingId}`,{auth});
    await prisma.classroomScreenBinding.update({where:{id:f.binding.id},data:{tokenHash:hash(secret()),credentialVersion:{increment:1}}});
    const result = await request(`/pairings/${pair.data.pairingId}/confirm`,{auth,body:req({...identity,approvalId:approval.data.approvalId,credentialId:randomUUID(),deviceSecret:secret()})});
    assert.equal(result.error.code,'PREAUTHORIZATION_CHANGED');
    assert.equal((await f.screen()).status,401);
    assert.equal(await prisma.npepDevice.count({where:{screenBindingId:f.binding.id}}),0);
  });
  await t.test('Web pairing: a legacy pairing occupying the screen blocks confirmation without replacing it', async () => {
    const f = await setup(), ticket = await f.screen(req({})), body = f.claimBody(ticket.data.userCode), pair = await f.claim(body);
    const legacy = await activate(f);
    const {result} = await f.confirm(pair,body);
    assert.equal(result.error.code,'BINDING_OCCUPIED');
    assert.equal((await prisma.npepDevice.findFirst({where:{screenBindingId:f.binding.id,state:'ACTIVE'}})).id,legacy.deviceId);
  });
  await t.test('Web pairing: actual .NET client claims, confirms, restarts, reports and revokes', {skip:!process.env.NPEP_N3_ACCEPTANCE_DLL}, async () => {
    const f = await setup(), ticket = await f.screen(req({}));
    const file = join(directory,'screen-pairing-fixture.json');
    await writeFile(file,JSON.stringify({kind:'SCREEN_PAIRING_DISPOSABLE_DATABASE',origin:origin.replace('/api/v2/npep',''),screenBindingId:f.binding.id,userCode:ticket.data.userCode}));
    const child = spawn('dotnet',[process.env.NPEP_N3_ACCEPTANCE_DLL,'--screen-pairing-http',file,join(directory,'desktop-screen-pairing')],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output = ''; child.stdout.on('data',c=>{output+=c;}); child.stderr.on('data',c=>{output+=c;});
    const code = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    assert.equal(code,0,output); assert.match(output,/PASS SCREEN PAIRING/);
    assert.equal(await prisma.npepDevice.count({where:{screenBindingId:f.binding.id,state:'REVOKED'}}),1);
  });
}
