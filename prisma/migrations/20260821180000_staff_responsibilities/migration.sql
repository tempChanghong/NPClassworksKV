CREATE TYPE "GradeLeadershipPosition" AS ENUM ('PRIMARY', 'DEPUTY');
CREATE TYPE "AdministrativeClassLeadershipPosition" AS ENUM ('HEAD_TEACHER', 'CO_HEAD_TEACHER');

ALTER TABLE "School"
    ADD COLUMN "gradeLeaderMustBeHomeroom" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "gradeLeaderMustTeach" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "homeroomMustTeach" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "GradeLeadership" (
    "id" VARCHAR(191) NOT NULL,
    "gradeId" VARCHAR(191) NOT NULL,
    "accountId" VARCHAR(191) NOT NULL,
    "position" "GradeLeadershipPosition" NOT NULL DEFAULT 'PRIMARY',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GradeLeadership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GradeLeadership_gradeId_accountId_key" ON "GradeLeadership"("gradeId", "accountId");
CREATE INDEX "GradeLeadership_accountId_isActive_idx" ON "GradeLeadership"("accountId", "isActive");
CREATE INDEX "GradeLeadership_gradeId_position_isActive_idx" ON "GradeLeadership"("gradeId", "position", "isActive");

CREATE TABLE "AdministrativeClassLeadership" (
    "id" VARCHAR(191) NOT NULL,
    "administrativeClassId" VARCHAR(191) NOT NULL,
    "accountId" VARCHAR(191) NOT NULL,
    "position" "AdministrativeClassLeadershipPosition" NOT NULL DEFAULT 'HEAD_TEACHER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdministrativeClassLeadership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdministrativeClassLeadership_administrativeClassId_accountId_key"
    ON "AdministrativeClassLeadership"("administrativeClassId", "accountId");
CREATE INDEX "AdministrativeClassLeadership_accountId_isActive_idx"
    ON "AdministrativeClassLeadership"("accountId", "isActive");
CREATE INDEX "AdministrativeClassLeadership_administrativeClassId_position_isActive_idx"
    ON "AdministrativeClassLeadership"("administrativeClassId", "position", "isActive");
