BEGIN;

ALTER TABLE "CashierPlan" ADD COLUMN "promoAmountMinor" INTEGER;

INSERT INTO "CashierPlan"
  ("id", "name", "amountMinor", "currency", "durationDays", "promoAmountMinor", "discountUntil")
VALUES
  ('bd5ceee2-76df-4b44-beec-8714aa192b16', 'باقة شهر', 800, 'USD', 30, 500, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 month'),
  ('9fa9d018-7dde-4050-9c3a-0f8a22203de4', 'باقة ٣ شهور', 2500, 'USD', 90, 2000, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 month'),
  ('3a3f5c9c-6cf7-4bed-883d-710623943cf9', 'الباقة السنوية', 6000, 'USD', 365, 5000, (CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 month')
ON CONFLICT ("id") DO NOTHING;

COMMIT;
