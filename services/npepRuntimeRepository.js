// The ledger deliberately has no cascading FK: revoked/deleted credentials must not
// erase evidence or free an operation whose effects are still unknown.
export const runtimeRepository = {
  async policy(tx, id) { const rows = await tx.$queryRaw`SELECT data FROM "NpepRuntimePolicy" WHERE "deviceId"=${id}::uuid`; return rows[0]?.data ?? null; },
  async savePolicy(tx, id, data) {
    await tx.$executeRaw`INSERT INTO "NpepRuntimePolicy" ("deviceId",data) VALUES (${id}::uuid,${JSON.stringify(data)}::jsonb)
      ON CONFLICT ("deviceId") DO UPDATE SET data=EXCLUDED.data`;
  },
  async operation(tx, id) { const rows = await tx.$queryRaw`SELECT data FROM "NpepRuntimeOperation" WHERE id=${id}::uuid`; return rows[0]?.data ?? null; },
  async list(tx, id, active = false) {
    const rows = active ? await tx.$queryRaw`SELECT data FROM "NpepRuntimeOperation" WHERE "deviceId"=${id}::uuid AND "resolvedAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`
      : await tx.$queryRaw`SELECT data FROM "NpepRuntimeOperation" WHERE "deviceId"=${id}::uuid ORDER BY "createdAt" DESC, id DESC LIMIT 20`;
    return rows.map(r => r.data);
  },
  async byRequest(tx, id, requestId) {
    const rows = await tx.$queryRaw`SELECT data FROM "NpepRuntimeOperation" WHERE "deviceId"=${id}::uuid
      AND ("requestId"=${requestId}::uuid OR data->'coalescedRequests' @> ${JSON.stringify([{requestId}])}::jsonb)`;
    return rows[0]?.data ?? null;
  },
  async saveOperation(tx, op) {
    const v = op.view;
    await tx.$executeRaw`INSERT INTO "NpepRuntimeOperation" (id,"deviceId","requestId","createdAt","resolvedAt",data)
      VALUES (${v.operationId}::uuid,${v.deviceId}::uuid,${v.requestId}::uuid,${new Date(v.createdAt)},${v.resolvedAt ? new Date(v.resolvedAt) : null},${JSON.stringify(op)}::jsonb)
      ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data,"resolvedAt"=EXCLUDED."resolvedAt"`;
  },
};
