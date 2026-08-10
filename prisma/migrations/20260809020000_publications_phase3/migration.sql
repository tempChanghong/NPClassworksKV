-- Classworks 2.0 phase 3: unified assignments/notices and multi-target publishing.

CREATE TYPE "PublicationType" AS ENUM ('ASSIGNMENT', 'NOTICE');
CREATE TYPE "PublicationStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'WITHDRAWN');
CREATE TYPE "PublicationPriority" AS ENUM ('NORMAL', 'IMPORTANT', 'URGENT');

CREATE TABLE "Publication" (
    "id" VARCHAR(191) NOT NULL,
    "authorAccountId" VARCHAR(191) NOT NULL,
    "type" "PublicationType" NOT NULL,
    "subjectId" VARCHAR(191),
    "title" VARCHAR(191),
    "content" TEXT NOT NULL,
    "contentJson" JSON,
    "publishAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6),
    "priority" "PublicationPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "withdrawnAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Publication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PublicationTarget" (
    "publicationId" VARCHAR(191) NOT NULL,
    "workspaceId" VARCHAR(191) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicationTarget_pkey" PRIMARY KEY ("publicationId", "workspaceId")
);

CREATE INDEX "Publication_authorAccountId_updatedAt_idx" ON "Publication"("authorAccountId", "updatedAt");
CREATE INDEX "Publication_status_publishAt_idx" ON "Publication"("status", "publishAt");
CREATE INDEX "Publication_subjectId_status_idx" ON "Publication"("subjectId", "status");
CREATE INDEX "PublicationTarget_workspaceId_publicationId_idx" ON "PublicationTarget"("workspaceId", "publicationId");
