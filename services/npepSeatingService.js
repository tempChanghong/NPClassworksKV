import {randomUUID} from 'node:crypto';
import {digest, fail, OPAQUE_ID, UUID} from '../domain/npep/wire.js';
import {identityOf, requireSame} from '../domain/npep/runtimeControl.js';
import {readSeatingPng} from '../domain/npep/seating.js';
import {studyDeviceRepository} from './npepStudyDeviceService.js';
import {seatingRepository} from './npepSeatingRepository.js';
import {noiseScheduleRepository} from './npepNoiseScheduleRepository.js';
const view = row => ({revision: row?.revision ?? 0, hash: row?.hash ?? null, width: row?.width ?? null,
  height: row?.height ?? null, createdAt: row?.createdAt ? new Date(row.createdAt).toISOString() : null,
  restorable: Boolean(row?.hash && row?.imageBytes),
  source: row?.actorId?.startsWith('device:') ? 'Device' : 'Administrator',
  deviceId: row?.actorId?.startsWith('device:') ? row.actorId.slice(7) : null});
export function createNpepSeatingService(base, study, repo = seatingRepository) {
  async function scope(tx, school, term, classroom) {
    if (!OPAQUE_ID.test(term || '') || !OPAQUE_ID.test(classroom || '')) fail(400, 'INVALID_REQUEST');
    await tx.$queryRaw`SELECT id FROM "AcademicTerm" WHERE id=${term} FOR SHARE`;
    const t = await tx.academicTerm.findUnique({where: {id: term}});
    await tx.$queryRaw`SELECT id FROM "Workspace" WHERE id=${classroom} FOR SHARE`;
    const c = await tx.workspace.findUnique({where: {id: classroom}});
    if (t?.schoolId !== school || c?.termId !== term) fail(404, 'NOT_FOUND');
    if (t.status !== 'ACTIVE' || !c.isActive || c.type !== 'ADMIN_CLASS') fail(409, 'BINDING_CHANGED');
  }
  async function deviceScope(tx, device, body) {
    requireSame(body.context.identity, identityOf(device), 'AUTH_INVALID');
    const session = await tx.npepSessionReceipt.findUnique({where: {sessionId: body.context.sessionId}});
    if (!session || session.deviceId !== device.id || session.runId !== body.context.runId || session.statusEpoch !== body.context.statusEpoch
      || session.expiresAt <= new Date() || device.sessionId !== body.context.sessionId || device.statusEpoch !== body.context.statusEpoch) fail(409, 'SESSION_SUPERSEDED');
    const config = await study.configurationForDevice(tx, device);
    requireSame(body.version, config.version, 'POLICY_CHANGED');
    if (!config.effective.settings) fail(409, 'STUDY_DISABLED');
    const applied = await studyDeviceRepository.receipt(tx, device.id);
    if (!applied || digest(applied.context) !== digest(body.context) || applied.status.version !== body.version
      || applied.status.policyState !== 'APPLIED' || Date.now() - Date.parse(applied.receivedAt) < 0
      || Date.now() - Date.parse(applied.receivedAt) >= 15000) fail(409, 'STUDY_NOT_APPLIED');
    return config.scope;
  }
  async function deviceResult(tx, s, version, row) {
    const classroom = await tx.workspace.findUnique({where: {id: s.classId}});
    return {version, classId: s.classId, className: classroom?.name || s.classId, revision: row?.revision ?? 0, hash: row?.hash ?? null};
  }
  return {
    catalog: (claims, school, term) => base.withScheduleAdmin(claims, school, (tx, config) => noiseScheduleRepository.catalog(tx, school, term, config)),
    list: (claims, school, term, classroom) => base.withScheduleAdmin(claims, school, async (tx, config) => {
      await scope(tx, school, term, classroom);
      const versions = await repo.versions(tx, school, term, classroom), current = versions[0];
      const receipts = await repo.receipts(tx, school, term, classroom);
      const observations = [];
      for (const {deviceId, data} of receipts) {
        const device = await tx.npepDevice.findUnique({where: {id: deviceId}});
        const ctx = data.context;
        const binding = device?.screenBindingId ? await tx.classroomScreenBinding.findUnique({where: {id: device.screenBindingId}}) : null;
        const session = ctx ? await tx.npepSessionReceipt.findUnique({where: {sessionId: ctx.sessionId}}) : null;
        const eligible = binding?.isActive && binding.schoolId === school && binding.administrativeClassId === classroom && binding.npepBindingRevision === device?.bindingRevision && device?.state === 'ACTIVE' && device.schoolId === school && device.administrativeClassId === classroom
          && device.credentialExpiresAt > new Date() && device.serverInstanceId === config.serverInstanceId && device.deploymentEpoch === config.deploymentEpoch
          && ctx && digest(ctx.identity) === digest(identityOf(device)) && device.sessionId === ctx.sessionId && device.statusEpoch === ctx.statusEpoch
          && session?.deviceId === deviceId && session.runId === ctx.runId && session.statusEpoch === ctx.statusEpoch && session.expiresAt > new Date();
        const currentPolicy = eligible ? await study.configurationForDevice(tx, device) : null;
        const recent = stamp => eligible && Date.now() - Date.parse(stamp) >= 0 && Date.now() - Date.parse(stamp) < 15000;
        observations.push({deviceId, revision: data.revision ?? 0, appliedHash: data.appliedHash ?? null, visible: data.visible ?? false,
          renderAgeMs: data.renderAgeMs ?? null, receivedAt: data.receivedAt ?? null, fresh: Boolean(currentPolicy?.version === data.observationVersion && recent(data.receivedAt)),
          current: data.revision === (current?.revision ?? 0) && data.appliedHash === (current?.hash ?? null),
          downloaded: Boolean(currentPolicy?.version === data.downloadedVersion && recent(data.downloadedReceivedAt) && data.downloaded?.hash === current?.hash && data.downloaded?.revision === current?.revision)});
      }
      return {current: view(current), versions: versions.slice(0, 20).map(view), receipts: observations};
    }),
    publish: (claims, school, body) => base.withScheduleAdmin(claims, school, async tx => {
      if (!body || !UUID.test(body.requestId || '') || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0 || body.expectedRevision >= 2147483647
        || !['image', 'restore', 'withdraw'].includes(body.action) || Object.keys(body).some(k => !['requestId', 'termId', 'classId', 'expectedRevision', 'action', 'image', 'restoreRevision'].includes(k))
        || body.action === 'restore' && (!Number.isInteger(body.restoreRevision) || body.restoreRevision < 1) || body.action !== 'image' && body.image !== undefined || body.action !== 'restore' && body.restoreRevision !== undefined) fail(400, 'INVALID_REQUEST');
      await scope(tx, school, body.termId, body.classId);
      const fingerprint = digest(body), old = await repo.request(tx, school, body.requestId);
      if (old) { requireSame([old.actorId, old.digest], [claims.accountId, fingerprint], 'IDEMPOTENCY_CONFLICT'); return view(old); }
      const versions = await repo.versions(tx, school, body.termId, body.classId);
      requireSame(body.expectedRevision, versions[0]?.revision ?? 0, 'SEATING_CHANGED');
      let image = null;
      if (body.action === 'image') image = readSeatingPng(body.image);
      if (body.action === 'restore') { const prior = versions.find(v => v.revision === body.restoreRevision);
        if (!prior?.hash || !prior.imageBytes) fail(409, 'IMAGE_NO_LONGER_RETAINED');
        image = {hash: prior.hash, width: prior.width, height: prior.height, bytes: prior.imageBytes}; }
      const row = {revision: body.expectedRevision + 1, hash: image?.hash ?? null, width: image?.width ?? null,
        height: image?.height ?? null, imageBytes: image?.bytes ?? null, createdAt: new Date()};
      await repo.save(tx, school, claims.accountId, body, row, fingerprint);
      await tx.npepAudit.create({data: {id: randomUUID(), schoolId: school, actorId: claims.accountId, action: "SEATING_PUBLISHED", objectId: body.classId}}); return view(row);
    }),
    preview: (claims, school, term, classroom, revision) => base.withScheduleAdmin(claims, school, async tx => {
      await scope(tx, school, term, classroom);
      const row = (await repo.versions(tx, school, term, classroom)).find(v => v.revision === revision);
      if (!row?.imageBytes) fail(404, 'NOT_FOUND'); return {image: Buffer.from(row.imageBytes).toString('base64'), ...view(row)};
    }),
    uploadStatus: (auth, body) => base.withRuntimeDevice(auth, async (tx, device) => {
      const s = await deviceScope(tx, device, body);
      await scope(tx, s.schoolId, s.termId, s.classId);
      return deviceResult(tx, s, body.version, await repo.current(tx, s.schoolId, s.termId, s.classId));
    }),
    upload: (auth, body) => base.withRuntimeDevice(auth, async (tx, device) => {
      // Both administrator and device transactions already take the same school lock.
      // Class scope is derived only from the current bound device, never from the upload.
      const s = await deviceScope(tx, device, body);
      await scope(tx, s.schoolId, s.termId, s.classId);
      const actor = `device:${device.id}`, fingerprint = digest(body), prior = await repo.request(tx, s.schoolId, body.requestId);
      if (prior) {
        requireSame([prior.actorId, prior.digest, prior.termId, prior.classId], [actor, fingerprint, s.termId, s.classId], 'IDEMPOTENCY_CONFLICT');
        return deviceResult(tx, s, body.version, prior);
      }
      const current = await repo.current(tx, s.schoolId, s.termId, s.classId);
      requireSame(body.expectedRevision, current?.revision ?? 0, 'SEATING_CHANGED');
      const image = readSeatingPng(body.image);
      const row = {revision: body.expectedRevision + 1, hash: image.hash, width: image.width, height: image.height,
        imageBytes: image.bytes, createdAt: new Date()};
      await repo.save(tx, s.schoolId, actor, {...body, termId: s.termId, classId: s.classId}, row, fingerprint);
      await tx.npepAudit.create({data: {id: randomUUID(), schoolId: s.schoolId, actorId: actor, action: 'DEVICE_SEATING_PUBLISHED', objectId: s.classId}});
      return deviceResult(tx, s, body.version, row);
    }),
    manifest: (auth, body) => base.withRuntimeDevice(auth, async (tx, device) => {
      const s = await deviceScope(tx, device, body), row = await repo.current(tx, s.schoolId, s.termId, s.classId);
      const old = await repo.receipt(tx, device.id);
      const data = old && digest(old.context) === digest(body.context) ? {...old} : {context: body.context, cursors: {}};
      data.downloaded = body.downloaded; data.downloadedVersion = body.version; data.downloadedReceivedAt = new Date().toISOString();
      const o = body.observation;
      if (o && (!data.cursors[o.appInstanceId] || o.sequence > data.cursors[o.appInstanceId]) &&
          (Object.hasOwn(data.cursors, o.appInstanceId) || Object.keys(data.cursors).length < 16)) {
        Object.assign(data, o, {observationVersion: body.version, receivedAt: new Date().toISOString()});
        data.cursors = {...data.cursors, [o.appInstanceId]: o.sequence};
      }
      await repo.saveReceipt(tx, device, s, data); // Transfer acknowledgement never refreshes WPF observation time.
      const byteCount = row?.byteCount;
      return {version: body.version, classId: s.classId, revision: row?.revision ?? 0,
        asset: byteCount && row.hash ? {hash: row.hash, width: row.width, height: row.height, byteCount, chunks: Math.ceil(byteCount / 16384)} : null};
    }),
    chunk: (auth, body) => base.withRuntimeDevice(auth, async (tx, device) => {
      const s = await deviceScope(tx, device, body), row = await repo.current(tx, s.schoolId, s.termId, s.classId);
      if (row?.revision !== body.revision || row.hash !== body.hash || !row.byteCount) fail(409, 'SEATING_CHANGED');
      const count = Math.ceil(row.byteCount / 16384);
      if (body.index >= count) fail(400, 'INVALID_REQUEST');
      const bytes = await repo.part(tx, s.schoolId, s.termId, s.classId, row.revision, row.hash, body.index);
      if (!bytes?.length) fail(409, 'SEATING_CHANGED');
      return {revision: row.revision, hash: row.hash, index: body.index, count, data: Buffer.from(bytes).toString('base64')};
    }),
  };
}
