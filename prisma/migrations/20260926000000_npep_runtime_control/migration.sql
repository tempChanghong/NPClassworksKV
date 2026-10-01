CREATE TABLE "NpepRuntimePolicy" (
  "deviceId" UUID PRIMARY KEY,
  "data" JSONB NOT NULL
);
CREATE TABLE "NpepRuntimeOperation" (
  "id" UUID PRIMARY KEY,
  "deviceId" UUID NOT NULL,
  "requestId" UUID NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "resolvedAt" TIMESTAMPTZ(3),
  "data" JSONB NOT NULL
);
CREATE UNIQUE INDEX "NpepRuntimeOperation_request" ON "NpepRuntimeOperation" ("deviceId", "requestId");
CREATE UNIQUE INDEX "NpepRuntimeOperation_active" ON "NpepRuntimeOperation" ("deviceId") WHERE "resolvedAt" IS NULL;
CREATE INDEX "NpepRuntimeOperation_history" ON "NpepRuntimeOperation" ("deviceId", "createdAt" DESC, "id" DESC);
