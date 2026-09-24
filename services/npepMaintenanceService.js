import {prisma} from '../utils/prisma.js';

// Bounded batches; only the process holding the transaction advisory lock cleans.
export async function cleanupNpep(client = prisma) {
  return client.$transaction(async tx => {
    const [lock] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(781002) AS locked`;
    if (!lock.locked) return;
    await tx.$executeRaw`DELETE FROM "NpepNotificationSnapshot" WHERE "deviceId" IN
      (SELECT "deviceId" FROM "NpepNotificationSnapshot" WHERE "expiresAt"<=clock_timestamp() ORDER BY "expiresAt" LIMIT 5000)`;
    await tx.$executeRaw`DELETE FROM "NpepNotificationReceipt" WHERE ("deviceId","eventId") IN
      (SELECT "deviceId","eventId" FROM "NpepNotificationReceipt" WHERE "receivedAt"<clock_timestamp()-interval '90 days' ORDER BY "receivedAt" LIMIT 5000)`;
    await tx.$executeRaw`DELETE FROM "NpepNotificationExposure" WHERE ("deviceId","publicationId","revision") IN
      (SELECT "deviceId","publicationId","revision" FROM "NpepNotificationExposure" WHERE "exposedAt"<clock_timestamp()-interval '90 days' ORDER BY "exposedAt" LIMIT 5000)`;
    await tx.$executeRaw`UPDATE "NpepPairing" SET "secretHash"=NULL
      WHERE id IN (SELECT id FROM "NpepPairing" WHERE "expiresAt"<=clock_timestamp() AND "secretHash" IS NOT NULL ORDER BY "expiresAt" LIMIT 5000)`;
    await tx.$executeRaw`DELETE FROM "NpepPairing" WHERE id IN
      (SELECT id FROM "NpepPairing" WHERE "expiresAt"<clock_timestamp()-interval '24 hours' ORDER BY "expiresAt" LIMIT 5000)`;
    await tx.$executeRaw`DELETE FROM "NpepSessionReceipt" WHERE "sessionId" IN
      (SELECT "sessionId" FROM "NpepSessionReceipt" WHERE "expiresAt"<=clock_timestamp() ORDER BY "expiresAt" LIMIT 5000)`;
    await tx.$executeRaw`DELETE FROM "NpepDevice" WHERE id IN
      (SELECT id FROM "NpepDevice" WHERE "credentialExpiresAt"<clock_timestamp()-interval '24 hours' ORDER BY "credentialExpiresAt" LIMIT 5000)`;
    await tx.$executeRaw`DELETE FROM "NpepAudit" WHERE id IN
      (SELECT id FROM "NpepAudit" WHERE "createdAt"<clock_timestamp()-interval '90 days' ORDER BY "createdAt" LIMIT 5000)`;
    await tx.$executeRaw`DELETE FROM "NpepRateLimit" WHERE key IN
      (SELECT key FROM "NpepRateLimit" WHERE "expiresAt"<clock_timestamp()-interval '1 minute' ORDER BY "expiresAt" LIMIT 5000)`;
  }, {timeout: 9000});
}
export function startNpepMaintenance() {
  if (process.env.NPEP_ENABLED !== 'true') return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await cleanupNpep(); } catch { console.warn('NPEP maintenance unavailable'); }
    finally { running = false; }
  };
  const timer = setInterval(tick, 60000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
