CREATE TABLE "AccountPreference" (
    "accountId" VARCHAR(191) NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountPreference_pkey" PRIMARY KEY ("accountId", "key")
);

CREATE INDEX "AccountPreference_accountId_updatedAt_idx"
    ON "AccountPreference"("accountId", "updatedAt");
