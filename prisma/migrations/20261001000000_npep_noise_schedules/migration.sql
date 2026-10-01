CREATE TABLE "NpepNoiseSchedulePolicy" (
  "schoolId" VARCHAR(191) NOT NULL,
  "termId" VARCHAR(191) NOT NULL,
  "targetType" VARCHAR(8) NOT NULL CHECK ("targetType" IN ('GRADE', 'CLASS')),
  "targetId" VARCHAR(191) NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  policy JSONB NOT NULL,
  "updatedBy" VARCHAR(191) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("schoolId", "termId", "targetType", "targetId")
);
CREATE INDEX "NpepNoiseSchedulePolicy_schoolId_termId_idx" ON "NpepNoiseSchedulePolicy" ("schoolId", "termId");
-- Append-only request results preserve revision/audit evidence after later edits.
CREATE TABLE "NpepNoiseScheduleRequest" (
  "schoolId" VARCHAR(191) NOT NULL,
  "requestId" UUID NOT NULL,
  "actorId" VARCHAR(191) NOT NULL,
  digest VARCHAR(64) NOT NULL,
  result JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("schoolId", "requestId")
);
