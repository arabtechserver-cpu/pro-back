-- Reapply idempotent DDL because the former entrypoint marked it applied without running it.
-- Preserve the old migration checksum. Any conflict aborts deployment for investigation.
BEGIN;
-- ==============================================================================
-- Migration: 20260920000000_security_and_hardening
-- Complete, Idempotent Baseline & Hardening Migration for Arab Tech Pro
-- Guarantees 100% schema alignment for new and existing production environments
-- ==============================================================================

-- 1. Create Tables (Idempotent: Safe on fresh DB and existing DB)

CREATE TABLE IF NOT EXISTS "AnalyticsEvent" (
    "id" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "sessionId" TEXT,
    "path" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "BlogPost" (
    "id" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "excerptEn" TEXT NOT NULL,
    "excerptAr" TEXT NOT NULL,
    "contentEn" TEXT NOT NULL,
    "contentAr" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlogPost_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DhruCategory" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DhruCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ApiProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "apiUrl" TEXT NOT NULL,
    "username" TEXT,
    "apiKey" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'dhru',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "servicesCount" INTEGER NOT NULL DEFAULT 0,
    "mappingRules" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiProvider_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DhruService" (
    "id" TEXT NOT NULL,
    "dhruId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "credit" DOUBLE PRECISION NOT NULL,
    "time" TEXT NOT NULL,
    "info" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "margin" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "categoryId" TEXT,
    "providerId" TEXT,
    "api_service_type" TEXT,
    "requiresCustom" TEXT,
    "originalPrice" DOUBLE PRECISION,
    "supportsQty" BOOLEAN NOT NULL DEFAULT false,
    "minQty" INTEGER NOT NULL DEFAULT 1,
    "maxQty" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DhruService_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StoredImage" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'image/jpeg',
    "data" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredImage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Subscriber" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "source" TEXT DEFAULT 'website',
    "lastNotifiedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscriber_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "NewsletterBroadcast" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "category" TEXT,
    "actionUrl" TEXT,
    "actionText" TEXT,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NewsletterBroadcast_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "MembershipTier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT,
    "minDeposit" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "discountPercentage" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "badgeColor" TEXT DEFAULT '#2dd4bf',
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MembershipTier_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "phone" TEXT,
    "country" TEXT NOT NULL DEFAULT 'EG',
    "role" TEXT NOT NULL DEFAULT 'user',
    "status" TEXT NOT NULL DEFAULT 'active',
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "membershipTierId" TEXT,
    "customDiscount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "googleSub" TEXT,
    "tokenVersion" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "apiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "apiKey" TEXT,
    "apiSiteName" TEXT,
    "apiSiteUrl" TEXT,
    "apiMargin" DOUBLE PRECISION NOT NULL DEFAULT 0.0,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Order" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "serviceName" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "targetInput" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "price" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "apiOrderId" TEXT,
    "reply" TEXT,
    "notes" TEXT,
    "couponCode" TEXT,
    "discount" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "refundedAt" TIMESTAMP(3),
    "refundRefNo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'web',
    "apiClientOrderId" TEXT,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Transaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "refNo" TEXT NOT NULL,
    "receiptImage" TEXT,
    "adminActorId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PaymentIntent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'paypal',
    "orderId" TEXT NOT NULL,
    "captureId" TEXT,
    "amount" DOUBLE PRECISION NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'created',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VideoSeries" (
    "id" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "descriptionAr" TEXT,
    "thumbnail" TEXT,
    "isSubscriptionRequired" BOOLEAN NOT NULL DEFAULT false,
    "price" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoSeries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "VideoTutorial" (
    "id" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "descriptionEn" TEXT,
    "descriptionAr" TEXT,
    "videoUrl" TEXT NOT NULL,
    "thumbnail" TEXT,
    "category" TEXT,
    "seriesId" TEXT,
    "orderIndex" INTEGER NOT NULL DEFAULT 0,
    "isFreePreview" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VideoTutorial_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WalletTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletTransaction_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "discountPercent" DOUBLE PRECISION NOT NULL,
    "durationDays" INTEGER,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "maxUses" INTEGER NOT NULL DEFAULT 1,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CouponUsage" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT,
    "discount" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponUsage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AllowedDashboardIP" (
    "id" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessAt" TIMESTAMP(3),

    CONSTRAINT "AllowedDashboardIP_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AllowedDashboardDevice" (
    "id" TEXT NOT NULL,
    "deviceToken" TEXT NOT NULL,
    "fingerprint" TEXT,
    "label" TEXT,
    "localIp" TEXT,
    "lastIp" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAccessAt" TIMESTAMP(3),

    CONSTRAINT "AllowedDashboardDevice_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "DashboardAccessLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "username" TEXT,
    "ipAddress" TEXT NOT NULL,
    "localIp" TEXT,
    "deviceToken" TEXT,
    "userAgent" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DashboardAccessLog_pkey" PRIMARY KEY ("id")
);

-- 2. Alter Existing Tables to Add Any Potentially Missing Columns

-- User columns
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "fullName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "email" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "username" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "password" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "country" TEXT DEFAULT 'EG';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "role" TEXT DEFAULT 'user';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'active';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "balance" DOUBLE PRECISION DEFAULT 0.0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "membershipTierId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "customDiscount" DOUBLE PRECISION DEFAULT 0.0;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleSub" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "apiEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "apiKey" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "apiSiteName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "apiSiteUrl" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "apiMargin" DOUBLE PRECISION NOT NULL DEFAULT 0.0;

-- Order columns
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "userId" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "serviceName" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "serviceId" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "targetInput" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "quantity" INTEGER DEFAULT 1;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "price" DOUBLE PRECISION;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'pending';
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "apiOrderId" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "reply" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "couponCode" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "discount" DOUBLE PRECISION DEFAULT 0.0;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "refundRefNo" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "source" TEXT DEFAULT 'web';
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "apiClientOrderId" TEXT;

-- Transaction columns
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "userId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "type" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "amount" DOUBLE PRECISION;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "method" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'pending';
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "refNo" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "receiptImage" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "adminActorId" TEXT;
ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "notes" TEXT;

-- DhruService columns
ALTER TABLE "DhruService" ADD COLUMN IF NOT EXISTS "api_service_type" TEXT;
ALTER TABLE "DhruService" ADD COLUMN IF NOT EXISTS "requiresCustom" TEXT;
ALTER TABLE "DhruService" ADD COLUMN IF NOT EXISTS "originalPrice" DOUBLE PRECISION;
ALTER TABLE "DhruService" ADD COLUMN IF NOT EXISTS "supportsQty" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DhruService" ADD COLUMN IF NOT EXISTS "minQty" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "DhruService" ADD COLUMN IF NOT EXISTS "maxQty" INTEGER NOT NULL DEFAULT 0;

-- DashboardAccessLog columns
ALTER TABLE "DashboardAccessLog" ADD COLUMN IF NOT EXISTS "localIp" TEXT;
ALTER TABLE "DashboardAccessLog" ADD COLUMN IF NOT EXISTS "deviceToken" TEXT;

-- 3. Create Unique Indexes & Performance Indexes

CREATE UNIQUE INDEX IF NOT EXISTS "DhruService_dhruId_key" ON "DhruService"("dhruId");
CREATE UNIQUE INDEX IF NOT EXISTS "Subscriber_email_key" ON "Subscriber"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX IF NOT EXISTS "User_googleSub_key" ON "User"("googleSub");
CREATE UNIQUE INDEX IF NOT EXISTS "User_apiKey_key" ON "User"("apiKey");
CREATE UNIQUE INDEX IF NOT EXISTS "Coupon_code_key" ON "Coupon"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "CouponUsage_couponId_userId_key" ON "CouponUsage"("couponId", "userId");
CREATE UNIQUE INDEX IF NOT EXISTS "AllowedDashboardIP_ipAddress_key" ON "AllowedDashboardIP"("ipAddress");
CREATE UNIQUE INDEX IF NOT EXISTS "AllowedDashboardDevice_deviceToken_key" ON "AllowedDashboardDevice"("deviceToken");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentIntent_provider_orderId_key" ON "PaymentIntent"("provider", "orderId");
CREATE UNIQUE INDEX IF NOT EXISTS "PaymentIntent_provider_captureId_key" ON "PaymentIntent"("provider", "captureId");

CREATE INDEX IF NOT EXISTS "Order_userId_idx" ON "Order"("userId");
CREATE INDEX IF NOT EXISTS "Order_status_idx" ON "Order"("status");
CREATE INDEX IF NOT EXISTS "Order_apiOrderId_idx" ON "Order"("apiOrderId");
CREATE INDEX IF NOT EXISTS "Order_apiClientOrderId_idx" ON "Order"("apiClientOrderId");

CREATE INDEX IF NOT EXISTS "Transaction_refNo_idx" ON "Transaction"("refNo");
CREATE INDEX IF NOT EXISTS "Transaction_createdAt_idx" ON "Transaction"("createdAt");
CREATE INDEX IF NOT EXISTS "Transaction_status_createdAt_idx" ON "Transaction"("status", "createdAt");

CREATE INDEX IF NOT EXISTS "PaymentIntent_userId_idx" ON "PaymentIntent"("userId");
CREATE INDEX IF NOT EXISTS "PaymentIntent_status_idx" ON "PaymentIntent"("status");

CREATE INDEX IF NOT EXISTS "AllowedDashboardIP_ipAddress_idx" ON "AllowedDashboardIP"("ipAddress");
CREATE INDEX IF NOT EXISTS "AllowedDashboardIP_isActive_idx" ON "AllowedDashboardIP"("isActive");

CREATE INDEX IF NOT EXISTS "AllowedDashboardDevice_deviceToken_idx" ON "AllowedDashboardDevice"("deviceToken");
CREATE INDEX IF NOT EXISTS "AllowedDashboardDevice_isActive_idx" ON "AllowedDashboardDevice"("isActive");

CREATE INDEX IF NOT EXISTS "DashboardAccessLog_createdAt_idx" ON "DashboardAccessLog"("createdAt");
CREATE INDEX IF NOT EXISTS "DashboardAccessLog_status_createdAt_idx" ON "DashboardAccessLog"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "DashboardAccessLog_ipAddress_idx" ON "DashboardAccessLog"("ipAddress");
CREATE INDEX IF NOT EXISTS "DashboardAccessLog_deviceToken_idx" ON "DashboardAccessLog"("deviceToken");

-- 4. Safe Foreign Key Constraints

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DhruService_categoryId_fkey') THEN
        ALTER TABLE "DhruService" ADD CONSTRAINT "DhruService_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "DhruCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'DhruService_providerId_fkey') THEN
        ALTER TABLE "DhruService" ADD CONSTRAINT "DhruService_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "ApiProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Order_userId_fkey') THEN
        ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Transaction_userId_fkey') THEN
        ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PaymentIntent_userId_fkey') THEN
        ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_membershipTierId_fkey') THEN
        ALTER TABLE "User" ADD CONSTRAINT "User_membershipTierId_fkey" FOREIGN KEY ("membershipTierId") REFERENCES "MembershipTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'VideoTutorial_seriesId_fkey') THEN
        ALTER TABLE "VideoTutorial" ADD CONSTRAINT "VideoTutorial_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "VideoSeries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CouponUsage_couponId_fkey') THEN
        ALTER TABLE "CouponUsage" ADD CONSTRAINT "CouponUsage_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CouponUsage_userId_fkey') THEN
        ALTER TABLE "CouponUsage" ADD CONSTRAINT "CouponUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

COMMIT;
