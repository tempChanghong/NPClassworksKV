-- Classworks 2.0 phase 2: school-level administration membership.

CREATE TYPE "SchoolMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'VIEWER');

CREATE TABLE "SchoolMember" (
    "schoolId" VARCHAR(191) NOT NULL,
    "accountId" VARCHAR(191) NOT NULL,
    "role" "SchoolMemberRole" NOT NULL DEFAULT 'VIEWER',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolMember_pkey" PRIMARY KEY ("schoolId", "accountId")
);

CREATE INDEX "SchoolMember_accountId_role_idx" ON "SchoolMember"("accountId", "role");
