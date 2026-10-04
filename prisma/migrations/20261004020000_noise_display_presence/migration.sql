CREATE TABLE "NpepNoiseDisplayPresence" (
  "screenBindingId" VARCHAR(191) NOT NULL,
  "displaySessionId" UUID NOT NULL,
  "credentialVersion" INTEGER NOT NULL,
  "deviceId" UUID NOT NULL,
  "instanceId" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "captureSessionId" UUID NOT NULL,
  "windowStart" VARCHAR(32) NOT NULL,
  "windowEnd" VARCHAR(32) NOT NULL,
  "state" VARCHAR(24) NOT NULL,
  "sequence" INTEGER NOT NULL,
  "requestId" UUID NOT NULL,
  "digest" VARCHAR(64) NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NpepNoiseDisplayPresence_pkey" PRIMARY KEY ("screenBindingId","displaySessionId")
);
CREATE INDEX "NpepNoiseDisplayPresence_screenBindingId_receivedAt_idx"
  ON "NpepNoiseDisplayPresence"("screenBindingId","receivedAt");
