-- CreateTable
CREATE TABLE "AllowedDashboardIP" (
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

-- CreateTable
CREATE TABLE "DashboardAccessLog" (
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
CREATE UNIQUE INDEX "AllowedDashboardIP_ipAddress_key" ON "AllowedDashboardIP"("ipAddress");

-- CreateIndex
CREATE INDEX "AllowedDashboardIP_ipAddress_idx" ON "AllowedDashboardIP"("ipAddress");

-- CreateIndex
CREATE INDEX "AllowedDashboardIP_isActive_idx" ON "AllowedDashboardIP"("isActive");

-- CreateIndex
CREATE INDEX "DashboardAccessLog_createdAt_idx" ON "DashboardAccessLog"("createdAt");

-- CreateIndex
CREATE INDEX "DashboardAccessLog_status_createdAt_idx" ON "DashboardAccessLog"("status", "createdAt");

-- CreateIndex
CREATE INDEX "DashboardAccessLog_ipAddress_idx" ON "DashboardAccessLog"("ipAddress");
