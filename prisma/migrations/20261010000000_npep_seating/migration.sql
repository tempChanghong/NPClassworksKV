-- LOCAL ONLY. Not executed. Exact-scope authorization remains in the transactional service.
CREATE TABLE "NpepSeatingVersion" (
 "schoolId" varchar(191) NOT NULL REFERENCES "School"(id) ON DELETE CASCADE,
 "termId" varchar(191) NOT NULL REFERENCES "AcademicTerm"(id) ON DELETE CASCADE,
 "classId" varchar(191) NOT NULL REFERENCES "Workspace"(id) ON DELETE CASCADE,
 revision integer NOT NULL CHECK (revision > 0), hash varchar(64), width integer, height integer,
 "imageBytes" bytea, "requestId" uuid NOT NULL, digest varchar(64) NOT NULL,
 "actorId" varchar(191) NOT NULL, "createdAt" timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("schoolId","termId","classId",revision), UNIQUE ("schoolId","requestId"),
 CHECK ("imageBytes" IS NULL OR octet_length("imageBytes") BETWEEN 1 AND 2097152),
 CHECK (hash IS NULL OR (width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096 AND width::bigint*height <= 6000000))
);
CREATE TABLE "NpepSeatingReceipt" (
 "deviceId" uuid PRIMARY KEY REFERENCES "NpepDevice"(id) ON DELETE CASCADE,
 "schoolId" varchar(191) NOT NULL REFERENCES "School"(id) ON DELETE CASCADE,
 "termId" varchar(191) NOT NULL REFERENCES "AcademicTerm"(id) ON DELETE CASCADE,
 "classId" varchar(191) NOT NULL REFERENCES "Workspace"(id) ON DELETE CASCADE, data jsonb NOT NULL
);
CREATE INDEX "NpepSeatingReceipt_schoolId_termId_classId_idx" ON "NpepSeatingReceipt" ("schoolId","termId","classId");
