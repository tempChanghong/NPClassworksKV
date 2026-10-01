CREATE TABLE "NpepExamPlanDevice" ("deviceId" UUID PRIMARY KEY, "data" JSONB NOT NULL);
CREATE TABLE "NpepExamPlan" (
  "id" UUID PRIMARY KEY, "deviceId" UUID NOT NULL, "requestId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL, "data" JSONB NOT NULL
);
CREATE UNIQUE INDEX "NpepExamPlan_request" ON "NpepExamPlan" ("deviceId", "requestId");
CREATE INDEX "NpepExamPlan_history" ON "NpepExamPlan" ("deviceId", "createdAt" DESC, "id" DESC);
