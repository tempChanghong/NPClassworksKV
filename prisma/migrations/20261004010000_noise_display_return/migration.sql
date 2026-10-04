CREATE TABLE "NpepNoiseDisplaySetting" (
  "schoolId" VARCHAR(191) NOT NULL,
  "termId" VARCHAR(191) NOT NULL,
  "targetType" VARCHAR(8) NOT NULL,
  "targetId" VARCHAR(191) NOT NULL,
  "returnMinutes" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL,
  "updatedBy" VARCHAR(191) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NpepNoiseDisplaySetting_pkey" PRIMARY KEY ("schoolId","termId","targetType","targetId")
);
CREATE INDEX "NpepNoiseDisplaySetting_schoolId_termId_idx" ON "NpepNoiseDisplaySetting"("schoolId","termId");

CREATE TABLE "NpepNoiseDisplayReturn" (
  "screenBindingId" VARCHAR(191) NOT NULL,
  "windowStart" VARCHAR(32) NOT NULL,
  "windowEnd" VARCHAR(32) NOT NULL,
  "credentialVersion" INTEGER NOT NULL,
  "requestId" UUID NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "returnMinutes" INTEGER NOT NULL,
  CONSTRAINT "NpepNoiseDisplayReturn_pkey" PRIMARY KEY ("screenBindingId","windowStart","windowEnd")
);
CREATE INDEX "NpepNoiseDisplayReturn_expiresAt_idx" ON "NpepNoiseDisplayReturn"("expiresAt");

CREATE TABLE "NpepNoiseDisplaySettingRequest" (
  "schoolId" VARCHAR(191) NOT NULL,
  "requestId" UUID NOT NULL,
  "actorId" VARCHAR(191) NOT NULL,
  "digest" VARCHAR(64) NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NpepNoiseDisplaySettingRequest_pkey" PRIMARY KEY ("schoolId","requestId")
);

CREATE TABLE "NpepNoiseManagementDevice" (
  "deviceId" UUID NOT NULL,
  "data" JSONB NOT NULL,
  CONSTRAINT "NpepNoiseManagementDevice_pkey" PRIMARY KEY ("deviceId")
);
