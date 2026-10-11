import {randomUUID} from 'node:crypto';
import {fail, digest, UUID} from '../domain/npep/wire.js';
import {managementVerifier, managementRequestDigest, managementWriteValid, equipmentWriteValid} from '../domain/npep/schoolManagement.js';

export const schoolManagementRepository = {
  async binding(tx, schoolId, id) {
    const initial = await tx.classroomScreenBinding.findUnique({where:{id},include:{administrativeClass:true}});
    if (!initial || initial.schoolId !== schoolId || !initial.administrativeClass?.termId) fail(404,'NOT_FOUND');
    await tx.$queryRaw`SELECT id FROM "AcademicTerm" WHERE id=${initial.administrativeClass.termId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${initial.administrativeClassId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "ClassroomScreenBinding" WHERE id=${id} FOR UPDATE`;
    const b = await tx.classroomScreenBinding.findUnique({where:{id},include:{administrativeClass:{include:{term:true}}}});
    if (!b?.isActive || b.schoolId !== schoolId || !b.administrativeClass?.isActive || b.administrativeClass.type !== 'ADMIN_CLASS' || b.administrativeClass.term?.status !== 'ACTIVE' || b.administrativeClass.term.schoolId !== schoolId || b.administrativeClassId !== initial.administrativeClassId || b.administrativeClass.termId !== initial.administrativeClass.termId) fail(409,'BINDING_CHANGED');
    return b;
  },
  async credential(tx, schoolId, classId) {
    return (await tx.$queryRaw`SELECT revision::float8 AS revision, verifier, "updatedAt" FROM "NpepClassManagement" WHERE "schoolId"=${schoolId} AND "classId"=${classId}`)[0] ?? null;
  },
  async saveCredential(tx, schoolId, classId, row) {
    await tx.$executeRaw`INSERT INTO "NpepClassManagement" ("schoolId","classId",revision,verifier,"updatedAt") VALUES (${schoolId},${classId},${row.revision},${JSON.stringify(row.verifier)}::jsonb,${new Date(row.updatedAt)}) ON CONFLICT ("schoolId","classId") DO UPDATE SET revision=EXCLUDED.revision,verifier=EXCLUDED.verifier,"updatedAt"=EXCLUDED."updatedAt"`;
  },
  async request(tx, schoolId, id) { return (await tx.$queryRaw`SELECT data FROM "NpepManagementRequest" WHERE "schoolId"=${schoolId} AND "requestId"=${id}::uuid`)[0]?.data ?? null; },
  async saveRequest(tx, schoolId, id, data) { await tx.$executeRaw`INSERT INTO "NpepManagementRequest" ("schoolId","requestId",data) VALUES (${schoolId},${id}::uuid,${JSON.stringify(data)}::jsonb)`; },
  async equipment(tx, deviceId) { return (await tx.$queryRaw`SELECT data FROM "NpepEquipmentPolicy" WHERE "deviceId"=${deviceId}::uuid`)[0]?.data ?? {revision:0,microphoneId:null,cameraId:null,locked:false}; },
  async saveEquipment(tx, deviceId, data) { await tx.$executeRaw`INSERT INTO "NpepEquipmentPolicy" ("deviceId",data) VALUES (${deviceId}::uuid,${JSON.stringify(data)}::jsonb) ON CONFLICT ("deviceId") DO UPDATE SET data=EXCLUDED.data`; },
  async inventory(tx, deviceId) { return (await tx.$queryRaw`SELECT data FROM "NpepEquipmentInventory" WHERE "deviceId"=${deviceId}::uuid`)[0]?.data ?? null; },
  async saveInventory(tx, deviceId, data) { await tx.$executeRaw`INSERT INTO "NpepEquipmentInventory" ("deviceId",data) VALUES (${deviceId}::uuid,${JSON.stringify(data)}::jsonb) ON CONFLICT ("deviceId") DO UPDATE SET data=EXCLUDED.data`; },
};

