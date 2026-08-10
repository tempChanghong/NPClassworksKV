CREATE TYPE "TeacherAuthMode" AS ENUM ('LOCAL_PIN', 'SHARED_PASSWORD', 'OAUTH_EMAIL');

ALTER TABLE "Account"
    ADD COLUMN "localUsername" VARCHAR(64),
    ADD COLUMN "localPasswordHash" VARCHAR(191),
    ADD COLUMN "localLoginFailures" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "localLockedUntil" TIMESTAMPTZ(6),
    ADD COLUMN "localDisabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "lastLoginAt" TIMESTAMPTZ(6);

ALTER TABLE "School"
    ADD COLUMN "teacherAuthMode" "TeacherAuthMode" NOT NULL DEFAULT 'LOCAL_PIN',
    ADD COLUMN "allowOAuthTeacherLogin" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "teacherSharedPasswordHash" VARCHAR(191);
