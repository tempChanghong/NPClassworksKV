ALTER TABLE "ClassroomScreenBinding"
  ADD COLUMN "npepPairingEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "npepPairingRevision" DOUBLE PRECISION NOT NULL DEFAULT 1;
ALTER TABLE "NpepPairing"
  ADD COLUMN "approvalSource" VARCHAR(16) NOT NULL DEFAULT 'ADMIN',
  ADD COLUMN "preauthorizationRevision" DOUBLE PRECISION,
  ADD COLUMN "screenCredentialVersion" INTEGER;
CREATE TABLE "NpepScreenPairingTicket" (
  "id" UUID PRIMARY KEY,
  "userCode" VARCHAR(8) NOT NULL,
  "requestId" UUID NOT NULL,
  "schoolId" VARCHAR(191) NOT NULL,
  "screenBindingId" VARCHAR(191) NOT NULL,
  "bindingRevision" DOUBLE PRECISION NOT NULL,
  "authorizationRevision" DOUBLE PRECISION NOT NULL,
  "credentialVersion" INTEGER NOT NULL,
  "serverInstanceId" UUID NOT NULL,
  "deploymentEpoch" UUID NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'READY',
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "claimedPairingId" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "NpepScreenPairingTicket_userCode_key" ON "NpepScreenPairingTicket"("userCode");
CREATE UNIQUE INDEX "NpepScreenPairingTicket_screenBindingId_requestId_key" ON "NpepScreenPairingTicket"("screenBindingId", "requestId");
CREATE INDEX "NpepScreenPairingTicket_screenBindingId_state_idx" ON "NpepScreenPairingTicket"("screenBindingId", "state");
CREATE INDEX "NpepScreenPairingTicket_expiresAt_idx" ON "NpepScreenPairingTicket"("expiresAt");
