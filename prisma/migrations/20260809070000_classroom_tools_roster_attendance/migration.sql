-- Classroom tools: administrative-class roster and daily attendance snapshots.

CREATE TABLE "AdministrativeClassStudent" (
    "id" VARCHAR(191) NOT NULL,
    "administrativeClassId" VARCHAR(191) NOT NULL,
    "studentNumber" VARCHAR(64),
    "name" VARCHAR(64) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdministrativeClassStudent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClassAttendanceDay" (
    "administrativeClassId" VARCHAR(191) NOT NULL,
    "attendanceDate" DATE NOT NULL,
    "attendance" JSON NOT NULL,
    "updatedByAccountId" VARCHAR(191),
    "updatedByScreenBindingId" VARCHAR(191),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassAttendanceDay_pkey" PRIMARY KEY ("administrativeClassId", "attendanceDate")
);

CREATE INDEX "AdministrativeClassStudent_administrativeClassId_isActive_sortOrder_idx"
    ON "AdministrativeClassStudent"("administrativeClassId", "isActive", "sortOrder");
CREATE INDEX "AdministrativeClassStudent_administrativeClassId_studentNumber_idx"
    ON "AdministrativeClassStudent"("administrativeClassId", "studentNumber");
CREATE INDEX "ClassAttendanceDay_updatedByAccountId_idx"
    ON "ClassAttendanceDay"("updatedByAccountId");
CREATE INDEX "ClassAttendanceDay_updatedByScreenBindingId_idx"
    ON "ClassAttendanceDay"("updatedByScreenBindingId");
CREATE INDEX "ClassAttendanceDay_administrativeClassId_idx"
    ON "ClassAttendanceDay"("administrativeClassId");
