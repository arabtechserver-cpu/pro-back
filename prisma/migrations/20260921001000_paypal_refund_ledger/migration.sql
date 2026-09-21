BEGIN;

ALTER TABLE "PaymentIntent" ADD COLUMN "refundedAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE "PaymentRefund" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paymentIntentId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentRefund_paymentIntentId_fkey" FOREIGN KEY ("paymentIntentId")
        REFERENCES "PaymentIntent"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PaymentRefund_resourceId_key" ON "PaymentRefund"("resourceId");
CREATE UNIQUE INDEX "PaymentRefund_eventId_key" ON "PaymentRefund"("eventId");
CREATE INDEX "PaymentRefund_paymentIntentId_idx" ON "PaymentRefund"("paymentIntentId");

-- Preserve refunds already debited by the old handler, including their event
-- IDs, so PayPal retries cannot debit the same historical event twice.
INSERT INTO "PaymentRefund" ("id", "paymentIntentId", "resourceId", "eventId", "amount", "currency", "createdAt")
SELECT 'legacy-' || t."id", p."id", 'legacy:' || t."id",
       substring(t."refNo" from length('PAYPAL_REVERSAL_' || p."captureId" || '_') + 1),
       t."amount", p."currency", t."createdAt"
FROM "PaymentIntent" p JOIN "Transaction" t
  ON t."userId" = p."userId"
 AND left(t."refNo", length('PAYPAL_REVERSAL_' || p."captureId" || '_')) = 'PAYPAL_REVERSAL_' || p."captureId" || '_'
WHERE p."provider" = 'paypal' AND p."status" = 'refunded'
  AND t."status" = 'completed' AND t."method" = 'PayPal Reversal'
ON CONFLICT DO NOTHING;

UPDATE "PaymentIntent" p
SET "refundedAmount" = LEAST(p."amount", COALESCE(
    (SELECT SUM(r."amount") FROM "PaymentRefund" r WHERE r."paymentIntentId" = p."id"), p."amount"))
WHERE p."provider" = 'paypal' AND p."status" = 'refunded';

UPDATE "PaymentIntent" SET "status" = 'partially_refunded'
WHERE "status" = 'refunded' AND "refundedAmount" < "amount";

COMMIT;
