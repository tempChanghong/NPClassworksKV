CREATE TABLE "NpepPhotoLease" (
  id uuid PRIMARY KEY, "deviceId" uuid NOT NULL,
  "schoolId" varchar(191) NOT NULL, "termId" varchar(191) NOT NULL, "classId" varchar(191) NOT NULL,
  version varchar(64) NOT NULL, context jsonb NOT NULL, settings jsonb NOT NULL,
  "createdAt" timestamptz(3) NOT NULL, "expiresAt" timestamptz(3) NOT NULL,
  CHECK ("expiresAt">"createdAt" AND "expiresAt"<="createdAt"+interval '60 seconds')
);
CREATE INDEX "NpepPhotoLease_deviceId_createdAt_idx" ON "NpepPhotoLease"("deviceId","createdAt");
CREATE INDEX "NpepPhotoLease_expiresAt_idx" ON "NpepPhotoLease"("expiresAt");
CREATE TABLE "NpepStudyPhoto" (
  "eventId" uuid PRIMARY KEY, "deviceId" uuid NOT NULL,
  "schoolId" varchar(191) NOT NULL, "termId" varchar(191) NOT NULL, "classId" varchar(191) NOT NULL,
  "leaseId" uuid NOT NULL, version varchar(64) NOT NULL, metadata jsonb NOT NULL,
  digest varchar(64) NOT NULL, "storedHash" varchar(64) NOT NULL,
  width integer NOT NULL CHECK(width BETWEEN 1 AND 1280), height integer NOT NULL CHECK(height BETWEEN 1 AND 1280),
  "byteCount" integer NOT NULL CHECK("byteCount" BETWEEN 1 AND 262144),
  "capturedAt" timestamptz(3) NOT NULL, "expiresAt" timestamptz(3) NOT NULL,
  state varchar(16) NOT NULL CHECK(state IN ('Uploading','Stored','DeletePending','Deleted')),
  "receivedAt" timestamptz(3) NOT NULL DEFAULT now(),
  CHECK("expiresAt">"capturedAt" AND "expiresAt"<="capturedAt"+interval '180 days')
);
CREATE INDEX "NpepStudyPhoto_schoolId_termId_classId_capturedAt_eventId_idx" ON "NpepStudyPhoto"("schoolId","termId","classId","capturedAt","eventId");
CREATE INDEX "NpepStudyPhoto_deviceId_capturedAt_idx" ON "NpepStudyPhoto"("deviceId","capturedAt");
CREATE INDEX "NpepStudyPhoto_state_expiresAt_idx" ON "NpepStudyPhoto"(state,"expiresAt");
