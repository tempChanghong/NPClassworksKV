import {randomUUID} from 'node:crypto';
import Ajv from 'ajv';
import schema from '../domain/npep/study-photos.schema.json' with {type:'json'};
import {digest,fail,UUID,OPAQUE_ID} from '../domain/npep/wire.js';
import {identityOf,requireSame} from '../domain/npep/runtimeControl.js';
const validate=new Ajv({strict:true}).compile({definitions:schema.definitions,$ref:'#/definitions/exitRequest'});
export const exitRepository={
  async event(tx,id){return(await tx.$queryRaw`SELECT * FROM "NpepStudyExitEvent" WHERE "eventId"=${id}::uuid FOR UPDATE`)[0];},
  async save(tx,r){await tx.$executeRaw`INSERT INTO "NpepStudyExitEvent" ("eventId","deviceId","schoolId","termId","classId",digest,metadata,"createdAt","expiresAt")
    VALUES (${r.eventId}::uuid,${r.deviceId}::uuid,${r.schoolId},${r.termId},${r.classId},${r.digest},${JSON.stringify(r.metadata)}::jsonb,${r.createdAt},${r.expiresAt})`;},
  async list(tx,school,term,classroom,before){return tx.$queryRaw`SELECT e.*,
    CASE WHEN p.state='Stored' AND p."expiresAt">clock_timestamp() THEN 'Stored' ELSE 'Unavailable' END AS "photoState"
    FROM "NpepStudyExitEvent" e LEFT JOIN "NpepStudyPhoto" p ON p."eventId"=e."eventId" AND p."deviceId"=e."deviceId"
    AND p."classId"=e."classId" AND p."schoolId"=e."schoolId"
    WHERE e."schoolId"=${school} AND e."termId"=${term} AND e."classId"=${classroom} AND e."expiresAt">clock_timestamp()
    AND (e."createdAt",e."eventId")<(${before.at},${before.id}::uuid) ORDER BY e."createdAt" DESC,e."eventId" DESC LIMIT 31`;},
};
export function createNpepStudyExitService(base,study,{exitRepo=exitRepository,clock=()=>Date.now()}={}) {
  return {
    store:(auth,body)=>base.withRuntimeDevice(auth,async(tx,device)=>{
      if(!validate(body))fail(400,'INVALID_REQUEST');requireSame(body.context.identity,identityOf(device),'BINDING_CHANGED');
      const session=await tx.npepSessionReceipt.findUnique({where:{sessionId:body.context.sessionId}});
      if(!session || session.deviceId!==device.id || session.runId!==body.context.runId || session.statusEpoch!==body.context.statusEpoch
        || new Date(session.expiresAt).getTime()<=clock() || device.sessionId!==body.context.sessionId || device.statusEpoch!==body.context.statusEpoch)fail(409,'SESSION_SUPERSEDED');
      const m=body.event;
      const stamp=v=>typeof v==='string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString()===v;
      if(!stamp(m.deviceTime) || !stamp(m.schoolNow+'Z') || m.photoEventId!==null && m.photoEventId!==m.eventId)fail(400,'INVALID_REQUEST');
      const config=await study.configurationForDevice(tx,device);
      if(!config.effective.settings?.noise.enabled)fail(409,'EXIT_NOT_ELIGIBLE');
      requireSame(m.version,config.version,'POLICY_CHANGED');
      const old=await exitRepo.event(tx,m.eventId),fingerprint=digest(m);
      if(old){requireSame([old.deviceId,old.digest],[device.id,fingerprint],'IDEMPOTENCY_CONFLICT');return{eventId:m.eventId,state:'Stored'};}
      // deviceTime/schoolNow are diagnostic observations, never the trusted retention clock.
      const createdAt=new Date(clock()),days=Math.min(180,config.effective.settings.photos.retentionDays);
      await exitRepo.save(tx,{eventId:m.eventId,deviceId:device.id,...config.scope,digest:fingerprint,metadata:m,createdAt,expiresAt:new Date(createdAt.getTime()+days*86400000)});
      await tx.npepAudit.create({data:{id:randomUUID(),schoolId:device.schoolId,action:m.reason==='ProcessRecovery'?'STUDY_PROCESS_RECOVERED':'STUDY_EXIT_VERIFICATION_FAILED',objectId:m.eventId}});
      return{eventId:m.eventId,state:'Stored'};
    }),
    list:(claims,school,term,classroom,cursor=null)=>base.withScheduleAdmin(claims,school,async tx=>{
      if(!OPAQUE_ID.test(term||'') || !OPAQUE_ID.test(classroom||''))fail(400,'INVALID_REQUEST');
      const c=await tx.workspace.findUnique({where:{id:classroom}}),t=await tx.academicTerm.findUnique({where:{id:term}});
      if(c?.termId!==term || t?.schoolId!==school)fail(404,'NOT_FOUND');
      let before={at:new Date('9999-01-01T00:00:00.000Z'),id:'ffffffff-ffff-ffff-ffff-ffffffffffff'};
      if(cursor){if(typeof cursor!=='string'||cursor.length>256||!/^[A-Za-z0-9_-]+$/.test(cursor))fail(400,'INVALID_REQUEST');
        try{before=JSON.parse(Buffer.from(cursor,'base64url').toString());}catch{fail(400,'INVALID_REQUEST');}
        if(!UUID.test(before?.id||'') || !Number.isFinite(Date.parse(before?.at)))fail(400,'INVALID_REQUEST');before.at=new Date(before.at);}
      const rows=await exitRepo.list(tx,school,term,classroom,before),next=rows.length>30?rows[29]:null;
      await tx.npepAudit.create({data:{id:randomUUID(),schoolId:school,actorId:claims.accountId,action:'STUDY_EXIT_EVENT_LIST',objectId:classroom}});
      return{items:rows.slice(0,30).map(r=>({eventId:r.eventId,classId:r.classId,reason:r.metadata.reason,schoolNow:r.metadata.schoolNow,
        createdAt:new Date(r.createdAt).toISOString(),photoEventId:r.metadata.photoEventId,photoState:r.photoState})),
        cursor:next?Buffer.from(JSON.stringify({at:new Date(next.createdAt).toISOString(),id:next.eventId})).toString('base64url'):null};
    }),
  };
}
