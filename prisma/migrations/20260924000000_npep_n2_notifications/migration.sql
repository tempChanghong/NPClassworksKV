CREATE TABLE "NpepNotificationSnapshot" (
 "deviceId" UUID PRIMARY KEY REFERENCES "NpepDevice"("id") ON DELETE CASCADE,
 "snapshotId" UUID NOT NULL UNIQUE, "fingerprint" VARCHAR(64) NOT NULL,
 "items" JSONB NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "NpepNotificationSnapshot_expiresAt_idx" ON "NpepNotificationSnapshot"("expiresAt");
CREATE TABLE "NpepNotificationExposure" (
 "deviceId" UUID NOT NULL REFERENCES "NpepDevice"("id") ON DELETE CASCADE,
 "publicationId" VARCHAR(191) NOT NULL, "revision" INTEGER NOT NULL CHECK ("revision">0),
 "exposedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("deviceId","publicationId","revision")
);
CREATE INDEX "NpepNotificationExposure_exposedAt_idx" ON "NpepNotificationExposure"("exposedAt");
CREATE TABLE "NpepNotificationReceipt" (
 "deviceId" UUID NOT NULL REFERENCES "NpepDevice"("id") ON DELETE CASCADE,
 "eventId" UUID NOT NULL, "publicationId" VARCHAR(191) NOT NULL,
 "revision" INTEGER NOT NULL CHECK ("revision">0),
 "stage" VARCHAR(16) NOT NULL CHECK ("stage" IN ('RECEIVED','DISPLAYED','DISMISSED')),
 "occurredAt" TIMESTAMPTZ(3) NOT NULL, "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "digest" VARCHAR(64) NOT NULL, PRIMARY KEY ("deviceId","eventId")
);
CREATE INDEX "NpepNotificationReceipt_publicationId_revision_receivedAt_idx" ON "NpepNotificationReceipt"("publicationId","revision","receivedAt");
CREATE INDEX "NpepNotificationReceipt_receivedAt_idx" ON "NpepNotificationReceipt"("receivedAt");
