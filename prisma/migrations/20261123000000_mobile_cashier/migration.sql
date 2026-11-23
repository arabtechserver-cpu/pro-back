-- CreateTable
CREATE TABLE "CashierPlan" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "discountPercent" INTEGER NOT NULL DEFAULT 0,
    "discountUntil" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashierPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashierDevice" (
    "id" TEXT NOT NULL,
    "machineHash" TEXT NOT NULL,
    "proofHash" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "trialEndsAt" TIMESTAMP(3),
    "activeKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashierDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashierLicense" (
    "id" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "suffix" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "planId" TEXT NOT NULL,
    "deviceId" TEXT,
    "issuedBy" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashierLicense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashierSupportSession" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "notes" TEXT NOT NULL,
    "consentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "operatorId" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedBy" TEXT,

    CONSTRAINT "CashierSupportSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashierSupportMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashierSupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashierDevice_machineHash_key" ON "CashierDevice"("machineHash");

-- CreateIndex
CREATE UNIQUE INDEX "CashierDevice_activeKeyId_key" ON "CashierDevice"("activeKeyId");

-- CreateIndex
CREATE UNIQUE INDEX "CashierLicense_keyHash_key" ON "CashierLicense"("keyHash");

-- CreateIndex
CREATE INDEX "CashierLicense_deviceId_idx" ON "CashierLicense"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "CashierSupportSession_code_key" ON "CashierSupportSession"("code");

-- CreateIndex
CREATE INDEX "CashierSupportSession_deviceId_consentAt_idx" ON "CashierSupportSession"("deviceId", "consentAt");

-- CreateIndex
CREATE INDEX "CashierSupportMessage_sessionId_createdAt_idx" ON "CashierSupportMessage"("sessionId", "createdAt");

-- AddForeignKey
ALTER TABLE "CashierDevice" ADD CONSTRAINT "CashierDevice_activeKeyId_fkey" FOREIGN KEY ("activeKeyId") REFERENCES "CashierLicense"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashierLicense" ADD CONSTRAINT "CashierLicense_planId_fkey" FOREIGN KEY ("planId") REFERENCES "CashierPlan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashierLicense" ADD CONSTRAINT "CashierLicense_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CashierDevice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashierSupportSession" ADD CONSTRAINT "CashierSupportSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "CashierDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CashierSupportMessage" ADD CONSTRAINT "CashierSupportMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "CashierSupportSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
