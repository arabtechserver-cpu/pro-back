CREATE TABLE "CashierPurchase" (
    "id" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "licenseId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashierPurchase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CashierPurchase_licenseId_key" ON "CashierPurchase"("licenseId");
CREATE UNIQUE INDEX "CashierPurchase_transactionId_key" ON "CashierPurchase"("transactionId");
CREATE UNIQUE INDEX "CashierPurchase_buyerId_requestId_key" ON "CashierPurchase"("buyerId", "requestId");
CREATE INDEX "CashierPurchase_buyerId_createdAt_idx" ON "CashierPurchase"("buyerId", "createdAt");

ALTER TABLE "CashierPurchase" ADD CONSTRAINT "CashierPurchase_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashierPurchase" ADD CONSTRAINT "CashierPurchase_licenseId_fkey" FOREIGN KEY ("licenseId") REFERENCES "CashierLicense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CashierPurchase" ADD CONSTRAINT "CashierPurchase_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
