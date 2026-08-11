-- Assignments belong to a calendar day on the classroom homework board.
-- Notices intentionally keep board_date NULL because they remain active overlays.
ALTER TABLE "Publication" ADD COLUMN "boardDate" DATE;

UPDATE "Publication"
SET "boardDate" = ("publishAt" AT TIME ZONE 'Asia/Shanghai')::date
WHERE "type" = 'ASSIGNMENT' AND "boardDate" IS NULL;

UPDATE "PublicationRevision"
SET "snapshot" = jsonb_set(
  "snapshot"::jsonb,
  '{boardDate}',
  to_jsonb((("snapshot"->>'publishAt')::timestamptz AT TIME ZONE 'Asia/Shanghai')::date::text),
  true
)::json
WHERE "snapshot"->>'type' = 'ASSIGNMENT'
  AND NOT ("snapshot"::jsonb ? 'boardDate')
  AND NULLIF("snapshot"->>'publishAt', '') IS NOT NULL;

CREATE INDEX "Publication_status_boardDate_publishAt_idx"
ON "Publication"("status", "boardDate", "publishAt");
