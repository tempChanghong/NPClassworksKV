import {randomUUID} from 'node:crypto';
import {digest, fail} from '../domain/npep/wire.js';
import {identityOf, requireSame} from '../domain/npep/runtimeControl.js';
import {resolvePolicy, validatePolicy} from '../domain/npep/noiseScheduleRules.js';
import {noiseScheduleRepository as policies} from './npepNoiseScheduleRepository.js';

export const noiseScheduleRuntimeRepository = {
  async read(tx,id) {
    const rows=await tx.$queryRaw`SELECT data FROM "NpepNoiseScheduleDevice" WHERE "deviceId"=${id}::uuid`;
    return rows[0]?.data ?? {commands:[],sessions:[],status:null};
  },
  async save(tx,id,data) {
    await tx.$executeRaw`INSERT INTO "NpepNoiseScheduleDevice" ("deviceId",data) VALUES (${id}::uuid,${JSON.stringify(data)}::jsonb)
      ON CONFLICT ("deviceId") DO UPDATE SET data=EXCLUDED.data`;
  },
  async policy(tx,d) {
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${d.administrativeClassId} FOR SHARE`;
    const c=await tx.workspace.findUnique({where:{id:d.administrativeClassId}});
    if (!c?.isActive || c.type!=='ADMIN_CLASS') fail(409,'BINDING_CHANGED');
    const term=await tx.academicTerm.findUnique({where:{id:c.termId}});
    if (term?.schoolId!==d.schoolId || term.status!=='ACTIVE') fail(409,'BINDING_CHANGED');
    if (c.gradeId) {
      await tx.$queryRaw`SELECT id FROM "Grade" WHERE id=${c.gradeId} FOR SHARE`;
      const g=await tx.grade.findUnique({where:{id:c.gradeId}});
      if (g?.termId!==c.termId) fail(409,'BINDING_CHANGED');
    }
    const rows=await policies.policies(tx,d.schoolId,c.termId);
    const grade=rows.find(p=>p.targetType==='GRADE'&&p.targetId===c.gradeId);
    const local=rows.find(p=>p.targetType==='CLASS'&&p.targetId===c.id);
    if (validatePolicy(grade?.policy??null,true) || validatePolicy(local?.policy??null)) fail(503,'INVALID_SCHEDULE_POLICY');
    const effective=resolvePolicy(grade?.policy??null,local?.policy??null);
    return {...effective,version:digest({identity:identityOf(d),term:c.termId,classId:c.id,gradeId:c.gradeId,
      gradeRevision:grade?.revision??0,classRevision:local?.revision??0,effective})};
  },
};

export function createNpepNoiseScheduleRuntime(base,repo=noiseScheduleRuntimeRepository) {
  const fresh=(a,d)=>!!a.status && a.context?.sessionId===d.sessionId && a.context?.statusEpoch===d.statusEpoch &&
    digest(a.context.identity)===digest(identityOf(d)) && Date.now()-Date.parse(a.receivedAt)<15000;
  function clean(a) {
    for (const c of a.commands) if (!c.receipt && Date.parse(c.expiresAt)<=Date.now()) c.receipt={commandId:c.command.commandId,outcome:'UNKNOWN'};
    a.commands=a.commands.slice(-32);
    a.sessions=a.sessions.filter(s=>Date.now()-Date.parse(s.receivedAt)<30*86400000).slice(-200);
  }
  async function view(tx,d) {
    if (!d) return {supported:false,online:false,applied:false,policy:null,status:null,receivedAt:null,commands:[],sessions:[]};
    const a=await repo.read(tx,d.id), policy=await repo.policy(tx,d); clean(a);
    await repo.save(tx,d.id,a);
    const online=fresh(a,d), applied=online&&a.status.version===policy.version;
    return {supported:!!a.status,online,applied,policy,status:a.status,receivedAt:a.receivedAt??null,commands:a.commands.slice(-5),sessions:a.sessions};
  }
  return {
    screen:token=>base.withNoiseScreen(token,view),
    management:(claims,school,id)=>base.withRuntimeAdmin(claims,school,id,view),
    resume:(token,b)=>base.withNoiseScreen(token,async(tx,d)=>{
      if (!d) fail(409,'NO_NATIVE_DEVICE');
      const a=await repo.read(tx,d.id); clean(a);
      const old=a.commands.find(c=>c.requestId===b.requestId);
      if (old) {requireSame(old.digest,digest(b),'IDEMPOTENCY_CONFLICT');return old;}
      if (!fresh(a,d)) fail(409,'DEVICE_OFFLINE');
      const p=await repo.policy(tx,d);
      requireSame(b.version,p.version,'SCHEDULE_VERSION_CONFLICT');
      requireSame(b.version,a.status.version,'STATE_CHANGED'); requireSame(b.window,a.status.window,'STATE_CHANGED');
      if (!['WINDOW_SKIPPED','WINDOW_FAILED','SCHOOL_CLOCK_UNAVAILABLE'].includes(a.status.reason)) fail(409,'STATE_CHANGED');
      if (a.commands.some(c=>!c.receipt)) fail(409,'COMMAND_PENDING');
      const record={requestId:b.requestId,digest:digest(b),context:a.context,expiresAt:new Date(Date.now()+30000).toISOString(),
        command:{commandId:randomUUID(),version:b.version,window:b.window},receipt:null};
      a.commands.push(record); await repo.save(tx,d.id,a); return record;
    }),
    exchange:(auth,b)=>base.withRuntimeDevice(auth,async(tx,d)=>{
      requireSame(b.context.identity,identityOf(d),'AUTH_INVALID');
      const session=await tx.npepSessionReceipt.findUnique({where:{sessionId:b.context.sessionId}});
      if (!session || session.deviceId!==d.id || session.runId!==b.context.runId || session.statusEpoch!==b.context.statusEpoch ||
          d.sessionId!==b.context.sessionId || d.statusEpoch!==b.context.statusEpoch) fail(409,'SESSION_SUPERSEDED');
      const a=await repo.read(tx,d.id); clean(a);
      if (a.context && digest(a.context)===digest(b.context) && b.sequence<=a.sequence) {
        if (b.sequence!==a.sequence || a.digest!==digest(b)) fail(409,'SEQUENCE_CONFLICT');
        return {...a.reply,confirmed:false,command:null}; // Replay is not a fresh lease confirmation.
      }
      for (const c of a.commands) {
        if (!c.receipt && digest(c.context)!==digest(b.context)) c.receipt={commandId:c.command.commandId,outcome:'UNKNOWN'};
        if (b.status.receipt?.commandId===c.command.commandId && digest(c.context)===digest(b.context)) {
          if (c.receipt && c.receipt.outcome!=='UNKNOWN') requireSame(c.receipt,b.status.receipt,'IDEMPOTENCY_CONFLICT');
          c.receipt=b.status.receipt;
        }
      }
      if (b.status.owner==='Schedule' && b.status.sessionId && b.status.window && !a.sessions.some(s=>s.sessionId===b.status.sessionId))
        a.sessions.push({sessionId:b.status.sessionId,window:b.status.window,version:b.status.version,receivedAt:new Date().toISOString()});
      const policy=await repo.policy(tx,d);
      Object.assign(a,{context:b.context,sequence:b.sequence,digest:digest(b),status:b.status,receivedAt:new Date().toISOString()});
      if (b.status.reason === 'EXAM_PAUSED')
        await tx.npepNoiseDisplayReturn.deleteMany({where:{screenBindingId:d.screenBindingId}});
      clean(a);
      a.reply={policy,leaseSeconds:86400,confirmed:true,command:a.commands.find(c=>!c.receipt)?.command??null};
      await repo.save(tx,d.id,a); return a.reply;
    }),
  };
}
