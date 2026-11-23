CREATE TABLE "CashierRepairTrack" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "localRepairId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "shopPhone" TEXT,
    "orderNumber" TEXT NOT NULL,
    "deviceType" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "quoteApprovalStatus" TEXT NOT NULL DEFAULT 'NOT_REQUIRED',
    "quoteNote" TEXT,
    "quoteRespondedAt" TIMESTAMP(3),
    "estimatedPrice" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "remainingAmount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "warrantyDays" INTEGER NOT NULL DEFAULT 30,
    "dueAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "orderCreatedAt" TIMESTAMP(3) NOT NULL,
    "timelineJson" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashierRepairTrack_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CashierRepairTrack_tokenHash_key" ON "CashierRepairTrack"("tokenHash");
CREATE UNIQUE INDEX "CashierRepairTrack_deviceId_localRepairId_key" ON "CashierRepairTrack"("deviceId", "localRepairId");
CREATE INDEX "CashierRepairTrack_deviceId_updatedAt_idx" ON "CashierRepairTrack"("deviceId", "updatedAt");

ALTER TABLE "CashierRepairTrack" ADD CONSTRAINT "CashierRepairTrack_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CashierDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
