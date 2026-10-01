CREATE TABLE "NpepNoiseDevice" (
  "deviceId" UUID PRIMARY KEY REFERENCES "NpepDevice"("id") ON DELETE CASCADE,
  "data" JSONB NOT NULL
);
