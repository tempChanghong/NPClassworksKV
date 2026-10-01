// One bounded aggregate per device. Access is serialized by the existing device row lock.
export const noiseRepository = {
  async read(tx, id) {
    const rows = await tx.$queryRaw`SELECT data FROM "NpepNoiseDevice" WHERE "deviceId"=${id}::uuid`;
    return rows[0]?.data ?? {status: null, commands: [], reports: []};
  },
  async save(tx, id, data) {
    await tx.$executeRaw`INSERT INTO "NpepNoiseDevice" ("deviceId",data) VALUES (${id}::uuid,${JSON.stringify(data)}::jsonb)
      ON CONFLICT ("deviceId") DO UPDATE SET data=EXCLUDED.data`;
  },
};