export function createSchoolManagementService(base, repo=schoolManagementRepository) {
  const publicCredential = row => ({configured:!!row,revision:row?.revision ?? 0,updatedAt:row?.updatedAt ?? null});
  async function audit(tx, schoolId, actorId, action, objectId) { await tx.npepAudit.create({data:{id:randomUUID(),schoolId,actorId,action,objectId}}); }
  return {
    read: (claims,schoolId,bindingId) => base.withScheduleAdmin(claims,schoolId,async tx => {
      const b=await repo.binding(tx,schoolId,bindingId); return {...publicCredential(await repo.credential(tx,schoolId,b.administrativeClassId)),enabled:b.npepPairingEnabled,screenBindingId:b.id,classId:b.administrativeClassId};
    }),
    write: (claims,schoolId,bindingId,body) => {
      if(!managementWriteValid(body))fail(400,'INVALID_REQUEST');
      return base.withScheduleAdmin(claims,schoolId,async tx => {
        const b=await repo.binding(tx,schoolId,bindingId), hash=managementRequestDigest(body);
        const previous=await repo.request(tx,schoolId,body.requestId);
        if(previous){if(previous.digest!==hash || previous.target!==bindingId)fail(409,'IDEMPOTENCY_CONFLICT');return previous.result;}
        const current=await repo.credential(tx,schoolId,b.administrativeClassId);
        if((current?.revision ?? 0)!==body.expectedRevision)fail(409,'REVISION_CONFLICT');
        if(body.enabled && !current && body.secret===null)fail(409,'MANAGEMENT_NOT_CONFIGURED');
        let saved=current;
        if(body.secret!==null){if(body.expectedRevision>=Number.MAX_SAFE_INTEGER)fail(409,'REVISION_CONFLICT');saved={revision:body.expectedRevision+1,verifier:managementVerifier(body.secret),updatedAt:new Date().toISOString()};await repo.saveCredential(tx,schoolId,b.administrativeClassId,saved);}
        if(b.npepPairingRevision>=Number.MAX_SAFE_INTEGER)fail(409,'REVISION_CONFLICT');
        await tx.classroomScreenBinding.update({where:{id:b.id},data:{npepPairingEnabled:body.enabled,npepPairingRevision:{increment:1}}});
        await tx.npepScreenPairingTicket.updateMany({where:{screenBindingId:b.id,state:'READY'},data:{state:'CANCELLED'}});
        const result={...publicCredential(saved),enabled:body.enabled,screenBindingId:b.id,classId:b.administrativeClassId};
        await repo.saveRequest(tx,schoolId,body.requestId,{target:bindingId,digest:hash,result});
        await audit(tx,schoolId,claims.accountId,'CLASS_MANAGEMENT_UPDATED',b.id);return result;
      });
    },
    devicePolicy: auth => base.withRuntimeDevice(auth,async(tx,d)=>({identity:{serverInstanceId:d.serverInstanceId,deploymentEpoch:d.deploymentEpoch,deviceId:d.id,bindingRevision:d.bindingRevision,credentialGeneration:1},credential:await repo.credential(tx,d.schoolId,d.administrativeClassId),equipment:await repo.equipment(tx,d.id)})),
    equipment: (claims,schoolId,deviceId) => base.withRuntimeAdmin(claims,schoolId,deviceId,async(tx,d)=>({policy:await repo.equipment(tx,d.id),inventory:await repo.inventory(tx,d.id)})),
    setEquipment: (claims,schoolId,deviceId,body) => {
      if(!equipmentWriteValid(body))fail(400,'INVALID_REQUEST');
      return base.withRuntimeAdmin(claims,schoolId,deviceId,async(tx,d)=>{
        const hash=digest(body), previous=await repo.request(tx,schoolId,body.requestId);
        if(previous){if(previous.target!==deviceId || previous.digest!==hash)fail(409,'IDEMPOTENCY_CONFLICT');return previous.result;}
        const old=await repo.equipment(tx,d.id), inventory=await repo.inventory(tx,d.id);
        if(old.revision!==body.expectedRevision || old.revision>=Number.MAX_SAFE_INTEGER)fail(409,'REVISION_CONFLICT');
        if(!inventory || !Number.isFinite(Date.parse(inventory.receivedAt)) || Date.now()-Date.parse(inventory.receivedAt)<0 || Date.now()-Date.parse(inventory.receivedAt)>60000)fail(409,'EQUIPMENT_INVENTORY_STALE');
        for(const [key,list] of [['microphoneId','microphones'],['cameraId','cameras']])if(body[key]!==null && !inventory[list].some(x=>x.id===body[key]))fail(409,'EQUIPMENT_UNAVAILABLE');
        const result={revision:old.revision+1,microphoneId:body.microphoneId,cameraId:body.cameraId,locked:body.locked,updatedAt:new Date().toISOString()};
        await repo.saveEquipment(tx,d.id,result);await repo.saveRequest(tx,schoolId,body.requestId,{target:deviceId,digest:hash,result});await audit(tx,schoolId,claims.accountId,'EQUIPMENT_POLICY_UPDATED',d.id);return result;
      });
    },
    observe: (auth,body) => base.withRuntimeDevice(auth,async(tx,d)=>{
      const keys=['requestId','context','sequence','microphones','cameras','unlocked','appliedRevision','credentialRevision','selectedMicrophoneId','selectedCameraId','error'];
      if(!body || Object.keys(body).some(k=>!keys.includes(k)) || !UUID.test(body.requestId ?? '') || !UUID.test(body.context?.sessionId ?? '') || !UUID.test(body.context?.runId ?? '') || !Number.isSafeInteger(body.context?.statusEpoch) || body.context.statusEpoch < 1 || Object.keys(body.context).some(k=>!['identity','sessionId','runId','statusEpoch'].includes(k)))fail(400,'INVALID_REQUEST');
      if(digest(body.context?.identity)!==digest({serverInstanceId:d.serverInstanceId,deploymentEpoch:d.deploymentEpoch,deviceId:d.id,bindingRevision:d.bindingRevision,credentialGeneration:1}))fail(409,'SESSION_SUPERSEDED');
      const session=await tx.npepSessionReceipt.findUnique({where:{sessionId:body.context?.sessionId}});
      if(!session || session.deviceId!==d.id || d.sessionId!==session.sessionId || d.statusEpoch!==body.context.statusEpoch || session.runId!==body.context.runId || session.statusEpoch!==body.context.statusEpoch || session.expiresAt<=new Date())fail(409,'SESSION_SUPERSEDED');
      if(!Number.isSafeInteger(body.sequence) || body.sequence<=0 || !Array.isArray(body.microphones) || !Array.isArray(body.cameras) || body.microphones.length>128 || body.cameras.length>128)fail(400,'INVALID_REQUEST');
      for(const item of [...body.microphones,...body.cameras])if(!item || typeof item.id!=='string'||item.id.length>2048||!item.id.length||typeof item.name!=='string'||item.name.length>512||!item.name.length||/[\p{Cc}\p{Cf}]/u.test(item.id+item.name)||Object.keys(item).some(k=>!['id','name'].includes(k)))fail(400,'INVALID_REQUEST');
      for(const list of [body.microphones,body.cameras])if(new Set(list.map(x=>x.id)).size!==list.length)fail(400,'INVALID_REQUEST');
      for(const key of ['selectedMicrophoneId','selectedCameraId'])if(body[key]!==null && (typeof body[key]!=='string'||!body[key].length||body[key].length>2048||/[\p{Cc}\p{Cf}]/u.test(body[key])))fail(400,'INVALID_REQUEST');
      if(body.error!==null && (typeof body.error!=='string'||!/^[_A-Z0-9]{1,100}$/.test(body.error)))fail(400,'INVALID_REQUEST');
      const policy=await repo.equipment(tx,d.id), old=await repo.inventory(tx,d.id), same=old?.context?.sessionId===body.context.sessionId;
      if(same && body.sequence<old.sequence)fail(409,'SEQUENCE_CONFLICT');
      if(same && body.sequence===old.sequence){if(old.digest!==digest(body))fail(409,'SEQUENCE_CONFLICT');return {confirmed:true,revision:policy.revision};}
      if(typeof body.unlocked!=='boolean'||!Number.isSafeInteger(body.appliedRevision)||body.appliedRevision<0||!Number.isSafeInteger(body.credentialRevision)||body.credentialRevision<0)fail(400,'INVALID_REQUEST');
      if(body.unlocked && !old?.unlocked)await audit(tx,d.schoolId,null,'EQUIPMENT_LOCALLY_UNLOCKED',d.id);
      await repo.saveInventory(tx,d.id,{...body,digest:digest(body),receivedAt:new Date().toISOString()});return {confirmed:true,revision:policy.revision};
    }),
  };
}
