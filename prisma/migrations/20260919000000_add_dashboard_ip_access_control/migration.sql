-- CreateTable AllowedDashboardIP
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

-- CreateTable DashboardAccessLog
CREATE TABLE IF NOT EXISTS "DashboardAccessLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "username" TEXT,
    "ipAddress" TEXT NOT NULL,
    "userAgent" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DashboardAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "AllowedDashboardIP_ipAddress_key" ON "AllowedDashboardIP"("ipAddress");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AllowedDashboardIP_ipAddress_idx" ON "AllowedDashboardIP"("ipAddress");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AllowedDashboardIP_isActive_idx" ON "AllowedDashboardIP"("isActive");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DashboardAccessLog_createdAt_idx" ON "DashboardAccessLog"("createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DashboardAccessLog_status_createdAt_idx" ON "DashboardAccessLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "DashboardAccessLog_ipAddress_idx" ON "DashboardAccessLog"("ipAddress");
