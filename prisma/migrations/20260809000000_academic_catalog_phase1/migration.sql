-- Classworks 2.0 phase 1: academic organization and workspace catalog.
-- relationMode = "prisma", so this migration intentionally mirrors the
-- existing project and creates indexes without database foreign keys.

CREATE TYPE "AcademicTermStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');
CREATE TYPE "SubjectCategory" AS ENUM ('CORE', 'ELECTIVE', 'OTHER');
CREATE TYPE "WorkspaceType" AS ENUM ('ADMIN_CLASS', 'COURSE_GROUP', 'GRADE_CHANNEL', 'SCHOOL_CHANNEL');
CREATE TYPE "SubjectDeliveryMode" AS ENUM ('ADMIN_CLASS', 'COURSE_GROUP');
CREATE TYPE "WorkspaceMemberRole" AS ENUM ('OWNER', 'TEACHER', 'ASSISTANT', 'VIEWER');

CREATE TABLE "School" (
    "id" VARCHAR(191) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(191) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "School_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AcademicTerm" (
    "id" VARCHAR(191) NOT NULL,
    "schoolId" VARCHAR(191) NOT NULL,
    "name" VARCHAR(191) NOT NULL,
    "academicYear" INTEGER NOT NULL,
    "semester" INTEGER NOT NULL,
    "startsAt" TIMESTAMPTZ(6),
    "endsAt" TIMESTAMPTZ(6),
    "status" "AcademicTermStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademicTerm_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Grade" (
    "id" VARCHAR(191) NOT NULL,
    "termId" VARCHAR(191) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(191) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Grade_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Subject" (
    "id" VARCHAR(191) NOT NULL,
    "schoolId" VARCHAR(191) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(191) NOT NULL,
    "category" "SubjectCategory" NOT NULL DEFAULT 'OTHER',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Workspace" (
    "id" VARCHAR(191) NOT NULL,
    "termId" VARCHAR(191) NOT NULL,
    "gradeId" VARCHAR(191),
    "subjectId" VARCHAR(191),
    "name" VARCHAR(191) NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "type" "WorkspaceType" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isStudentSelectable" BOOLEAN NOT NULL DEFAULT true,
    "legacyDeviceId" INTEGER,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkspaceSourceClass" (
    "workspaceId" VARCHAR(191) NOT NULL,
    "administrativeClassId" VARCHAR(191) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceSourceClass_pkey" PRIMARY KEY ("workspaceId", "administrativeClassId")
);

CREATE TABLE "AdministrativeClassSubject" (
    "administrativeClassId" VARCHAR(191) NOT NULL,
    "subjectId" VARCHAR(191) NOT NULL,
    "deliveryMode" "SubjectDeliveryMode" NOT NULL,
    "isCompulsory" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdministrativeClassSubject_pkey" PRIMARY KEY ("administrativeClassId", "subjectId")
);

CREATE TABLE "WorkspaceMember" (
    "workspaceId" VARCHAR(191) NOT NULL,
    "accountId" VARCHAR(191) NOT NULL,
    "role" "WorkspaceMemberRole" NOT NULL DEFAULT 'TEACHER',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("workspaceId", "accountId")
);

CREATE UNIQUE INDEX "School_code_key" ON "School"("code");
CREATE UNIQUE INDEX "AcademicTerm_schoolId_academicYear_semester_key" ON "AcademicTerm"("schoolId", "academicYear", "semester");
CREATE INDEX "AcademicTerm_schoolId_status_idx" ON "AcademicTerm"("schoolId", "status");
CREATE UNIQUE INDEX "Grade_termId_code_key" ON "Grade"("termId", "code");
CREATE INDEX "Grade_termId_sortOrder_idx" ON "Grade"("termId", "sortOrder");
CREATE UNIQUE INDEX "Subject_schoolId_code_key" ON "Subject"("schoolId", "code");
CREATE INDEX "Subject_schoolId_sortOrder_idx" ON "Subject"("schoolId", "sortOrder");
CREATE UNIQUE INDEX "Workspace_legacyDeviceId_key" ON "Workspace"("legacyDeviceId");
CREATE UNIQUE INDEX "Workspace_termId_code_key" ON "Workspace"("termId", "code");
CREATE INDEX "Workspace_termId_gradeId_type_idx" ON "Workspace"("termId", "gradeId", "type");
CREATE INDEX "Workspace_subjectId_type_idx" ON "Workspace"("subjectId", "type");
CREATE INDEX "WorkspaceSourceClass_administrativeClassId_idx" ON "WorkspaceSourceClass"("administrativeClassId");
CREATE INDEX "AdministrativeClassSubject_subjectId_deliveryMode_idx" ON "AdministrativeClassSubject"("subjectId", "deliveryMode");
CREATE INDEX "WorkspaceMember_accountId_role_idx" ON "WorkspaceMember"("accountId", "role");
