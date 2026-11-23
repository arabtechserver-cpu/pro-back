UPDATE "CashierPlan"
SET "discountUntil" = ("createdAt" AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'UTC') + INTERVAL '10 days'
WHERE "id" = '3a3f5c9c-6cf7-4bed-883d-710623943cf9'
  AND "currency" = 'USD'
  AND "amountMinor" = 6000
  AND "promoAmountMinor" = 5000
  AND "discountUntil" = ("createdAt" AT TIME ZONE current_setting('TimeZone') AT TIME ZONE 'UTC') + INTERVAL '1 month';
