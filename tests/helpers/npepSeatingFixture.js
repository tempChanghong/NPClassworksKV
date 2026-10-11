import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {pngCrc} from '../../domain/npep/seating.js';
import {createNpepSeatingService} from '../../services/npepSeatingService.js';
import {fail} from '../../domain/npep/wire.js';
export function chunk(type, bytes) { const name = Buffer.from(type); const b = Buffer.alloc(bytes.length + 12); b.writeUInt32BE(bytes.length); name.copy(b,4); bytes.copy(b,8); b.writeUInt32BE(pngCrc(Buffer.concat([name,bytes])),b.length-4); return b; }
export function png(width=2,height=2, extra=0) {
  const header = Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  const pixels=Buffer.alloc((width*4+1)*height+extra); for(let y=0;y<height;y++) pixels.fill(255,y*(width*4+1)+1,(y+1)*(width*4+1));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
export function fixture() {
  const rows=[], receipts=new Map(), audits=[];let role='OWNER';
  const device={id:randomUUID(),schoolId:'school',administrativeClassId:'one',serverInstanceId:randomUUID(),deploymentEpoch:randomUUID(),bindingRevision:1,statusEpoch:1,screenBindingId:'screen',state:'ACTIVE',credentialExpiresAt:new Date(Date.now()+60000),sessionId:randomUUID()};
  const context={identity:{serverInstanceId:device.serverInstanceId,deploymentEpoch:device.deploymentEpoch,deviceId:device.id,bindingRevision:1,credentialGeneration:1},sessionId:device.sessionId,runId:randomUUID(),statusEpoch:1};
  const version='a'.repeat(64), claims={accountId:'admin',sessionId:'admin-session'};
  const applied={context,status:{version,policyState:'APPLIED'},receivedAt:new Date().toISOString()};
  const tx={academicTerm:{findUnique:async q=>q.where.id==='term'?{schoolId:'school',status:'ACTIVE'}:null},workspace:{findUnique:async q=>q.where.id==='one'?{termId:'term',type:'ADMIN_CLASS',isActive:true}:null},
    npepDevice:{findUnique:async()=>device},classroomScreenBinding:{findUnique:async()=>({schoolId:'school',administrativeClassId:'one',npepBindingRevision:1,isActive:true})},
    npepSessionReceipt:{findUnique:async q=>q.where.sessionId===device.sessionId?{...context,deviceId:device.id,expiresAt:new Date(Date.now()+60000)}:null},npepAudit:{create:async q=>audits.push(q.data)},
    $queryRaw:async(strings)=>strings.join('').includes('NpepStudyDevice')?[{data:applied}]:[],
  };
  const base={withScheduleAdmin:async(c,s,work)=>{if(c?.accountId!=='admin')fail(401,'AUTH_INVALID');if(!['OWNER','ADMIN'].includes(role))fail(403,'ADMIN_REQUIRED');if(s!=='school')fail(403,'ADMIN_REQUIRED');return work(tx,{serverInstanceId:device.serverInstanceId,deploymentEpoch:device.deploymentEpoch});},withRuntimeDevice:async(a,work)=>{if(a.id!==device.id)fail(401,'AUTH_INVALID');return work(tx,device);}};
  const config={version,scope:{schoolId:'school',termId:'term',classId:'one',gradeId:null},effective:{settings:{}}};
  const study={configurationForDevice:async()=>config};
  const repo={versions:async()=>[...rows].reverse(),current:async()=>{const r=rows.at(-1);return r?{...r,byteCount:r.imageBytes?.length??null}:null;},request:async(_t,_s,id)=>rows.find(r=>r.requestId===id),
    save:async(_t,_s,actorId,body,row,digest)=>{rows.push({...row,actorId,digest,termId:body.termId,classId:body.classId,requestId:body.requestId});for(const r of rows)if(r.revision<=row.revision-5)r.imageBytes=null;},
    part:async(_t,_s,_term,_c,rev,_hash,index)=>rows.find(r=>r.revision===rev)?.imageBytes?.subarray(index*16384,(index+1)*16384),
    receipts:async()=>[...receipts].map(([deviceId,data])=>({deviceId,data})),receipt:async(_t,id)=>receipts.get(id),saveReceipt:async(_t,d,_s,data)=>receipts.set(d.id,data)};
  return {service:createNpepSeatingService(base,study,repo),base,study,tx,rows,receipts,audits,claims,context,device,version,applied,config,setRole:v=>role=v};
}
