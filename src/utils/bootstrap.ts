import { prisma } from "../utils/prisma";
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { syncDhruServices } from '../scripts/syncDhruServices';
import { extractQuantityLimits, enrichCustomFieldsWithQuantity } from './provider-quantity';
import { refreshAdminIds } from './telegramService';

export async function bootstrapDatabase() {
  try {
    console.log('[Bootstrap] Checking database status...');

    // 0. Auto-synchronize missing schema columns and tables before querying Prisma models
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "googleSub" TEXT;`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 1;`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "refundedAt" TIMESTAMP(3);`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "refundRefNo" TEXT;`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "source" TEXT DEFAULT 'web';`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "apiClientOrderId" TEXT;`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "adminActorId" TEXT;`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "Transaction" ADD COLUMN IF NOT EXISTS "notes" TEXT;`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "DashboardAccessLog" ADD COLUMN IF NOT EXISTS "localIp" TEXT;`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "DashboardAccessLog" ADD COLUMN IF NOT EXISTS "deviceToken" TEXT;`);

      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "PaymentIntent" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "provider" TEXT NOT NULL DEFAULT 'paypal',
            "orderId" TEXT NOT NULL,
            "captureId" TEXT,
            "amount" DOUBLE PRECISION NOT NULL,
            "currency" TEXT NOT NULL DEFAULT 'USD',
            "status" TEXT NOT NULL DEFAULT 'created',
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PaymentIntent_userId_idx" ON "PaymentIntent"("userId");`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "PaymentIntent_status_idx" ON "PaymentIntent"("status");`);
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "PaymentIntent_provider_orderId_key" ON "PaymentIntent"("provider", "orderId");`);
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "PaymentIntent_provider_captureId_key" ON "PaymentIntent"("provider", "captureId");`);

      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "AllowedDashboardDevice" (
            "id" TEXT NOT NULL PRIMARY KEY,
            "deviceToken" TEXT NOT NULL,
            "fingerprint" TEXT,
            "label" TEXT,
            "localIp" TEXT,
            "lastIp" TEXT,
            "isActive" BOOLEAN NOT NULL DEFAULT true,
            "createdBy" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            "lastAccessAt" TIMESTAMP(3)
        );
      `);
      await prisma.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "AllowedDashboardDevice_deviceToken_key" ON "AllowedDashboardDevice"("deviceToken");`);
      await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "AllowedDashboardDevice_deviceToken_idx" ON "AllowedDashboardDevice"("deviceToken");`);
      console.log('[Bootstrap] Initial schema columns verified and synchronized.');
    } catch (colErr) {
      console.warn('[Bootstrap] Notice during initial column synchronization:', colErr);
    }

    // 1. Check & Ensure Admin User exists
    const adminUser = await prisma.user.findFirst({
      where: {
        role: { in: ['admin', 'super_admin'] }
      }
    });

    if (!adminUser) {
      console.log('[Bootstrap] No admin user found. Creating initial admin user...');
      const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || crypto.randomBytes(12).toString('hex');
      const adminEmail = process.env.DEFAULT_ADMIN_EMAIL || 'admin@admin.com';
      const hashedPassword = await bcrypt.hash(defaultPassword, 10);
      await prisma.user.create({
        data: {
          fullName: 'System Administrator',
          email: adminEmail,
          username: 'admin',
          password: hashedPassword,
          phone: '+201000000000',
          country: 'EG',
          role: 'super_admin',
          status: 'active',
          balance: 0.0,
        },
      });
      console.log(`[Bootstrap] Initial super_admin created with email ${adminEmail}. Ensure DEFAULT_ADMIN_PASSWORD is set in production.`);
    } else {
      // Ensure API access is disabled for administrative accounts
      await prisma.user.updateMany({
        where: {
          role: { in: ['admin', 'super_admin'] }
        },
        data: {
          apiKey: null,
          apiEnabled: false
        }
      });
      console.log('[Bootstrap] Admin accounts verified with API access disabled.');
    }


    // Initialize or sync telegram_admin_chat_ids setting
    try {
      const defaultId = (process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
      const existing = await prisma.setting.findUnique({ where: { key: 'telegram_admin_chat_ids' } });
      if (!existing && defaultId) {
        const initial = defaultId.split(',').map(s => s.trim()).filter(Boolean);
        await prisma.setting.create({
          data: {
            key: 'telegram_admin_chat_ids',
            value: JSON.stringify(initial)
          }
        });
      }
      await refreshAdminIds();
    } catch (_) {}

    // Seed and configuration tasks continue below

    // 2.5 Auto-backfill quantity support & limits for DhruService records
    try {
      const allServices = await prisma.dhruService.findMany({
        select: {
          id: true,
          name: true,
          originalName: true,
          groupName: true,
          info: true,
          requiresCustom: true,
          supportsQty: true,
          minQty: true,
          maxQty: true
        }
      });

      let updatedCount = 0;
      for (const s of allServices) {
        const limits = extractQuantityLimits(s);
        if (s.supportsQty !== limits.supportsQty || s.minQty !== limits.minQty || s.maxQty !== limits.maxQty) {
          let enrichedCustom = s.requiresCustom;
          if (limits.supportsQty && s.requiresCustom) {
            try {
              const parsed = JSON.parse(s.requiresCustom);
              if (Array.isArray(parsed)) {
                const enriched = enrichCustomFieldsWithQuantity(parsed, limits);
                enrichedCustom = JSON.stringify(enriched);
              }
            } catch {}
          }

          await prisma.dhruService.update({
            where: { id: s.id },
            data: {
              supportsQty: limits.supportsQty,
              minQty: limits.minQty,
              maxQty: limits.maxQty,
              ...(enrichedCustom !== s.requiresCustom ? { requiresCustom: enrichedCustom } : {})
            }
          });
          updatedCount++;
        }
      }
      if (updatedCount > 0) {
        console.log(`[Bootstrap] Auto-backfilled quantity configuration for ${updatedCount} services.`);
      }
    } catch (qntErr) {
      console.error('[Bootstrap] Note on backfilling service quantity:', qntErr);
    }

    // 3. Check & Sync Services if a Provider is configured
    const serviceCount = await prisma.dhruService.count();
    const activeProvider = await prisma.apiProvider.findFirst({ where: { isActive: true } });
    if (serviceCount === 0 && (activeProvider || (process.env.DHRU_API_URL && process.env.DHRU_API_KEY))) {
      console.log('[Bootstrap] Active provider detected. Starting automatic services sync...');
      await syncDhruServices();
      console.log('[Bootstrap] Automatic services sync finished successfully!');
    } else {
      console.log(`[Bootstrap] Found ${serviceCount} existing services. Awaiting custom provider addition.`);
    }

    // 4. Check, Deduplicate & Synchronize the 10 Professional GSM Blog Articles
    try {
      const { tenArticles } = require('../scripts/seed10Articles');
      if (Array.isArray(tenArticles)) {
        // Fetch all existing posts
        const existingPosts = await prisma.blogPost.findMany();
        
        // 1. Remove duplicates sharing the same title
        const seenTitles = new Set();
        for (const post of existingPosts) {
          const cleanTitle = (post.titleAr || '').trim();
          if (seenTitles.has(cleanTitle)) {
            await prisma.blogPost.delete({ where: { id: post.id } });
            console.log(`[Bootstrap] Deleted duplicate blog post: ${cleanTitle}`);
          } else {
            seenTitles.add(cleanTitle);
          }
        }

        // 2. Ensure each of the 10 curated articles is in the DB with fresh high-contrast content
        for (const article of tenArticles) {
          const match = await prisma.blogPost.findFirst({
            where: {
              OR: [
                { id: article.id },
                { titleAr: article.titleAr }
              ]
            }
          });

          if (!match) {
            await prisma.blogPost.create({
              data: {
                id: article.id,
                titleAr: article.titleAr,
                titleEn: article.titleEn,
                excerptAr: article.excerptAr,
                excerptEn: article.excerptEn,
                contentAr: article.contentAr.trim(),
                contentEn: article.contentEn.trim(),
                imageUrl: article.imageUrl,
                category: article.category,
              }
            });
            console.log(`[Bootstrap] Created article: ${article.titleAr}`);
          } else {
            await prisma.blogPost.update({
              where: { id: match.id },
              data: {
                titleEn: article.titleEn,
                excerptAr: article.excerptAr,
                excerptEn: article.excerptEn,
                contentAr: article.contentAr.trim(),
                contentEn: article.contentEn.trim(),
                imageUrl: article.imageUrl,
                category: article.category,
              }
            });
          }
        }

        console.log('[Bootstrap] 10 Professional Blog Articles verified and synchronized without duplicates!');
      }
    } catch (blogErr) {
      console.error('[Bootstrap] Note on seeding blog articles:', blogErr);
    }

  } catch (error) {
    console.error('[Bootstrap] Fatal error during database bootstrap:', error);
    throw error;
  }
}
