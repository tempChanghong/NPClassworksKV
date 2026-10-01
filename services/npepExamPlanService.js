import {randomUUID} from 'node:crypto';
import {fail,digest,displayText} from '../domain/npep/wire.js';
import {identityOf,requireSame} from '../domain/npep/runtimeControl.js';
import {planDigest,finalPlan,planView} from '../domain/npep/examPlans.js';
import {examPlanRepository} from './npepExamPlanRepository.js';

export function createNpepExamPlanService(service,repo=examPlanRepository) {
  const now=()=>new Date().toISOString();
  const claimsOf=c=>({accountId:c.accountId,sessionId:c.sessionId,tokenVersion:c.tokenVersion,exp:c.exp});
  const admin=(c,s,id,work)=>service.withRuntimeAdmin(c,s,id,work);
  const device=(auth,work,initiator)=>service.withRuntimeDevice(auth,work,initiator);
  async function context(tx,d,c) {
    requireSame(c.identity,identityOf(d),'AUTH_INVALID');
    const receipt=await tx.npepSessionReceipt.findUnique({where:{sessionId:c.sessionId}});
    if(!receipt||receipt.deviceId!==d.id||receipt.runId!==c.runId||receipt.statusEpoch!==c.statusEpoch||d.sessionId!==c.sessionId||d.statusEpoch!==c.statusEpoch) fail(409,'SESSION_SUPERSEDED');
  }
  const online=(p,d)=>!!p && p.context.sessionId===d.sessionId && p.context.statusEpoch===d.statusEpoch && Date.now()-Date.parse(p.receivedAt)<45000;
  async function get(tx,d,id) {
    const op=await repo.get(tx,id);
    if(!op||op.view.context.identity.deviceId!==d.id) fail(404,'NOT_FOUND');
    requireSame(op.view.context.identity,identityOf(d),'AUTH_INVALID'); return op;
  }
  async function clean(tx,d) {
    const list=await repo.list(tx,d.id), p=await repo.status(tx,d.id);
    for(const op of list) {
      if(finalPlan(op.view)) continue;
      if(Date.parse(op.view.grant?.startNotAfter??op.view.expiresAt)<=Date.now() ||
        !p || !p.status.enabled || digest(p.context)!==digest(op.view.context) ||
        p.status.consentId!==op.view.consentId || p.status.policyRevision!==op.view.policyRevision || p.status.revision!==op.view.revision) {
        Object.assign(op.view,{state:op.view.grant?'UNKNOWN':'EXPIRED',reasonCode:op.view.grant?'UNKNOWN_RESULT':'STATE_CHANGED',dataBase64:null});
        await repo.save(tx,op);
      }
    }
    return list;
  }
  async function ready(tx,d,expected,starting=false) {
    const p=await repo.status(tx,d.id);
    if(!online(p,d)) fail(409,'DEVICE_OFFLINE');
    if(!p.status.enabled) fail(409,'CONTROL_DISABLED');
    if(!p.status.available) fail(409,p.status.blockReason||'OPERATION_BUSY');
    await context(tx,d,p.context);
    requireSame([p.context,p.status.consentId,p.status.policyRevision,p.status.revision],
      [expected.context,expected.consentId,expected.policyRevision,expected.revision],'STATE_CHANGED');
    if(starting) {
      if(!p.status.player?.known) fail(409,'PLAYER_UNKNOWN');
      if(p.status.player.sessions.length) fail(409,'PLAYER_BUSY');
      if(p.status.preparedId!==expected.summary?.preparationId) fail(409,'PLAN_EXPIRED');
    }
    return p;
  }
  return {
    report:(auth,b)=>device(auth,async(tx,d)=>{
      await context(tx,d,b.context);
      const previous=await repo.status(tx,d.id);
      if(previous && b.status.policyRevision<previous.status.policyRevision) fail(409,'POLICY_STALE');
      if(previous && digest(previous.context)===digest(b.context)) {
        if(b.sequence<previous.sequence || b.sequence===previous.sequence&&digest(b)!==previous.digest) fail(409,'SEQUENCE_CONFLICT');
        if(b.sequence===previous.sequence) return {accepted:true};
      }
      await repo.saveStatus(tx,d.id,{context:b.context,status:b.status,sequence:b.sequence,digest:digest(b),receivedAt:now()});
      await clean(tx,d); return {accepted:true};
    }),
    management:(c,s,id)=>admin(c,s,id,async(tx,d)=>{
      const p=await repo.status(tx,id), list=await clean(tx,d);
      // Only the latest summary is needed for confirmation. Bound the whole response to 64 KiB.
      return {context:p?.context??null,status:p?.status??null,receivedAt:p?.receivedAt??null,online:online(p,d),items:list.map((o,i)=>({...planView(o.view),summary:i===0?o.view.summary:null}))};
    }),
    create:(c,s,id,b)=>admin(c,s,id,async(tx,d)=>{
      const existing=await repo.byRequest(tx,id,b.requestId);
      if(existing) { requireSame([existing.createDigest,existing.claims.accountId,existing.claims.sessionId],[digest(b),c.accountId,c.sessionId],'IDEMPOTENCY_CONFLICT'); return {created:false,data:planView(existing.view)}; }
      const sha256=planDigest(b.dataBase64);
      await ready(tx,d,b);
      if((await clean(tx,d)).some(o=>!finalPlan(o.view))) fail(409,'OPERATION_BUSY');
      const view={operationId:randomUUID(),requestId:b.requestId,context:b.context,consentId:b.consentId,policyRevision:b.policyRevision,
        revision:b.revision,fileName:displayText(b.fileName,160),sha256,dataBase64:b.dataBase64,createdAt:now(),expiresAt:new Date(Date.now()+300000).toISOString(),
        state:'QUEUED',summary:null,sessionId:null,reasonCode:null,grant:null};
      await repo.save(tx,{view,claims:claimsOf(c),createDigest:digest(b),prepareResult:null,startResult:null,startRequest:null});
      return {created:true,data:planView(view)};
    }),
    start:(c,s,id,opId,b)=>admin(c,s,id,async(tx,d)=>{
      await clean(tx,d); const op=await get(tx,d,opId);
      if(op.startRequest) {
        requireSame([op.startRequest.body,op.startRequest.claims.accountId,op.startRequest.claims.sessionId,op.startRequest.claims.tokenVersion],
          [b,c.accountId,c.sessionId,c.tokenVersion],'IDEMPOTENCY_CONFLICT');
        return planView(op.view);
      }
      if(op.view.state!=='PREPARED') fail(409,'STATE_CHANGED');
      requireSame([b.preparationId,b.sha256],[op.view.summary.preparationId,op.view.sha256],'PLAN_EXPIRED');
      await ready(tx,d,op.view,true);
      op.startRequest={body:b,claims:claimsOf(c)}; op.view.state='START_REQUESTED';
      await repo.save(tx,op); return planView(op.view);
    }),
    cancel:(c,s,id,opId)=>admin(c,s,id,async(tx,d)=>{
      const op=await get(tx,d,opId);
      if(op.view.grant) fail(409,'START_ALREADY_AUTHORIZED');
      if(!finalPlan(op.view)) { Object.assign(op.view,{state:'CANCELLED',dataBase64:null}); await repo.save(tx,op); }
      return planView(op.view);
    }),
    poll:(auth)=>device(auth,async(tx,d)=>({item:(await clean(tx,d)).find(o=>!finalPlan(o.view))?.view??null})),
    grant:(auth,id,b)=>device(auth,async(tx,d)=>{
      await context(tx,d,b.context); await clean(tx,d);
      const op=await get(tx,d,id);
      if(!['START_REQUESTED','START_AUTHORIZED'].includes(op.view.state)) fail(409,'STATE_CHANGED');
      requireSame(b.context,op.view.context,'STATE_CHANGED'); await ready(tx,d,op.view,true);
      op.view.grant??={grantId:randomUUID(),operationId:id,startNotAfter:new Date(Math.min(Date.parse(op.view.expiresAt),Date.now()+30000)).toISOString()};
      op.view.state='START_AUTHORIZED'; await repo.save(tx,op);
      return {grant:op.view.grant,serverTime:now()};
    },async(tx,d)=>{ const op=await get(tx,d,id); return op.startRequest?.claims??op.claims; }),
    result:(auth,id,b)=>device(auth,async(tx,d)=>{
      await context(tx,d,b.context);
      const op=await get(tx,d,id); requireSame(b.context,op.view.context,'STATE_CHANGED');
      const key=b.stage==='prepare'?'prepareResult':'startResult', canonical={...b,requestId:null};
      if(op[key]) { requireSame(op[key],canonical,'IDEMPOTENCY_CONFLICT'); return {accepted:true}; }
      if(finalPlan(op.view)) fail(409,'STATE_CHANGED');
      if(b.stage==='prepare') {
        if(op.view.state!=='QUEUED'||b.grantId!==null||b.sessionId!==null||!['PREPARED','FAILED','UNKNOWN'].includes(b.state)) fail(409,'INVALID_TRANSITION');
        if(b.state==='PREPARED') {
          if(!b.summary||b.summary.sha256!==op.view.sha256||!b.summary.exams.length||b.reasonCode!==null ||
            b.summary.examName.length+b.summary.message.length+b.summary.exams.reduce((n,e)=>n+e.name.length+e.start.length+e.end.length,0)>6000) fail(409,'INVALID_TRANSITION');
        } else if(b.summary!==null) fail(409,'INVALID_TRANSITION');
      } else {
        if(!['START_REQUESTED','START_AUTHORIZED'].includes(op.view.state)||b.summary!==null||!['STARTED','FAILED','UNKNOWN'].includes(b.state)) fail(409,'INVALID_TRANSITION');
        if(b.state==='STARTED' && (!op.view.grant||b.grantId!==op.view.grant.grantId||!b.sessionId||b.reasonCode!==null)) fail(409,'INVALID_TRANSITION');
        if(b.grantId!==null && b.grantId!==op.view.grant?.grantId) fail(409,'INVALID_TRANSITION');
      }
      op[key]=canonical;
      Object.assign(op.view,{state:b.state,reasonCode:b.reasonCode,summary:b.summary??op.view.summary,sessionId:b.sessionId,dataBase64:null});
      await repo.save(tx,op); return {accepted:true};
    }),
  };
}
