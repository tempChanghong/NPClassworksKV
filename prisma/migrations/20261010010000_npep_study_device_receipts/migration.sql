-- Receipts only. Does not enable native capture or change any school schedule.
CREATE TABLE "NpepStudyDevice" (
  "deviceId" UUID NOT NULL,
  "data" JSONB NOT NULL,
  CONSTRAINT "NpepStudyDevice_pkey" PRIMARY KEY ("deviceId"),
  CONSTRAINT "NpepStudyDevice_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "NpepDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
