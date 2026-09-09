-- Repair only a published notice's current account-authored revision. Notices
-- cannot be submitted by screens and have no subject certification workflow.
-- Keep content, revision numbers, update times and older history unchanged.
WITH corrected AS (
    UPDATE "Publication" AS p
    SET "isCertified" = TRUE,
        "certifiedByAccountId" = r."editorAccountId",
        "certifiedAt" = r."createdAt"
    FROM "PublicationRevision" AS r
    WHERE p."type" = 'NOTICE'
      AND p."status" = 'PUBLISHED'
      AND p."latestActorType" = 'ACCOUNT'
      AND p."isCertified" = FALSE
      AND r."publicationId" = p."id" AND r."revision" = p."revision"
      AND r."actorType" = 'ACCOUNT' AND r."isCertified" = FALSE
      AND r."snapshot"->>'type' = 'NOTICE'
      AND r."snapshot"->>'status' = 'PUBLISHED'
      AND r."purgedAt" IS NULL
      AND EXISTS (SELECT 1 FROM "Account" a WHERE a."id" = r."editorAccountId")
    RETURNING p."id", p."revision", p."certifiedByAccountId", p."certifiedAt"
)
UPDATE "PublicationRevision" AS r
SET "isCertified" = TRUE,
    "certifiedByAccountId" = c."certifiedByAccountId",
    "certifiedAt" = c."certifiedAt"
FROM corrected AS c
WHERE r."publicationId" = c."id" AND r."revision" = c."revision";
