-- Classworks 2.0 phase 6: classroom-screen contributions, immutable revisions,
-- teacher certification and restorable publication history.

CREATE TYPE "PublicationActorType" AS ENUM ('ACCOUNT', 'CLASSROOM_SCREEN', 'SYSTEM');
CREATE TYPE "PublicationRevisionAction" AS ENUM ('CREATED', 'UPDATED', 'RESTORED', 'WITHDRAWN');

ALTER TABLE "Publication"
    ALTER COLUMN "authorAccountId" DROP NOT NULL,
    ADD COLUMN "isCertified" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "certifiedByAccountId" VARCHAR(191),
    ADD COLUMN "certifiedAt" TIMESTAMPTZ(6),
    ADD COLUMN "latestActorType" "PublicationActorType" NOT NULL DEFAULT 'ACCOUNT',
    ADD COLUMN "latestScreenBindingId" VARCHAR(191);

UPDATE "Publication"
SET
    "certifiedByAccountId" = "authorAccountId",
    "certifiedAt" = "createdAt";

CREATE TABLE "ClassroomScreenBinding" (
    "id" VARCHAR(191) NOT NULL,
    "schoolId" VARCHAR(191) NOT NULL,
    "administrativeClassId" VARCHAR(191) NOT NULL,
    "deviceFingerprint" VARCHAR(191) NOT NULL,
    "name" VARCHAR(191) NOT NULL,
    "tokenHash" VARCHAR(64) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastUsedAt" TIMESTAMPTZ(6),
    "createdByAccountId" VARCHAR(191) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassroomScreenBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PublicationRevision" (
    "id" VARCHAR(191) NOT NULL,
    "publicationId" VARCHAR(191) NOT NULL,
    "revision" INTEGER NOT NULL,
    "snapshot" JSON NOT NULL,
    "action" "PublicationRevisionAction" NOT NULL,
    "actorType" "PublicationActorType" NOT NULL,
    "editorAccountId" VARCHAR(191),
    "screenBindingId" VARCHAR(191),
    "restoredFromRevision" INTEGER,
    "isCertified" BOOLEAN NOT NULL DEFAULT false,
    "certifiedByAccountId" VARCHAR(191),
    "certifiedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicationRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ClassroomScreenBinding_tokenHash_key" ON "ClassroomScreenBinding"("tokenHash");
CREATE UNIQUE INDEX "ClassroomScreenBinding_schoolId_deviceFingerprint_key" ON "ClassroomScreenBinding"("schoolId", "deviceFingerprint");
CREATE INDEX "ClassroomScreenBinding_administrativeClassId_isActive_idx" ON "ClassroomScreenBinding"("administrativeClassId", "isActive");
CREATE UNIQUE INDEX "PublicationRevision_publicationId_revision_key" ON "PublicationRevision"("publicationId", "revision");
CREATE INDEX "PublicationRevision_publicationId_createdAt_idx" ON "PublicationRevision"("publicationId", "createdAt");
CREATE INDEX "PublicationRevision_screenBindingId_createdAt_idx" ON "PublicationRevision"("screenBindingId", "createdAt");
CREATE INDEX "Publication_isCertified_updatedAt_idx" ON "Publication"("isCertified", "updatedAt");
CREATE INDEX "Publication_latestScreenBindingId_idx" ON "Publication"("latestScreenBindingId");

-- Existing authenticated publications become certified revision 1 snapshots.
INSERT INTO "PublicationRevision" (
    "id",
    "publicationId",
    "revision",
    "snapshot",
    "action",
    "actorType",
    "editorAccountId",
    "isCertified",
    "certifiedByAccountId",
    "certifiedAt",
    "createdAt"
)
SELECT
    CONCAT('migration-', "Publication"."id"),
    "Publication"."id",
    "Publication"."revision",
    json_build_object(
        'type', "Publication"."type",
        'subjectId', "Publication"."subjectId",
        'title', "Publication"."title",
        'content', "Publication"."content",
        'contentJson', "Publication"."contentJson",
        'publishAt', "Publication"."publishAt",
        'dueAt', "Publication"."dueAt",
        'expiresAt', "Publication"."expiresAt",
        'priority', "Publication"."priority",
        'status', "Publication"."status",
        'targetWorkspaceIds', COALESCE((
            SELECT json_agg("PublicationTarget"."workspaceId" ORDER BY "PublicationTarget"."workspaceId")
            FROM "PublicationTarget"
            WHERE "PublicationTarget"."publicationId" = "Publication"."id"
        ), '[]'::json)
    ),
    CASE WHEN "Publication"."status" = 'WITHDRAWN' THEN 'WITHDRAWN' ELSE 'CREATED' END::"PublicationRevisionAction",
    'ACCOUNT'::"PublicationActorType",
    "Publication"."authorAccountId",
    true,
    "Publication"."authorAccountId",
    "Publication"."createdAt",
    "Publication"."createdAt"
FROM "Publication";
