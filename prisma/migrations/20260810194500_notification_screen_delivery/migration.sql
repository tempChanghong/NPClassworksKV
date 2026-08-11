CREATE TABLE "NotificationScreenDelivery" (
    "publicationId" VARCHAR(191) NOT NULL,
    "screenBindingId" VARCHAR(191) NOT NULL,
    "revision" INTEGER NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "displayedAt" TIMESTAMPTZ(6),
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationScreenDelivery_pkey" PRIMARY KEY ("publicationId", "screenBindingId")
);

CREATE INDEX "NotificationScreenDelivery_screenBindingId_updatedAt_idx"
    ON "NotificationScreenDelivery"("screenBindingId", "updatedAt");
