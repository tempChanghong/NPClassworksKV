-- Notices no longer remain visible forever when a teacher omits an expiry.
-- Existing notices receive the same three-day lifecycle as newly created ones.
UPDATE "Publication"
SET "expiresAt" = "publishAt" + INTERVAL '3 days'
WHERE "type" = 'NOTICE'
  AND "expiresAt" IS NULL;
