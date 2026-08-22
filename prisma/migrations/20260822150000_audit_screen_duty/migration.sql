ALTER TABLE "ClassroomScreenBinding"
    ADD COLUMN "lastHeartbeatAt" TIMESTAMPTZ(6),
    ADD COLUMN "runtimeStatus" JSONB;

CREATE TABLE "AuditLog" (
    "id" VARCHAR(191) NOT NULL,
    "schoolId" VARCHAR(191),
    "actorAccountId" VARCHAR(191),
    "actorScreenBindingId" VARCHAR(191),
    "actorType" VARCHAR(32) NOT NULL,
    "action" VARCHAR(96) NOT NULL,
    "entityType" VARCHAR(64),
    "entityId" VARCHAR(191),
    "requestMethod" VARCHAR(16),
    "requestPath" VARCHAR(512),
    "statusCode" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "summary" VARCHAR(512),
    "metadata" JSONB,
    "clientIp" VARCHAR(64),
    "userAgent" VARCHAR(512),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AuditLog_schoolId_createdAt_idx" ON "AuditLog"("schoolId", "createdAt");
CREATE INDEX "AuditLog_actorAccountId_createdAt_idx" ON "AuditLog"("actorAccountId", "createdAt");
CREATE INDEX "AuditLog_actorScreenBindingId_createdAt_idx" ON "AuditLog"("actorScreenBindingId", "createdAt");
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

CREATE TABLE "ClassroomScreenCommand" (
    "id" VARCHAR(191) NOT NULL,
    "screenBindingId" VARCHAR(191) NOT NULL,
    "issuedByAccountId" VARCHAR(191) NOT NULL,
    "type" VARCHAR(32) NOT NULL,
    "status" VARCHAR(24) NOT NULL DEFAULT 'PENDING',
    "payload" JSONB,
    "result" JSONB,
    "deliveredAt" TIMESTAMPTZ(6),
    "acknowledgedAt" TIMESTAMPTZ(6),
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClassroomScreenCommand_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClassroomScreenCommand_screenBindingId_status_expiresAt_idx"
    ON "ClassroomScreenCommand"("screenBindingId", "status", "expiresAt");
CREATE INDEX "ClassroomScreenCommand_issuedByAccountId_createdAt_idx"
    ON "ClassroomScreenCommand"("issuedByAccountId", "createdAt");
