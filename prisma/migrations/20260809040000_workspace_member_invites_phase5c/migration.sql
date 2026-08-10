-- Classworks 2.0 phase 5C: allow teachers to be assigned by email before
-- their first OAuth login. relationMode="prisma" intentionally omits FKs.

CREATE TABLE "WorkspaceMemberInvite" (
    "id" VARCHAR(191) NOT NULL,
    "workspaceId" VARCHAR(191) NOT NULL,
    "email" VARCHAR(191) NOT NULL,
    "normalizedEmail" VARCHAR(191) NOT NULL,
    "role" "WorkspaceMemberRole" NOT NULL DEFAULT 'TEACHER',
    "invitedByAccountId" VARCHAR(191) NOT NULL,
    "claimedByAccountId" VARCHAR(191),
    "claimedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMemberInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WorkspaceMemberInvite_workspaceId_normalizedEmail_key"
    ON "WorkspaceMemberInvite"("workspaceId", "normalizedEmail");
CREATE INDEX "WorkspaceMemberInvite_normalizedEmail_claimedAt_idx"
    ON "WorkspaceMemberInvite"("normalizedEmail", "claimedAt");
CREATE INDEX "WorkspaceMemberInvite_invitedByAccountId_idx"
    ON "WorkspaceMemberInvite"("invitedByAccountId");
