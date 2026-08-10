-- Retain an audit shell when old, uncertified backups for disabled teaching
-- spaces are purged by the three-day cleanup policy.

ALTER TABLE "PublicationRevision"
    ADD COLUMN "purgedAt" TIMESTAMPTZ(6);

CREATE INDEX "PublicationRevision_isCertified_purgedAt_createdAt_idx"
    ON "PublicationRevision"("isCertified", "purgedAt", "createdAt");
