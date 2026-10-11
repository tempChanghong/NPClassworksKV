import {randomUUID} from 'node:crypto';
import {digest, fail, UUID, OPAQUE_ID} from '../domain/npep/wire.js';
import {identityOf, requireSame} from '../domain/npep/runtimeControl.js';
import {studyDeviceRepository} from './npepStudyDeviceService.js';
import {photoRepository} from './npepPhotoRepository.js';
import {sanitizePhoto, NpepPhotoStore} from './npepPhotoStore.js';
import {PHOTO_LIMITS, validatePhotoMetadata, validatePhotoLeaseRequest, jpegDimensions, photoHash} from '../domain/npep/studyPhotos.js';
const fresh = (stamp, now) => Number.isFinite(Date.parse(stamp)) && now - Date.parse(stamp) >= 0 && now - Date.parse(stamp) < 15000;
const view = r => ({eventId: r.eventId, classId: r.classId, capturedAt: new Date(r.capturedAt).toISOString(),
  expiresAt: new Date(r.expiresAt).toISOString(), reason: r.metadata.reason, sessionKind:r.metadata.sessionKind || 'Schedule', unit: r.metadata.unit,
  level: r.metadata.level, high: r.metadata.high, width: r.width, height: r.height, byteCount: r.byteCount});
const configuredQuota = () => {
  const value = process.env.NPEP_PHOTO_SCHOOL_QUOTA_BYTES;
  if (!value) return PHOTO_LIMITS.schoolQuotaBytes;
  const quota = Number(value);
  if (!Number.isSafeInteger(quota) || quota <= 0 || quota > 1024 ** 4) throw new Error('Invalid photo school quota');
  return quota;
};
export function createNpepPhotoService(base, study, {repo = photoRepository, store = new NpepPhotoStore(),
  encode = sanitizePhoto, clock = () => Date.now(), quotaBytes = configuredQuota()} = {}) {
  async function audit(tx, schoolId, actorId, action, objectId) { await tx.npepAudit.create({data: {id: randomUUID(), schoolId, actorId, action, objectId}}); }
  async function photoPolicy(tx, device) {
    const config = await study.configurationForDevice(tx, device);
    if (!config.effective.settings?.photos.enabled) fail(409, 'PHOTOS_DISABLED');
    return config;
  }
  async function eligibleUpload(tx, device, meta) {
    const lease = await repo.lease(tx, meta.leaseId), config = await photoPolicy(tx, device), now = clock();
    if (!lease || lease.deviceId !== device.id || lease.schoolId !== config.scope.schoolId
      || lease.termId !== config.scope.termId || lease.classId !== config.scope.classId) fail(409, 'PHOTO_LEASE_INVALID');
    requireSame(lease.context.identity, identityOf(device), 'BINDING_CHANGED');
    requireSame(meta.version, lease.version, 'POLICY_CHANGED');
    const window = lease.settings.window;
    if((meta.sessionKind || 'Schedule') !== (lease.settings.sessionKind || 'Schedule'))fail(409,'PHOTO_SESSION_CHANGED');
    if(meta.reason==='ProcessRecovery' && meta.sessionKind==='Manual')fail(409,'PHOTO_SESSION_CHANGED');
    if (!window || meta.schoolNow < window.start || meta.schoolNow >= window.end) fail(409, 'PHOTO_OUTSIDE_WINDOW');
    const at = new Date(meta.capturedAt), age = now - at.getTime();
    if (age < 0 || age > PHOTO_LIMITS.maxUploadAgeSeconds * 1000 || at < new Date(lease.createdAt) || at >= new Date(lease.expiresAt)) fail(409, 'PHOTO_TIME_INVALID');
    const high = lease.settings.noise.estimated?.highDbA ?? lease.settings.noise.redLineDbfs;
    const unit = lease.settings.noise.estimated ? 'EstimatedDbA' : 'Dbfs';
    // Local confirmed quick calibration may replace raw thresholds; its effective high is recorded by the device.
    if (unit !== meta.unit || unit === 'EstimatedDbA' && meta.high !== high || meta.continuousSeconds !== lease.settings.noise.highContinuousSeconds) fail(409, 'PHOTO_THRESHOLD_CHANGED');
    if (meta.reason === 'Noise' && (meta.level === null || meta.level < meta.high)) fail(400, 'PHOTO_THRESHOLD_NOT_REACHED');
    if (['ExitAttempt','ProcessRecovery'].includes(meta.reason) && !lease.settings.photos.captureOnExit) fail(409, 'PHOTO_EXIT_DISABLED');
    const expiresAt = new Date(at.getTime() + Math.min(lease.settings.photos.retentionDays, config.effective.settings.photos.retentionDays) * 86400000);
    if (expiresAt.getTime() <= now) fail(410, 'PHOTO_EXPIRED');
    return {lease, config, at, expiresAt};
  }
  return {
    lease: (auth, body) => base.withRuntimeDevice(auth, async (tx, device) => {
      if (!validatePhotoLeaseRequest(body)) fail(400, 'INVALID_REQUEST');
      requireSame(body.context?.identity, identityOf(device), 'AUTH_INVALID');
      const session = await tx.npepSessionReceipt.findUnique({where: {sessionId: body.context.sessionId}});
      if (!session || session.deviceId !== device.id || session.runId !== body.context.runId || session.statusEpoch !== body.context.statusEpoch
        || session.expiresAt <= new Date(clock()) || device.sessionId !== body.context.sessionId || device.statusEpoch !== body.context.statusEpoch) fail(409, 'SESSION_SUPERSEDED');
      const config = await photoPolicy(tx, device); requireSame(body.version, config.version, 'POLICY_CHANGED');
      const receipt = await studyDeviceRepository.receipt(tx, device.id), execution = receipt?.execution, now = clock();
      if(body.manual) {
        const m=body.manual, start=Date.parse(m.startUtc), end=Date.parse(m.endUtc);
        const validStamp=s=>Number.isFinite(Date.parse(s)) && new Date(s).toISOString()===s;
        const wallDelta=Date.parse(m.schoolNow+'Z')-Date.parse(m.window.start+'Z');
        const wallDuration=Date.parse(m.window.end+'Z')-Date.parse(m.window.start+'Z');
        // This is an authenticated native manual declaration, never a scheduled execution receipt.
        if(!config.effective.settings.noise.enabled || !receipt || !fresh(receipt.receivedAt,now) || receipt.status.version!==config.version
          || receipt.status.policyState!=='APPLIED' || digest(receipt.context)!==digest(body.context)
          || ![m.startUtc,m.endUtc,m.schoolNow+'Z',m.window.start+'Z',m.window.end+'Z'].every(validStamp)
          || !(end>start && end-start<=10800000 && start<=now+5000 && end>now)
          || Math.abs(wallDuration-(end-start))>1 || wallDelta<0 || wallDelta>=wallDuration || Math.abs(wallDelta-(now-start))>5000)
          fail(409,'PHOTO_MANUAL_NOT_FRESH');
        const row={id:randomUUID(),deviceId:device.id,...config.scope,version:config.version,context:body.context,
          settings:{...config.effective.settings,noiseSessionId:m.sessionId,sessionKind:'Manual',window:m.window},createdAt:new Date(now),expiresAt:new Date(now+60000)};
        await repo.saveLease(tx,row);return {leaseId:row.id,version:row.version,sessionId:m.sessionId,leaseSeconds:60,createdAt:row.createdAt.toISOString(),expiresAt:row.expiresAt.toISOString(),maxBytes:PHOTO_LIMITS.maxBytes,maxEdge:PHOTO_LIMITS.maxEdge};
      }
      if (!receipt || !fresh(receipt.receivedAt, now) || !fresh(execution?.receivedAt, now)
        || receipt.status.version !== config.version || receipt.status.policyState !== 'APPLIED'
        || execution.version !== config.version || digest(receipt.context) !== digest(body.context)
        || digest(execution.context) !== digest(body.context) || execution.status.owner !== 'Schedule'
        || execution.status.state !== 'Active' || !execution.status.signalFresh || !execution.status.clockReady
        || execution.status.reason !== 'WINDOW_ACTIVE' || !execution.status.sessionId) fail(409, 'PHOTO_EXECUTION_NOT_FRESH');
      const row = {id: randomUUID(), deviceId: device.id, ...config.scope, version: config.version, context: body.context,
        settings: {...config.effective.settings, noiseSessionId: execution.status.sessionId, window: execution.status.window},
        createdAt: new Date(now), expiresAt: new Date(now + PHOTO_LIMITS.leaseSeconds * 1000)};
      await repo.saveLease(tx, row);
      return {leaseId: row.id, version: row.version, sessionId: execution.status.sessionId, leaseSeconds: PHOTO_LIMITS.leaseSeconds,
        createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), maxBytes: PHOTO_LIMITS.maxBytes, maxEdge: PHOTO_LIMITS.maxEdge};
    }),
    async upload(auth, meta, bytes) {
      if (!validatePhotoMetadata(meta)) fail(400, 'INVALID_REQUEST');
      const size = jpegDimensions(bytes);
      if (bytes.length !== meta.byteCount || size.width !== meta.width || size.height !== meta.height || photoHash(bytes) !== meta.hash) fail(400, 'PHOTO_CONTENT_MISMATCH');
      // Authorize before CPU-heavy decoding; repeat inside the admission transaction.
      await base.withRuntimeDevice(auth, (tx, device) => eligibleUpload(tx, device, meta));
      let image;
      try { image = await encode(bytes); } catch (e) {
        if (e.message === 'PHOTO_ENCODING_TIMEOUT') fail(503, 'PHOTO_ENCODING_TIMEOUT');
        if (e.photoEncoding) fail(400, 'INVALID_PHOTO'); throw e;
      }
      const fingerprint = digest(meta), storedHash = photoHash(image.bytes);
      const admitted = await base.withRuntimeDevice(auth, async (tx, device) => {
        const {lease, config, at, expiresAt} = await eligibleUpload(tx, device, meta);
        requireSame(meta.sessionId, lease.settings.noiseSessionId, 'PHOTO_SESSION_CHANGED');
        const old = await repo.event(tx, meta.eventId);
        if (old) {
          requireSame([old.deviceId, old.digest], [device.id, fingerprint], 'IDEMPOTENCY_CONFLICT');
          if (old.state === 'Deleted' || old.state === 'DeletePending') fail(410, 'PHOTO_DELETED');
          requireSame(old.storedHash, storedHash, 'IDEMPOTENCY_CONFLICT');
          return old;
        }
        if (await repo.neighboring(tx, device.id, at, lease.settings.photos.cooldownSeconds)) fail(429, 'PHOTO_COOLDOWN');
        if (await repo.usage(tx, device.schoolId) + image.bytes.length > quotaBytes) fail(507, 'PHOTO_STORAGE_QUOTA');
        const row = {eventId: meta.eventId, deviceId: device.id, ...config.scope, leaseId: meta.leaseId, version: meta.version,
          metadata: meta, digest: fingerprint, storedHash, width: image.width, height: image.height, byteCount: image.bytes.length,
          capturedAt: at, expiresAt, state: 'Uploading'};
        await repo.saveEvent(tx, row); return row;
      });
      if (admitted.state === 'Stored') return {eventId: meta.eventId, state: 'Stored', storedHash: admitted.storedHash};
      // Publication shares the school/device locks with deletion. A crash leaves
      // Uploading metadata for cleanup, never an accessible orphan.
      return await base.withRuntimeDevice(auth, async (tx, device) => {
          await eligibleUpload(tx, device, meta);
          const current = await repo.event(tx, meta.eventId);
          if (!current || ['Deleted', 'DeletePending'].includes(current.state)) fail(410, 'PHOTO_DELETED');
          requireSame(current.digest, fingerprint, 'IDEMPOTENCY_CONFLICT');
          if (current.state === 'Stored') return {eventId: meta.eventId, state: 'Stored', storedHash};
          await store.put(meta.eventId, image.bytes);
          await repo.state(tx, meta.eventId, 'Stored');
          return {eventId: meta.eventId, state: 'Stored', storedHash};
      });
    },
    list: (claims, school, term, classroom, cursor = null) => base.withScheduleAdmin(claims, school, async tx => {
      if (!OPAQUE_ID.test(term || '') || !OPAQUE_ID.test(classroom || '')) fail(400, 'INVALID_REQUEST');
      const c = await tx.workspace.findUnique({where: {id: classroom}}), t = await tx.academicTerm.findUnique({where: {id: term}});
      if (c?.termId !== term || t?.schoolId !== school) fail(404, 'NOT_FOUND');
      let before = {at: new Date('9999-01-01T00:00:00.000Z'), id: 'ffffffff-ffff-ffff-ffff-ffffffffffff'};
      if (cursor) { if (typeof cursor !== 'string' || cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail(400, 'INVALID_REQUEST');
        try { before = JSON.parse(Buffer.from(cursor, 'base64url').toString()); } catch { fail(400, 'INVALID_REQUEST'); }
        if (!UUID.test(before?.id || '') || !Number.isFinite(Date.parse(before?.at))) fail(400, 'INVALID_REQUEST'); before.at = new Date(before.at); }
      const rows = await repo.list(tx, school, term, classroom, before), next = rows.length > 30 ? rows[29] : null;
      await audit(tx, school, claims.accountId, 'STUDY_PHOTO_LIST', classroom);
      return {items: rows.slice(0, 30).map(view), cursor: next ? Buffer.from(JSON.stringify({at: new Date(next.capturedAt).toISOString(), id: next.eventId})).toString('base64url') : null};
    }),
    image: (claims, school, id, download = false) => base.withScheduleAdmin(claims, school, async tx => {
      if (!UUID.test(id || '')) fail(400, 'INVALID_REQUEST');
      const row = await repo.event(tx, id);
      if (row?.schoolId !== school || row.state !== 'Stored' || new Date(row.expiresAt).getTime() <= clock()) fail(404, 'NOT_FOUND');
      await audit(tx, school, claims.accountId, download ? 'STUDY_PHOTO_DOWNLOAD' : 'STUDY_PHOTO_VIEW', id);
      return store.read(id, row.storedHash);
    }),
    async remove(claims, school, id) {
      await base.withScheduleAdmin(claims, school, async tx => {
        if (!UUID.test(id || '')) fail(400, 'INVALID_REQUEST');
        const row = await repo.event(tx, id); if (row?.schoolId !== school) fail(404, 'NOT_FOUND');
        await repo.state(tx, id, 'DeletePending'); await audit(tx, school, claims.accountId, 'STUDY_PHOTO_DELETE', id);
      });
      await store.remove(id);
      await base.withScheduleAdmin(claims, school, tx => repo.state(tx, id, 'Deleted'));
      return {eventId: id, state: 'Deleted'};
    },
  };
}
