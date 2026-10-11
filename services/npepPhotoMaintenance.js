import {NpepPhotoStore} from './npepPhotoStore.js';
// Do not delete metadata before unlink succeeds: retry failures and deny all pending reads.
export async function cleanupStudyPhotos(client, store = new NpepPhotoStore()) {
  await client.$transaction(async tx => {
    const [lock] = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(781003) AS locked`;
    if (!lock.locked) return;
    await tx.$executeRaw`DELETE FROM "NpepStudyExitEvent" WHERE "eventId" IN
      (SELECT "eventId" FROM "NpepStudyExitEvent" WHERE "expiresAt"<=clock_timestamp() LIMIT 500)`;
    await tx.$executeRaw`UPDATE "NpepStudyPhoto" SET state='DeletePending' WHERE "eventId" IN
      (SELECT "eventId" FROM "NpepStudyPhoto" WHERE (state='Stored' AND "expiresAt"<=clock_timestamp())
        OR (state='Uploading' AND "receivedAt"<clock_timestamp()-interval '5 minutes') ORDER BY "receivedAt" LIMIT 500)`;
    const rows = await tx.$queryRaw`SELECT "eventId" FROM "NpepStudyPhoto" WHERE state='DeletePending' ORDER BY "receivedAt" LIMIT 500 FOR UPDATE`;
    for (const row of rows) {
      try { await store.remove(row.eventId);
        await tx.$executeRaw`UPDATE "NpepStudyPhoto" SET state='Deleted' WHERE "eventId"=${row.eventId}::uuid`;
      } catch { /* keep DeletePending; never claim physical deletion succeeded */ }
    }
    // Tombstones outlive the maximum permitted delayed upload, preventing resurrection.
    await tx.$executeRaw`DELETE FROM "NpepStudyPhoto" WHERE "eventId" IN
      (SELECT "eventId" FROM "NpepStudyPhoto" WHERE state='Deleted' AND "capturedAt"<clock_timestamp()-interval '2 days' LIMIT 500)`;
    await tx.$executeRaw`DELETE FROM "NpepPhotoLease" WHERE id IN
      (SELECT id FROM "NpepPhotoLease" WHERE "expiresAt"<clock_timestamp()-interval '2 days' LIMIT 1000)`;
  }, {timeout: 9000});
}
