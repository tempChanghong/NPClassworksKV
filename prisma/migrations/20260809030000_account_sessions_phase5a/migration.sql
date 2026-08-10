-- Classworks 2.0 phase 5A: independent refresh sessions for teacher devices.
-- The project currently uses relationMode = "prisma", so no database foreign
-- key is added here; account lifecycle cleanup remains in Prisma.

CREATE TABLE "AccountSession" (
    "id" VARCHAR(191) NOT NULL,
    "accountId" VARCHAR(191) NOT NULL,
    "refreshTokenHash" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "lastUsedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountSession_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountSession_refreshTokenHash_key" ON "AccountSession"("refreshTokenHash");
CREATE INDEX "AccountSession_accountId_revokedAt_idx" ON "AccountSession"("accountId", "revokedAt");
CREATE INDEX "AccountSession_expiresAt_idx" ON "AccountSession"("expiresAt");
