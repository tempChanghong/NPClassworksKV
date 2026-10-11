export const seatingRepository = {
  async current(tx, school, term, classroom) {
    const rows = await tx.$queryRaw`SELECT revision, hash, width, height, octet_length("imageBytes") AS "byteCount"
      FROM "NpepSeatingVersion" WHERE "schoolId"=${school} AND "termId"=${term} AND "classId"=${classroom} ORDER BY revision DESC LIMIT 1`;
    return rows[0];
  },
  async part(tx, school, term, classroom, revision, hash, index) {
    const rows = await tx.$queryRaw`SELECT substring("imageBytes" FROM ${index * 16384 + 1} FOR 16384) AS bytes FROM "NpepSeatingVersion"
      WHERE "schoolId"=${school} AND "termId"=${term} AND "classId"=${classroom} AND revision=${revision} AND hash=${hash}`;
    return rows[0]?.bytes;
  },
  async versions(tx, school, term, classroom) {
    return tx.$queryRaw`SELECT revision, hash, width, height, "imageBytes", "createdAt", "requestId", digest, "actorId"
      FROM "NpepSeatingVersion" WHERE "schoolId"=${school} AND "termId"=${term} AND "classId"=${classroom} ORDER BY revision DESC LIMIT 20`;
  },
  async request(tx, school, requestId) {
    const rows = await tx.$queryRaw`SELECT "termId", "classId", revision, hash, width, height, "createdAt", digest, "actorId"
      FROM "NpepSeatingVersion" WHERE "schoolId"=${school} AND "requestId"=${requestId}::uuid`;
    return rows[0];
  },
  async save(tx, school, actor, body, row, fingerprint) {
    await tx.$executeRaw`INSERT INTO "NpepSeatingVersion" ("schoolId","termId","classId",revision,hash,width,height,"imageBytes","requestId",digest,"actorId","createdAt")
      VALUES (${school},${body.termId},${body.classId},${row.revision},${row.hash},${row.width},${row.height},${row.imageBytes},${body.requestId}::uuid,${fingerprint},${actor},${row.createdAt})`;
    // Keep immutable metadata for retries; bound retained image bytes to the latest five releases.
    await tx.$executeRaw`UPDATE "NpepSeatingVersion" SET "imageBytes"=NULL WHERE "schoolId"=${school} AND "termId"=${body.termId} AND "classId"=${body.classId} AND revision<=${row.revision - 5}`;
  },
  async receipts(tx, school, term, classroom) {
    return tx.$queryRaw`SELECT "deviceId", data FROM "NpepSeatingReceipt" WHERE "schoolId"=${school} AND "termId"=${term} AND "classId"=${classroom}`;
  },
  async receipt(tx, id) { const rows = await tx.$queryRaw`SELECT data FROM "NpepSeatingReceipt" WHERE "deviceId"=${id}::uuid`; return rows[0]?.data; },
  async saveReceipt(tx, device, scope, data) {
    await tx.$executeRaw`INSERT INTO "NpepSeatingReceipt" ("deviceId","schoolId","termId","classId",data)
      VALUES (${device.id}::uuid,${scope.schoolId},${scope.termId},${scope.classId},${JSON.stringify(data)}::jsonb)
      ON CONFLICT ("deviceId") DO UPDATE SET "schoolId"=EXCLUDED."schoolId","termId"=EXCLUDED."termId","classId"=EXCLUDED."classId",data=EXCLUDED.data`;
  },
};
