-- One-time upgrade of school weekly noise schedules, before the server starts.
-- Retain the legacy rows for history. Never overwrite an existing study policy,
-- including a grade policy already inherited by an otherwise unconfigured class.
BEGIN;
LOCK TABLE "NpepNoiseSchedulePolicy", "NpepStudySetting" IN SHARE ROW EXCLUSIVE MODE;

WITH migrated AS (
  INSERT INTO "NpepStudySetting"
    ("schoolId", "termId", "targetType", "targetId", "revision", "policy", "updatedBy", "updatedAt")
  SELECT legacy."schoolId", legacy."termId", legacy."targetType", legacy."targetId", 1,
    jsonb_build_object(
      'mode', legacy."policy"->>'mode',
      'settings', CASE WHEN legacy."policy"->>'mode' = 'Override' THEN jsonb_build_object(
        'schedule', jsonb_build_object(
          'timeZone', 'Asia/Shanghai',
          -- Weekly legacy rules had no date limits. Use the earlier of the old
          -- save date and yesterday in Beijing, so an overnight window already
          -- in progress on deployment does not lose its preceding start date.
          'effectiveFrom', to_char(GREATEST(DATE '2000-01-01', LEAST(
            (legacy."updatedAt" AT TIME ZONE 'Asia/Shanghai')::date,
            (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date - 1)), 'YYYY-MM-DD'),
          'effectiveTo', NULL,
          'rules', legacy."policy"->'rules',
          'exceptions', '[]'::jsonb),
        'examSchedule', jsonb_build_object('timeZone', 'Asia/Shanghai', 'effectiveFrom', '',
          'effectiveTo', NULL, 'rules', '[]'::jsonb, 'exceptions', '[]'::jsonb),
        'presentation', jsonb_build_object('noiseDisplay', 'StatusTrend', 'temporaryHideSeconds', 180),
        'homework', jsonb_build_object('enabled', true, 'sourceMode', 'OwnClass',
          'sourceClassIds', '[]'::jsonb, 'rotationSeconds', 60),
        'noise', jsonb_build_object('enabled', true, 'redLineDbfs', NULL, 'mediumLineDbfs', NULL,
          'disciplineCooldownSeconds', 600, 'highContinuousSeconds', 3),
        'photos', jsonb_build_object('enabled', false, 'continuousSeconds', 3, 'cooldownSeconds', 30,
          'retentionDays', 30, 'captureOnExit', true, 'extendedRetentionAcknowledged', false)
      ) ELSE NULL END),
    legacy."updatedBy", CURRENT_TIMESTAMP
  FROM "NpepNoiseSchedulePolicy" legacy
  JOIN "AcademicTerm" term ON term."id" = legacy."termId" AND term."schoolId" = legacy."schoolId"
  LEFT JOIN "Grade" grade ON legacy."targetType" = 'GRADE'
    AND grade."id" = legacy."targetId" AND grade."termId" = legacy."termId"
  LEFT JOIN "Workspace" classroom ON legacy."targetType" = 'CLASS'
    AND classroom."id" = legacy."targetId" AND classroom."termId" = legacy."termId" AND classroom."type" = 'ADMIN_CLASS'
  WHERE (grade."id" IS NOT NULL OR classroom."id" IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM "NpepStudySetting" current
      WHERE current."schoolId" = legacy."schoolId" AND current."termId" = legacy."termId"
        AND current."targetType" = legacy."targetType" AND current."targetId" = legacy."targetId"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "NpepStudySetting" current_grade
      WHERE legacy."targetType" = 'CLASS' AND current_grade."schoolId" = legacy."schoolId"
        AND current_grade."termId" = legacy."termId" AND current_grade."targetType" = 'GRADE'
        AND current_grade."targetId" = classroom."gradeId"
    )
  ON CONFLICT ("schoolId", "termId", "targetType", "targetId") DO NOTHING
  RETURNING "schoolId", "targetId"
)
INSERT INTO "NpepAudit" ("id", "schoolId", "actorId", "objectId", "action")
SELECT gen_random_uuid(), "schoolId", NULL, "targetId", 'NOISE_SCHEDULE_MIGRATED' FROM migrated;

COMMIT;
