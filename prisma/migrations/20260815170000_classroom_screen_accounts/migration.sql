ALTER TABLE "ClassroomScreenBinding"
    ALTER COLUMN "deviceFingerprint" DROP NOT NULL,
    ADD COLUMN "loginCode" VARCHAR(32),
    ADD COLUMN "pinHash" VARCHAR(191),
    ADD COLUMN "loginFailures" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lockedUntil" TIMESTAMPTZ(6),
    ADD COLUMN "credentialVersion" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "activatedAt" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "ClassroomScreenBinding_schoolId_loginCode_key"
    ON "ClassroomScreenBinding"("schoolId", "loginCode");
