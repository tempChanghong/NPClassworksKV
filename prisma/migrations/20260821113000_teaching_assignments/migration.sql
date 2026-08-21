CREATE TYPE "TeachingAssignmentPosition" AS ENUM ('PRIMARY', 'CO_TEACHER');

CREATE TABLE "TeachingAssignment" (
    "id" VARCHAR(191) NOT NULL,
    "workspaceId" VARCHAR(191) NOT NULL,
    "subjectId" VARCHAR(191) NOT NULL,
    "accountId" VARCHAR(191) NOT NULL,
    "position" "TeachingAssignmentPosition" NOT NULL DEFAULT 'PRIMARY',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeachingAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TeachingAssignment_workspaceId_subjectId_accountId_key"
    ON "TeachingAssignment"("workspaceId", "subjectId", "accountId");
CREATE INDEX "TeachingAssignment_accountId_isActive_idx"
    ON "TeachingAssignment"("accountId", "isActive");
CREATE INDEX "TeachingAssignment_subjectId_idx"
    ON "TeachingAssignment"("subjectId");
CREATE INDEX "TeachingAssignment_workspaceId_subjectId_position_isActive_idx"
    ON "TeachingAssignment"("workspaceId", "subjectId", "position", "isActive");
