CREATE TABLE "NpepClassManagement" ("schoolId" varchar(191) NOT NULL,"classId" varchar(191) NOT NULL,revision bigint NOT NULL CHECK(revision>0),verifier jsonb NOT NULL,"updatedAt" timestamptz(3) NOT NULL,PRIMARY KEY("schoolId","classId"));
CREATE TABLE "NpepManagementRequest" ("schoolId" varchar(191) NOT NULL,"requestId" uuid NOT NULL,data jsonb NOT NULL,PRIMARY KEY("schoolId","requestId"));
CREATE TABLE "NpepEquipmentPolicy" ("deviceId" uuid PRIMARY KEY,data jsonb NOT NULL);
CREATE TABLE "NpepEquipmentInventory" ("deviceId" uuid PRIMARY KEY,data jsonb NOT NULL);
