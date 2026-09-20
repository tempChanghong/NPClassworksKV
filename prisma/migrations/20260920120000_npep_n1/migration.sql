ALTER TABLE "ClassroomScreenBinding" ADD COLUMN "npepBindingRevision" DOUBLE PRECISION NOT NULL DEFAULT 1
 CHECK ("npepBindingRevision" BETWEEN 1 AND 9007199254740991 AND "npepBindingRevision" = floor("npepBindingRevision"));

CREATE TABLE "NpepDeployment" (
 "id" TEXT PRIMARY KEY, "serverInstanceId" UUID NOT NULL, "deploymentEpoch" UUID NOT NULL
);
CREATE TABLE "NpepPairing" (
 "id" UUID PRIMARY KEY, "installationId" UUID NOT NULL, "requestId" UUID NOT NULL,
 "createDigest" VARCHAR(64) NOT NULL, "secretHash" VARCHAR(64), "userCode" VARCHAR(8) NOT NULL,
 "deviceName" VARCHAR(256) NOT NULL, "appVersion" VARCHAR(256) NOT NULL,
 "serverInstanceId" UUID NOT NULL, "deploymentEpoch" UUID NOT NULL,
 "state" VARCHAR(16) NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING','APPROVED','ACTIVATED','CANCELLED')),
 "expiresAt" TIMESTAMPTZ(3) NOT NULL, "schoolId" VARCHAR(191), "screenBindingId" VARCHAR(191),
 "approvalId" UUID, "approvalRequestId" UUID, "approvalDigest" VARCHAR(64), "approverId" VARCHAR(191),
 "approverSessionId" VARCHAR(191), "approverTokenVersion" INTEGER, "approvalSnapshot" JSONB,
 "confirmRequestId" UUID, "confirmDigest" VARCHAR(64), "deviceId" UUID,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "NpepPairing_userCode_key" ON "NpepPairing"("userCode");
CREATE UNIQUE INDEX "NpepPairing_installationId_requestId_key" ON "NpepPairing"("installationId","requestId");
CREATE INDEX "NpepPairing_expiresAt_idx" ON "NpepPairing"("expiresAt");
CREATE INDEX "NpepPairing_screenBindingId_state_idx" ON "NpepPairing"("screenBindingId","state");
CREATE TABLE "NpepDevice" (
 "id" UUID PRIMARY KEY, "installationId" UUID NOT NULL, "credentialId" UUID NOT NULL, "secretHash" VARCHAR(64) NOT NULL,
 "serverInstanceId" UUID NOT NULL, "deploymentEpoch" UUID NOT NULL,
 "schoolId" VARCHAR(191) NOT NULL, "administrativeClassId" VARCHAR(191) NOT NULL, "screenBindingId" VARCHAR(191) NOT NULL,
 "bindingRevision" DOUBLE PRECISION NOT NULL CHECK ("bindingRevision" BETWEEN 1 AND 9007199254740991 AND "bindingRevision" = floor("bindingRevision")),
 "deviceName" VARCHAR(256) NOT NULL, "state" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK ("state" IN ('ACTIVE','REVOKED','EXPIRED','INVALIDATED')),
 "credentialExpiresAt" TIMESTAMPTZ(3) NOT NULL,
 "statusEpoch" DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK ("statusEpoch" BETWEEN 0 AND 9007199254740991 AND "statusEpoch" = floor("statusEpoch")),
 "sessionId" UUID, "lastSequence" DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK ("lastSequence" BETWEEN 0 AND 9007199254740991 AND "lastSequence" = floor("lastSequence")),
 "lastStatusDigest" VARCHAR(64), "lastSeenAt" TIMESTAMPTZ(3), "status" JSONB,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "revokedAt" TIMESTAMPTZ(3)
);
CREATE UNIQUE INDEX "NpepDevice_credentialId_key" ON "NpepDevice"("credentialId");
CREATE UNIQUE INDEX "NpepDevice_active_binding_key" ON "NpepDevice"("screenBindingId") WHERE "state" = 'ACTIVE';
CREATE INDEX "NpepDevice_schoolId_id_idx" ON "NpepDevice"("schoolId","id");
CREATE INDEX "NpepDevice_screenBindingId_state_idx" ON "NpepDevice"("screenBindingId","state");
CREATE INDEX "NpepDevice_credentialExpiresAt_idx" ON "NpepDevice"("credentialExpiresAt");
CREATE TABLE "NpepSessionReceipt" (
 "deviceId" UUID NOT NULL, "requestId" UUID NOT NULL, "runId" UUID NOT NULL, "sessionId" UUID NOT NULL,
 "digest" VARCHAR(64) NOT NULL, "statusEpoch" DOUBLE PRECISION NOT NULL CHECK ("statusEpoch" BETWEEN 1 AND 9007199254740991 AND "statusEpoch" = floor("statusEpoch")),
 "expiresAt" TIMESTAMPTZ(3) NOT NULL, PRIMARY KEY ("deviceId","requestId")
);
CREATE UNIQUE INDEX "NpepSessionReceipt_sessionId_key" ON "NpepSessionReceipt"("sessionId");
CREATE UNIQUE INDEX "NpepSessionReceipt_deviceId_runId_key" ON "NpepSessionReceipt"("deviceId","runId");
CREATE INDEX "NpepSessionReceipt_expiresAt_idx" ON "NpepSessionReceipt"("expiresAt");
CREATE TABLE "NpepAudit" (
 "id" UUID PRIMARY KEY, "schoolId" VARCHAR(191), "actorId" VARCHAR(191), "objectId" VARCHAR(191) NOT NULL,
 "action" VARCHAR(48) NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "NpepAudit_createdAt_idx" ON "NpepAudit"("createdAt");
CREATE INDEX "NpepAudit_schoolId_createdAt_idx" ON "NpepAudit"("schoolId","createdAt");
CREATE TABLE "NpepRateLimit" ("key" VARCHAR(160) PRIMARY KEY, "count" INTEGER NOT NULL, "expiresAt" TIMESTAMPTZ(3) NOT NULL);
CREATE INDEX "NpepRateLimit_expiresAt_idx" ON "NpepRateLimit"("expiresAt");

-- Database lifecycle fences cover direct writes and all existing HTTP/import
-- paths. A binding lock precedes device locks in both NPEP and these triggers.
CREATE FUNCTION npep_revoke_binding(binding_id TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 WITH changed AS (
   UPDATE "NpepDevice" SET "state"='INVALIDATED', "revokedAt"=clock_timestamp(), "sessionId"=NULL
   WHERE "screenBindingId"=binding_id AND "state"='ACTIVE' RETURNING "id", "schoolId"
 ) INSERT INTO "NpepAudit"("id","schoolId","objectId","action")
 SELECT gen_random_uuid(), "schoolId", "id"::text, 'BINDING_INVALIDATED' FROM changed;
 UPDATE "NpepPairing" SET "state"='CANCELLED' WHERE "screenBindingId"=binding_id AND "state"='APPROVED';
END $$;

CREATE FUNCTION npep_binding_fence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
   PERFORM npep_revoke_binding(OLD.id);
   RETURN OLD;
 END IF;
 IF (OLD."isActive" AND NOT NEW."isActive") OR NEW."schoolId" IS DISTINCT FROM OLD."schoolId"
    OR NEW."administrativeClassId" IS DISTINCT FROM OLD."administrativeClassId" THEN
   NEW."npepBindingRevision" := OLD."npepBindingRevision" + 1;
 END IF;
 IF NEW."npepBindingRevision" IS DISTINCT FROM OLD."npepBindingRevision" THEN
   IF NEW."npepBindingRevision" <= OLD."npepBindingRevision" THEN RAISE EXCEPTION 'NPEP revision cannot decrease'; END IF;
   PERFORM npep_revoke_binding(OLD.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER npep_binding_fence BEFORE UPDATE OR DELETE ON "ClassroomScreenBinding" FOR EACH ROW EXECUTE FUNCTION npep_binding_fence();

CREATE FUNCTION npep_workspace_fence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE changed BOOLEAN;
BEGIN
 IF TG_OP='DELETE' THEN changed := TRUE;
 ELSE changed := (OLD."isActive" AND NOT NEW."isActive") OR OLD."termId" IS DISTINCT FROM NEW."termId" OR OLD."type" IS DISTINCT FROM NEW."type";
 END IF;
 IF changed THEN
   UPDATE "ClassroomScreenBinding" SET "npepBindingRevision"="npepBindingRevision"+1 WHERE "administrativeClassId"=OLD.id;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER npep_workspace_fence BEFORE UPDATE OR DELETE ON "Workspace" FOR EACH ROW EXECUTE FUNCTION npep_workspace_fence();

CREATE FUNCTION npep_term_fence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE changed BOOLEAN;
BEGIN
 IF TG_OP='DELETE' THEN changed := TRUE;
 ELSE changed := (OLD."status"='ACTIVE' AND NEW."status" <> 'ACTIVE') OR OLD."schoolId" IS DISTINCT FROM NEW."schoolId";
 END IF;
 IF changed THEN
   UPDATE "ClassroomScreenBinding" SET "npepBindingRevision"="npepBindingRevision"+1
   WHERE "administrativeClassId" IN (SELECT id FROM "Workspace" WHERE "termId"=OLD.id);
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER npep_term_fence BEFORE UPDATE OR DELETE ON "AcademicTerm" FOR EACH ROW EXECUTE FUNCTION npep_term_fence();

CREATE FUNCTION npep_school_fence() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 UPDATE "ClassroomScreenBinding" SET "npepBindingRevision"="npepBindingRevision"+1 WHERE "schoolId"=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER npep_school_fence BEFORE DELETE ON "School" FOR EACH ROW EXECUTE FUNCTION npep_school_fence();
