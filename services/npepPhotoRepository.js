export const photoRepository = {
  async lease(tx, id) { return (await tx.$queryRaw`SELECT * FROM "NpepPhotoLease" WHERE id=${id}::uuid`)[0]; },
  async saveLease(tx, row) {
    await tx.$executeRaw`INSERT INTO "NpepPhotoLease" (id,"deviceId","schoolId","termId","classId",version,context,settings,"createdAt","expiresAt")
      VALUES (${row.id}::uuid,${row.deviceId}::uuid,${row.schoolId},${row.termId},${row.classId},${row.version},
      ${JSON.stringify(row.context)}::jsonb,${JSON.stringify(row.settings)}::jsonb,${row.createdAt},${row.expiresAt})`;
  },
  async event(tx, id) { return (await tx.$queryRaw`SELECT * FROM "NpepStudyPhoto" WHERE "eventId"=${id}::uuid FOR UPDATE`)[0]; },
  // DeletePending still owns physical bytes until unlink succeeds.
  async usage(tx, school) { return Number((await tx.$queryRaw`SELECT COALESCE(sum("byteCount"),0)::bigint AS bytes FROM "NpepStudyPhoto" WHERE "schoolId"=${school} AND state IN ('Uploading','Stored','DeletePending')`)[0].bytes); },
  async neighboring(tx, device, at, seconds) {
    return (await tx.$queryRaw`SELECT "eventId" FROM "NpepStudyPhoto" WHERE "deviceId"=${device}::uuid
      AND "capturedAt">${new Date(at.getTime() - seconds * 1000)} AND "capturedAt"<${new Date(at.getTime() + seconds * 1000)} LIMIT 1`)[0];
  },
  async saveEvent(tx, row) {
    await tx.$executeRaw`INSERT INTO "NpepStudyPhoto" ("eventId","deviceId","schoolId","termId","classId","leaseId",version,metadata,digest,"storedHash",width,height,"byteCount","capturedAt","expiresAt",state)
      VALUES (${row.eventId}::uuid,${row.deviceId}::uuid,${row.schoolId},${row.termId},${row.classId},${row.leaseId}::uuid,${row.version},
      ${JSON.stringify(row.metadata)}::jsonb,${row.digest},${row.storedHash},${row.width},${row.height},${row.byteCount},${row.capturedAt},${row.expiresAt},'Uploading')`;
  },
  async state(tx, id, state) { await tx.$executeRaw`UPDATE "NpepStudyPhoto" SET state=${state} WHERE "eventId"=${id}::uuid`; },
  async list(tx, school, term, classroom, before) {
    return tx.$queryRaw`SELECT * FROM "NpepStudyPhoto" WHERE "schoolId"=${school} AND "termId"=${term} AND "classId"=${classroom}
      AND state='Stored' AND "expiresAt">clock_timestamp() AND ("capturedAt","eventId")<(${before.at},${before.id}::uuid)
      ORDER BY "capturedAt" DESC,"eventId" DESC LIMIT 31`;
  },
};
