export const examPlanRepository = {
  async status(tx,id) { return (await tx.$queryRaw`SELECT data FROM "NpepExamPlanDevice" WHERE "deviceId"=${id}::uuid`)[0]?.data??null; },
  async saveStatus(tx,id,data) { await tx.$executeRaw`INSERT INTO "NpepExamPlanDevice" ("deviceId",data) VALUES (${id}::uuid,${JSON.stringify(data)}::jsonb) ON CONFLICT ("deviceId") DO UPDATE SET data=EXCLUDED.data`; },
  async get(tx,id) { return (await tx.$queryRaw`SELECT data FROM "NpepExamPlan" WHERE id=${id}::uuid`)[0]?.data??null; },
  async list(tx,id) { return (await tx.$queryRaw`SELECT data FROM "NpepExamPlan" WHERE "deviceId"=${id}::uuid ORDER BY "createdAt" DESC,id DESC LIMIT 10`).map(r=>r.data); },
  async byRequest(tx,id,request) { return (await tx.$queryRaw`SELECT data FROM "NpepExamPlan" WHERE "deviceId"=${id}::uuid AND "requestId"=${request}::uuid`)[0]?.data??null; },
  async save(tx,item) { const o=item.view; await tx.$executeRaw`INSERT INTO "NpepExamPlan" (id,"deviceId","requestId","createdAt",data) VALUES (${o.operationId}::uuid,${o.context.identity.deviceId}::uuid,${o.requestId}::uuid,${new Date(o.createdAt)},${JSON.stringify(item)}::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data`; },
};
