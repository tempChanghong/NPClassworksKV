import {digest, fail} from '../domain/npep/wire.js';
import {identityOf} from '../domain/npep/runtimeControl.js';
import {noiseRepository} from './npepNoiseRepository.js';
import {noiseScheduleRuntimeRepository} from './npepNoiseScheduleRuntime.js';
import {authenticateClassroomScreen, verifyClassroomScreenPin} from './classroomScreenService.js';

export const noiseManagementRepository = {
  async read(tx, id) {
    const rows = await tx.$queryRaw`SELECT data FROM "NpepNoiseManagementDevice" WHERE "deviceId"=${id}::uuid`;
    return rows[0]?.data ?? null;
  },
  async save(tx, id, data) {
    await tx.$executeRaw`INSERT INTO "NpepNoiseManagementDevice" ("deviceId",data) VALUES (${id}::uuid,${JSON.stringify(data)}::jsonb)
      ON CONFLICT ("deviceId") DO UPDATE SET data=EXCLUDED.data`;
  },
};
const recent = value => Number.isFinite(Date.parse(value)) && Date.now() - Date.parse(value) >= 0
  && Date.now() - Date.parse(value) < 15000;

export async function scheduledStopProtected(tx, d, sessionId, management = noiseManagementRepository) {
  const report = await management.read(tx, d.id);
  if (report?.protection?.protected === true && report.protection.sessionId === sessionId
    && report.context?.sessionId === d.sessionId && report.context?.statusEpoch === d.statusEpoch) return true;
  const schedule = await noiseScheduleRuntimeRepository.read(tx, d.id);
  return schedule.status?.owner === 'Schedule' && schedule.status.sessionId === sessionId;
}

export function createNpepNoiseManagementService(base, noise, repository = noiseManagementRepository) {
  async function currentReceipt(tx, d, context) {
    const receipt = await tx.npepSessionReceipt.findUnique({where: {sessionId: context.sessionId}});
    if (!receipt || receipt.deviceId !== d.id || receipt.runId !== context.runId
      || receipt.statusEpoch !== context.statusEpoch || receipt.expiresAt <= new Date()
      || d.sessionId !== context.sessionId || d.statusEpoch !== context.statusEpoch
      || digest(context.identity) !== digest(identityOf(d))) fail(409, 'SESSION_SUPERSEDED');
  }
  return {
    status: (auth, body) => base.withRuntimeDevice(auth, async (tx, d) => {
      await currentReceipt(tx, d, body.context);
      const old = await repository.read(tx, d.id);
      if (old?.requestId === body.requestId) {
        if (old.digest !== digest(body)) fail(409, 'IDEMPOTENCY_CONFLICT');
        return {accepted: true};
      }
      if (old && digest(old.context) === digest(body.context)
        && old.protection?.sessionId === body.protection.sessionId
        && old.protection.revision > body.protection.revision) fail(409, 'STATE_CHANGED');
      if (old && digest(old.context) === digest(body.context)
        && old.protection?.sessionId === body.protection.sessionId
        && old.protection.revision === body.protection.revision
        && old.protection.protected && !body.protection.protected) fail(409, 'STATE_CHANGED');
      const actual = await noiseRepository.read(tx, d.id);
      if (actual.context && digest(actual.context) !== digest(body.context)) fail(409, 'SESSION_SUPERSEDED');
      await repository.save(tx, d.id, {requestId: body.requestId, digest: digest(body), context: body.context,
        protection: body.protection, receivedAt: new Date().toISOString()});
      return {accepted: true};
    }),
    screenStop: async (token, body) => {
      let binding;
      try { binding = await authenticateClassroomScreen(token); }
      catch { fail(401, 'SCREEN_TOKEN_INVALID'); }
      try { await verifyClassroomScreenPin(binding, body.pin); }
      catch (error) {
        if (error.statusCode && error.code) fail(error.statusCode, error.code);
        throw error;
      }
      return noise.create(token, {...body.command, requestId: body.requestId},
        {bindingId: binding.id, credentialVersion: binding.credentialVersion});
    },
    authorize: (auth, body) => base.withRuntimeDevice(auth, async (tx, d) => {
      await currentReceipt(tx, d, body.context);
      const aggregate = await noiseRepository.read(tx, d.id);
      const record = aggregate.commands?.find(c => c.command.commandId === body.commandId);
      const grant = record?.managementGrant;
      const management = await repository.read(tx, d.id);
      const schedule = await noiseScheduleRuntimeRepository.read(tx, d.id);
      const binding = await tx.classroomScreenBinding.findUnique({where: {id: d.screenBindingId}});
      if (!record || !grant || !aggregate.context || !management?.context || record.receipt
        || Date.parse(record.command.expiresAt) <= Date.now()
        || digest(record.context) !== digest(body.context)
        || digest(aggregate.context) !== digest(body.context)
        || digest(management.context) !== digest(body.context)
        || !management.protection?.protected || !recent(management.receivedAt)
        || management.protection.sessionId !== body.sessionId
        || management.protection.instanceId !== body.instanceId
        || management.protection.revision !== body.revision
        || schedule.status?.owner !== 'Schedule' || schedule.status.sessionId !== body.sessionId
        || !['WINDOW_ACTIVE', 'CAPTURE_STARTING'].includes(schedule.status.reason)
        || !recent(schedule.receivedAt)
        || digest(schedule.status.window) !== digest(grant.window)
        || digest(management.protection.window) !== digest(grant.window)
        || grant.bindingId !== d.screenBindingId || grant.credentialVersion !== binding?.credentialVersion
        || grant.instanceId !== body.instanceId || grant.revision !== body.revision
        || grant.sessionId !== body.sessionId || record.command.action !== 'STOP'
        || record.command.instanceId !== body.instanceId || record.command.revision !== body.revision
        || record.command.sessionId !== body.sessionId) fail(403, 'MANAGEMENT_REQUIRED');
      return {authorized: true, commandId: body.commandId, instanceId: body.instanceId,
        revision: body.revision, sessionId: body.sessionId};
    }),
  };
}
