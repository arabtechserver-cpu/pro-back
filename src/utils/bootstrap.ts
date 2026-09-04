import { prisma } from "../utils/prisma";
import bcrypt from 'bcryptjs';
import { syncDhruServices } from '../scripts/syncDhruServices';
import { extractQuantityLimits, enrichCustomFieldsWithQuantity } from './provider-quantity';

export async function bootstrapDatabase() {
  try {
    console.log('[Bootstrap] Checking database status...');

    // 1. Check & Ensure Admin User is Active
    const adminUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: 'admin@admin.com' },
          { username: 'admin' },
          { role: 'admin' }
        ]
      }
    });

    if (!adminUser) {
      console.log('[Bootstrap] No admin user found. Creating default admin user...');
      const hashedPassword = await bcrypt.hash('123456', 10);
      await prisma.user.create({
        data: {
          fullName: 'System Administrator',
          email: 'admin@admin.com',
          username: 'admin',
          password: hashedPassword,
          phone: '+201000000000',
          country: 'EG',
          role: 'admin',
          status: 'active',
          balance: 1000.0,
        },
      });
      console.log('[Bootstrap] Default Admin created (Email: admin@admin.com / Password: 123456)');
    } else {
      // Force ensure admin account is ACTIVE and has admin role
      await prisma.user.update({
        where: { id: adminUser.id },
        data: {
          status: 'active',
          role: 'admin'
        }
      });
      console.log('[Bootstrap] Admin account status restored to ACTIVE.');
    }

    // Auto-migrate User table to add phone column if missing
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "phone" TEXT;`);
    } catch (colErr) {
      // Ignore if column exists or unsupported syntax
    }

    // 2. Ensure columns exist via auto-migration helpers
    // Newsletter tables (Subscriber, NewsletterBroadcast) are managed by prisma db push.
    // Add any missing columns that may not be covered by db push due to data-loss protection:
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Subscriber" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "Subscriber" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "membershipTierId" TEXT;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "customDiscount" DOUBLE PRECISION NOT NULL DEFAULT 0;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "apiEnabled" BOOLEAN NOT NULL DEFAULT false;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "apiKey" TEXT;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "apiSiteName" TEXT;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "apiSiteUrl" TEXT;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "apiMargin" DOUBLE PRECISION NOT NULL DEFAULT 0;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "DhruService" ADD COLUMN IF NOT EXISTS "originalPrice" DOUBLE PRECISION;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "DhruService" ADD COLUMN IF NOT EXISTS "api_service_type" TEXT;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "DhruService" ADD COLUMN IF NOT EXISTS "supportsQty" BOOLEAN NOT NULL DEFAULT false;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "DhruService" ADD COLUMN IF NOT EXISTS "minQty" INTEGER NOT NULL DEFAULT 1;`);
    } catch (_) { /* already exists */ }
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "DhruService" ADD COLUMN IF NOT EXISTS "maxQty" INTEGER NOT NULL DEFAULT 0;`);
    } catch (_) { /* already exists */ }
    console.log('[Bootstrap] Column migration helpers completed.');

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
    console.error('[Bootstrap] Error during database bootstrap:', error);
  }
}
