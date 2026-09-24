import {randomUUID} from 'node:crypto';
import {Prisma} from '../generated/prisma/client.ts';
import {digest, displayText, fail} from '../domain/npep/wire.js';
import {resolveClassroomScreenWorkspaces} from './classroomScreenService.js';

const PAGE = 20, MAX_ITEMS = 500, MAX_BYTES = 2 * 1024 * 1024;
export const notificationCursor = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}:\d{1,3}$/;
export function notificationProjection(row) {
  const item = {publicationId: row.id, revision: row.revision, title: row.title || '', content: row.content,
    priority: row.priority, publishAt: row.publishAt.toISOString(), expiresAt: row.expiresAt?.toISOString() || null,
    source: displayText(row.author?.name || '学校通知', 120).slice(0, 120).replace(/[\uD800-\uDBFF]$/, ''),
    popupEnabled: row.priority !== 'MINOR' || row.contentJson?.popupEnabled === true};
  // Match .NET string.Length / IPC limits, including surrogate pairs.
  if (item.title.length > 160 || item.content.length > 8000) fail(503, 'SNAPSHOT_LIMIT_EXCEEDED');
  return item;
}

export function createNpepNotificationService(identity) {
  async function visible(tx, device, now) {
    const binding = await tx.classroomScreenBinding.findUnique({where: {id: device.screenBindingId},
      include: {administrativeClass: {include: {subjectRules: true}}}});
    const scopes = await resolveClassroomScreenWorkspaces(binding, tx);
    const where = {
      type: 'NOTICE', status: 'PUBLISHED', publishAt: {lte: now},
      OR: [{expiresAt: null}, {expiresAt: {gt: now}}],
      targets: {some: {workspaceId: {in: scopes.map(scope => scope.id)}}},
    };
    let rows = await tx.publication.findMany({where, orderBy: {id: 'asc'}, take: MAX_ITEMS + 1,
      include: {author: {select: {name: true}}}});
    if (rows.length > MAX_ITEMS) fail(503, 'SNAPSHOT_LIMIT_EXCEEDED');
    if (rows.length) {
      const ids = rows.map(row => row.id);
      await tx.$queryRaw`SELECT id FROM "Publication" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR SHARE`;
      // Recheck after any publication-write lock wait; never send the pre-lock body.
      rows = await tx.publication.findMany({where: {...where, id: {in: ids}}, orderBy: {id: 'asc'},
        include: {author: {select: {name: true}}}});
    }
    const items = rows.map(notificationProjection);
    if (Buffer.byteLength(JSON.stringify(items)) > MAX_BYTES) fail(503, 'SNAPSHOT_LIMIT_EXCEEDED');
    return items;
  }
  return {
    snapshot: (auth, cursor) => identity.withDevice(auth, async (tx, device) => {
      const now = new Date();
      const items = await visible(tx, device, now), fingerprint = digest(items);
      let snapshot, offset = 0;
      if (cursor) {
        const [id, index] = cursor.split(':'); offset = Number(index);
        snapshot = await tx.npepNotificationSnapshot.findUnique({where: {deviceId: device.id}});
        if (!snapshot || snapshot.snapshotId !== id || snapshot.expiresAt <= now) fail(410, 'SNAPSHOT_EXPIRED');
        if (offset % PAGE || offset <= 0 || offset >= snapshot.items.length) fail(400, 'INVALID_REQUEST');
        if (snapshot.fingerprint !== fingerprint) fail(409, 'SNAPSHOT_INVALIDATED');
      } else {
        snapshot = await tx.npepNotificationSnapshot.upsert({where: {deviceId: device.id},
          create: {deviceId: device.id, snapshotId: randomUUID(), fingerprint, items, expiresAt: new Date(now.getTime() + 120000)},
          update: {snapshotId: randomUUID(), fingerprint, items, expiresAt: new Date(now.getTime() + 120000)}});
      }
      const page = snapshot.items.slice(offset, offset + PAGE);
      // Evidence of authorized delivery, not a fabricated RECEIVED/displayed receipt.
      const exposureCount = await tx.npepNotificationExposure.count({where: {deviceId: device.id}});
      const existing = await tx.npepNotificationExposure.count({where: {deviceId: device.id,
        OR: page.map(item => ({publicationId: item.publicationId, revision: item.revision}))}});
      if (exposureCount + page.length - existing > 10000) fail(503, 'RECEIPT_CAPACITY_EXCEEDED');
      await tx.npepNotificationExposure.createMany({data: page.map(item => ({deviceId: device.id,
        publicationId: item.publicationId, revision: item.revision, exposedAt: now})), skipDuplicates: true});
      return {serverTime: now.toISOString(), pollAfterSeconds: 10, snapshotId: snapshot.snapshotId, items: page,
        nextCursor: offset + PAGE < snapshot.items.length ? `${snapshot.snapshotId}:${offset + PAGE}` : null};
    }),
    receipts: (auth, events) => identity.withDevice(auth, async (tx, device) => {
      const results = [];
      for (const event of events) {
        const key = {deviceId: device.id, eventId: event.eventId};
        const previous = await tx.npepNotificationReceipt.findUnique({where: {deviceId_eventId: key}});
        const eventDigest = digest(event);
        if (previous) {
          results.push({eventId: event.eventId, status: previous.digest === eventDigest ? 'DUPLICATE' : 'REJECTED',
            code: previous.digest === eventDigest ? null : 'IDEMPOTENCY_CONFLICT'}); continue;
        }
        const exposure = await tx.npepNotificationExposure.findUnique({where: {deviceId_publicationId_revision: {
          deviceId: device.id, publicationId: event.publicationId, revision: event.revision}}});
        if (!exposure) {
          results.push({eventId: event.eventId, status: 'REJECTED', code: 'NOTICE_NOT_AVAILABLE'}); continue;
        }
        if (await tx.npepNotificationReceipt.count({where: {deviceId: device.id}}) >= 100000) fail(503, 'RECEIPT_CAPACITY_EXCEEDED');
        await tx.npepNotificationReceipt.create({data: {...key, publicationId: event.publicationId,
          revision: event.revision, stage: event.stage, occurredAt: new Date(event.occurredAt), digest: eventDigest}});
        results.push({eventId: event.eventId, status: 'ACCEPTED', code: null});
      }
      return {results};
    }),
  };
}
