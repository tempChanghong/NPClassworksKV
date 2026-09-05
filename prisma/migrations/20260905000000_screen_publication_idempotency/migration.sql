-- Creation identity stays unchanged when an assignment is edited or certified.
ALTER TABLE "Publication"
  ADD COLUMN "creationScreenBindingId" VARCHAR(191),
  ADD COLUMN "creationRequestId" VARCHAR(100),
  ADD COLUMN "creationRequestHash" VARCHAR(64);

CREATE UNIQUE INDEX "Publication_creationScreenBindingId_creationRequestId_key"
  ON "Publication"("creationScreenBindingId", "creationRequestId");
