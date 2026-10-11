-- Configuration only: this migration does not enable capture or rewrite legacy settings.
CREATE TABLE "NpepStudySetting" (
  "schoolId" VARCHAR(191) NOT NULL,
  "termId" VARCHAR(191) NOT NULL,
  "targetType" VARCHAR(8) NOT NULL,
  "targetId" VARCHAR(191) NOT NULL,
  "revision" INTEGER NOT NULL,
  "policy" JSONB NOT NULL,
  "updatedBy" VARCHAR(191) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NpepStudySetting_pkey" PRIMARY KEY ("schoolId","termId","targetType","targetId"),
  CONSTRAINT "NpepStudySetting_target_check" CHECK ("targetType" IN ('GRADE', 'CLASS')),
  CONSTRAINT "NpepStudySetting_revision_check" CHECK ("revision" > 0)
);
CREATE INDEX "NpepStudySetting_schoolId_termId_idx" ON "NpepStudySetting"("schoolId","termId");

CREATE TABLE "NpepStudySettingRequest" (
  "schoolId" VARCHAR(191) NOT NULL,
  "requestId" UUID NOT NULL,
  "actorId" VARCHAR(191) NOT NULL,
  "digest" VARCHAR(64) NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NpepStudySettingRequest_pkey" PRIMARY KEY ("schoolId","requestId")
);
