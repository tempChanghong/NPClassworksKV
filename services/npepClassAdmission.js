import {randomUUID, randomInt} from 'node:crypto';
import {fail, digest, secretHash, displayText, capabilities} from '../domain/npep/wire.js';
import {schoolManagementRepository} from './npepSchoolManagementService.js';
import {managementRequestDigest, verifyManagementSecret} from '../domain/npep/schoolManagement.js';

export function createClassAdmission({transaction,schoolLock,binding,available,audit,pairValid,management=schoolManagementRepository}) {
  const response = p => ({created:false,data:{pairingId:p.id,userCode:p.userCode,state:'PENDING',expiresAt:p.expiresAt.toISOString(),pollAfterSeconds:5}});
  return {
    classCatalogue: () => transaction(async(tx,config)=>{
      const screens=await tx.classroomScreenBinding.findMany({where:{isActive:true,administrativeClass:{isActive:true,type:'ADMIN_CLASS',term:{status:'ACTIVE'}}},include:{school:true,administrativeClass:{include:{grade:true}}},orderBy:{id:'asc'},take:201});
      return {...config,items:screens.slice(0,200).map(b=>({screenBindingId:b.id,schoolId:b.schoolId,schoolName:displayText(b.school.name),classId:b.administrativeClassId,className:displayText(b.administrativeClass.name),gradeName:displayText(b.administrativeClass.grade?.name ?? ''),screenName:displayText(b.name),preauthorized:b.npepPairingEnabled})),truncated:screens.length>200};
    }),
    createClassPairing: (body,password) => transaction(async(tx,config)=>{
      if(body.serverInstanceId!==config.serverInstanceId||body.deploymentEpoch!==config.deploymentEpoch)fail(409,'INSTANCE_MISMATCH');
      const initial=await tx.classroomScreenBinding.findUnique({where:{id:body.screenBindingId}});
      if(!initial)fail(404,'NOT_FOUND');
      await schoolLock(tx,initial.schoolId);const b=await binding(tx,initial.id,initial.schoolId);
      const credential=await management.credential(tx,b.schoolId,b.administrativeClassId);
      if(password && (!b.npepPairingEnabled||!verifyManagementSecret(body.secret,credential?.verifier)))fail(403,'MANAGEMENT_SECRET_INVALID');
      const fingerprint=managementRequestDigest({...body,secret:password?body.secret:null});
      const previous=await tx.npepPairing.findUnique({where:{installationId_requestId:{installationId:body.installationId,requestId:body.requestId}}});
      if(previous){pairValid(previous,config);if(previous.createDigest!==fingerprint)fail(409,'IDEMPOTENCY_CONFLICT');return response(previous);}
      await available(tx,b.id);await tx.$queryRaw`SELECT pg_advisory_xact_lock(781001)::text`;
      if(await tx.npepPairing.count({where:{expiresAt:{gt:new Date()},state:{in:['PENDING','APPROVED']}}})>=10000)fail(429,'RATE_LIMITED');
      const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let userCode;
      do{userCode=Array.from({length:8},()=>alphabet[randomInt(alphabet.length)]).join('');}while(await tx.npepPairing.findUnique({where:{userCode}}));
      const snapshot={schoolId:b.schoolId,schoolName:displayText(b.school.name),administrativeClassId:b.administrativeClassId,administrativeClassName:displayText(b.administrativeClass.name),screenBindingId:b.id,screenBindingName:displayText(b.name),bindingRevision:b.npepBindingRevision,capabilities};
      const pair=await tx.npepPairing.create({data:{id:randomUUID(),installationId:body.installationId,requestId:body.requestId,createDigest:fingerprint,secretHash:secretHash(body.pairingSecret),userCode,deviceName:displayText(body.deviceName,64),appVersion:displayText(body.appVersion,64),...config,schoolId:b.schoolId,screenBindingId:b.id,expiresAt:new Date(Date.now()+600000),state:password?'APPROVED':'PENDING',approvalSource:password?'CLASS_PASSWORD':'CLASS_APPLY',approvalId:password?randomUUID():null,preauthorizationRevision:password?b.npepPairingRevision:null,screenCredentialVersion:password?b.credentialVersion:null,approvalSnapshot:password?{...snapshot,managementRevision:credential.revision}:{requestedBindingId:b.id}}});
      await audit(tx,password?'CLASS_PASSWORD_PAIRING':'CLASS_PAIRING_REQUESTED',pair.id,b.schoolId);return {...response(pair),created:true};
    }),
  };
}
