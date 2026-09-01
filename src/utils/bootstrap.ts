import { prisma } from '../server';
import bcrypt from 'bcryptjs';
import { syncDhruServices } from '../scripts/syncDhruServices';

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

    // 2. Check & Ensure Newsletter Tables Exist
    try {
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "Subscriber" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "email" TEXT NOT NULL UNIQUE,
          "name" TEXT,
          "isActive" BOOLEAN NOT NULL DEFAULT true,
          "source" TEXT NOT NULL DEFAULT 'homepage',
          "subscribedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
          "lastNotifiedAt" TIMESTAMP(3)
        );
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS "NewsletterBroadcast" (
          "id" TEXT NOT NULL PRIMARY KEY,
          "subject" TEXT NOT NULL,
          "title" TEXT NOT NULL,
          "message" TEXT NOT NULL,
          "category" TEXT NOT NULL DEFAULT 'General',
          "actionUrl" TEXT,
          "actionText" TEXT,
          "sentCount" INTEGER NOT NULL DEFAULT 0,
          "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
    } catch (tblErr) {
      console.warn('[Bootstrap] Note on newsletter tables check:', tblErr);
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
