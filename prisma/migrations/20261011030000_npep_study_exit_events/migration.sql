CREATE TABLE "NpepStudyExitEvent" (
  "eventId" uuid PRIMARY KEY, "deviceId" uuid NOT NULL,
  "schoolId" varchar(191) NOT NULL, "termId" varchar(191) NOT NULL, "classId" varchar(191) NOT NULL,
  digest varchar(64) NOT NULL, metadata jsonb NOT NULL,
  "createdAt" timestamptz(3) NOT NULL, "expiresAt" timestamptz(3) NOT NULL,
  CHECK("expiresAt">"createdAt" AND "expiresAt"<="createdAt"+interval '180 days')
);
CREATE INDEX "NpepStudyExitEvent_schoolId_termId_classId_createdAt_eventId_idx" ON "NpepStudyExitEvent"("schoolId","termId","classId","createdAt","eventId");
CREATE INDEX "NpepStudyExitEvent_expiresAt_idx" ON "NpepStudyExitEvent"("expiresAt");
