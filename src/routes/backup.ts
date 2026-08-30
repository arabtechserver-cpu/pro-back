import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { isAdmin } from '../middleware/auth';
import { prisma } from '../server';

const router = Router();
const BACKUPS_DIR = path.join(__dirname, '..', '..', 'backups');

// Ensure backups dir exists
if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

// Helper: Extract all data into a JSON structure
async function generateBackupSnapshot() {
  const [
    users,
    orders,
    transactions,
    walletTransactions,
    dhruCategories,
    dhruServices,
    blogPosts,
    videoSeries,
    videoTutorials,
    subscribers,
    newsletterBroadcasts,
    storedImages,
  ] = await Promise.all([
    prisma.user.findMany(),
    prisma.order.findMany(),
    prisma.transaction.findMany(),
    prisma.walletTransaction.findMany(),
    prisma.dhruCategory.findMany(),
    prisma.dhruService.findMany(),
    prisma.blogPost.findMany(),
    prisma.videoSeries.findMany(),
    prisma.videoTutorial.findMany(),
    prisma.subscriber.findMany(),
    prisma.newsletterBroadcast.findMany(),
    prisma.storedImage.findMany(),
  ]);

  return {
    version: '2.0',
    createdAt: new Date().toISOString(),
    summary: {
      totalUsers: users.length,
      totalOrders: orders.length,
      totalTransactions: transactions.length,
      totalServices: dhruServices.length,
      totalBlogPosts: blogPosts.length,
      totalVideos: videoTutorials.length,
    },
    users,
    orders,
    transactions,
    walletTransactions,
    dhruCategories,
    dhruServices,
    blogPosts,
    videoSeries,
    videoTutorials,
    subscribers,
    newsletterBroadcasts,
    storedImages,
  };
}

// Helper: Perform Selective Restore / Merge
async function performSelectiveRestore(
  data: any,
  options: {
    customers?: boolean;
    updateBalances?: boolean;
    orders?: boolean;
    transactions?: boolean;
    services?: boolean;
    blogPosts?: boolean;
    videos?: boolean;
    analytics?: boolean;
    mode?: 'merge' | 'overwrite';
  }
) {
  if (!data || typeof data !== 'object') {
    throw new Error('ملف النسخة غير صالح');
  }

  const tables = data.tables || data;
  const isOverwrite = options.mode === 'overwrite';

  const rawCustomers = data.customers || tables.customers || tables.users || tables.User || [];
  const rawOrders = data.orders || tables.orders || tables.Order || [];
  const rawTransactions = data.transactions || tables.transactions || tables.Transaction || [];
  const rawWalletTxns = data.walletTransactions || tables.wallet_transactions || tables.WalletTransaction || [];
  const rawCategories = data.dhruCategories || tables.dhru_categories || tables.categories || tables.DhruCategory || [];
  const rawServices = data.dhruServices || tables.dhru_services || tables.services || tables.DhruService || [];
  const rawBlogPosts = data.blogPosts || tables.blog_posts || tables.BlogPost || [];
  const rawVideoSeries = data.videoSeries || tables.video_series || tables.VideoSeries || [];
  const rawVideoTutorials = data.videoTutorials || tables.video_tutorials || tables.VideoTutorial || [];
  const rawEvents = data.analyticsEvents || tables.conversion_events || tables.analytics_events || tables.AnalyticsEvent || [];

  const stats = {
    usersProcessed: 0,
    balancesUpdated: 0,
    ordersProcessed: 0,
    transactionsProcessed: 0,
    servicesProcessed: 0,
    blogPostsProcessed: 0,
  };

  // Map old IDs to valid database User IDs
  const userIdMap = new Map<string | number, string>();

  // 1. Process Customers / Users
  if (options.customers && Array.isArray(rawCustomers) && rawCustomers.length > 0) {
    if (isOverwrite) {
      // In overwrite mode, delete non-admin users
      await prisma.order.deleteMany();
      await prisma.transaction.deleteMany();
      await prisma.walletTransaction.deleteMany();
      await prisma.user.deleteMany({ where: { role: { notIn: ['admin', 'super_admin'] } } });
    }

    for (const c of rawCustomers) {
      const username = String(c.username || c.email || `user_${c.id}`).trim();
      const email = String(c.email || `${username.replace(/[^a-zA-Z0-9]/g, '')}@customer.local`).trim().toLowerCase();
      const balance = Number(c.balance) || 0;
      const country = c.country || 'EG';
      const role = c.role === 'admin' ? 'admin' : 'user';
      const status = c.status === 'suspended' ? 'suspended' : 'active';
      const password = c.password || '$2a$10$abcdefghijklmnopqrstuvwxyz123456';

      try {
        // Find existing user by username or email
        const existing = await prisma.user.findFirst({
          where: {
            OR: [
              { email: email },
              { username: username }
            ]
          }
        });

        if (existing) {
          userIdMap.set(c.id, existing.id);
          userIdMap.set(username, existing.id);
          if (c.email) userIdMap.set(c.email, existing.id);

          const updateData: any = {};
          if (options.updateBalances) {
            updateData.balance = balance;
            stats.balancesUpdated++;
          }
          if (c.phone) updateData.fullName = c.fullName || c.full_name || username;
          if (c.password && !existing.password) updateData.password = password;

          if (Object.keys(updateData).length > 0) {
            await prisma.user.update({
              where: { id: existing.id },
              data: updateData
            });
          }
          stats.usersProcessed++;
        } else {
          const newUser = await prisma.user.create({
            data: {
              fullName: c.fullName || c.full_name || username,
              username: username,
              email: email,
              password: password,
              country: country,
              role: role,
              status: status,
              balance: balance,
              createdAt: c.created_at || c.createdAt ? new Date(c.created_at || c.createdAt) : undefined,
            }
          });
          userIdMap.set(c.id, newUser.id);
          userIdMap.set(username, newUser.id);
          if (c.email) userIdMap.set(c.email, newUser.id);

          stats.usersProcessed++;
          if (balance > 0) stats.balancesUpdated++;
        }
      } catch (err: any) {
        console.warn(`[Restore User] Warning for user ${username}:`, err.message);
      }
    }
  }

  // Ensure map is populated for existing users even if customers section wasn't checked
  if (userIdMap.size === 0) {
    const allCurrentUsers = await prisma.user.findMany();
    for (const u of allCurrentUsers) {
      userIdMap.set(u.username, u.id);
      userIdMap.set(u.email, u.id);
      userIdMap.set(u.id, u.id);
    }
  }

  // 2. Process Categories & Services
  if (options.services && Array.isArray(rawServices) && rawServices.length > 0) {
    for (const cat of rawCategories) {
      try {
        await prisma.dhruCategory.upsert({
          where: { id: String(cat.id) },
          update: { name: cat.name },
          create: {
            id: String(cat.id),
            name: cat.name,
            createdAt: cat.created_at ? new Date(cat.created_at) : undefined,
          }
        });
      } catch (e) {}
    }

    for (const s of rawServices) {
      try {
        const sId = String(s.dhruId || s.id);
        const name = s.name || s.title || 'Service';
        await prisma.dhruService.upsert({
          where: { dhruId: sId },
          update: {
            name: name,
            originalName: s.originalName || s.name || name,
            groupName: s.groupName || s.category_name || 'General',
            credit: Number(s.credit || s.price || s.package_price) || 0,
            time: s.time || 'Instant',
            info: s.info || s.description || null,
            isActive: s.isActive !== undefined ? Boolean(s.isActive) : true,
          },
          create: {
            dhruId: sId,
            name: name,
            originalName: s.originalName || s.name || name,
            groupName: s.groupName || s.category_name || 'General',
            credit: Number(s.credit || s.price || s.package_price) || 0,
            time: s.time || 'Instant',
            info: s.info || s.description || null,
            isActive: s.isActive !== undefined ? Boolean(s.isActive) : true,
            margin: Number(s.margin) || 0,
          }
        });
        stats.servicesProcessed++;
      } catch (e) {}
    }
  }

  // 3. Process Orders
  if (options.orders && Array.isArray(rawOrders) && rawOrders.length > 0) {
    if (isOverwrite) {
      await prisma.order.deleteMany();
    }

    for (const o of rawOrders) {
      try {
        let matchedUserId: string | null = null;
        if (o.userId) matchedUserId = userIdMap.get(o.userId) || o.userId;
        else if (o.customer_id) matchedUserId = userIdMap.get(o.customer_id) || null;
        else if (o.customer_username) matchedUserId = userIdMap.get(o.customer_username) || null;

        await prisma.order.create({
          data: {
            userId: matchedUserId,
            serviceName: o.serviceName || o.service_name || o.package_name || 'Service',
            serviceId: String(o.serviceId || o.service_id || '0'),
            targetInput: o.targetInput || o.target_input || o.player_id || o.phone || o.custom_fields || '',
            quantity: Number(o.quantity) || 1,
            price: Number(o.price || o.package_price || o.transfer_amount) || 0,
            status: o.status || 'completed',
            apiOrderId: o.apiOrderId || o.api_order_id ? String(o.apiOrderId || o.api_order_id) : null,
            reply: o.reply || o.code || o.download_link || null,
            notes: o.notes || o.details || null,
            createdAt: o.created_at || o.createdAt ? new Date(o.created_at || o.createdAt) : undefined,
          }
        });
        stats.ordersProcessed++;
      } catch (err: any) {
        console.warn('[Restore Order] Skip order:', err.message);
      }
    }
  }

  // 4. Process Transactions / Wallet Records
  if (options.transactions) {
    if (isOverwrite) {
      await prisma.transaction.deleteMany();
      await prisma.walletTransaction.deleteMany();
    }

    // Process wallet_transactions / transactions
    const combinedTxns = [...rawTransactions, ...rawWalletTxns];
    for (const t of combinedTxns) {
      try {
        let matchedUserId: string | null = null;
        if (t.userId) matchedUserId = userIdMap.get(t.userId) || t.userId;
        else if (t.customer_id) matchedUserId = userIdMap.get(t.customer_id) || null;
        else if (t.customer_username) matchedUserId = userIdMap.get(t.customer_username) || null;

        if (matchedUserId) {
          const amount = Number(t.amount) || 0;
          const type = t.type || 'شحن محفظة';
          await prisma.transaction.create({
            data: {
              userId: matchedUserId,
              type: type,
              amount: amount,
              method: t.method || 'رصيد سابق / تحويل',
              status: t.status || 'completed',
              refNo: String(t.refNo || t.ref_no || `TRX-${Date.now()}-${Math.floor(Math.random()*1000)}`),
              receiptImage: t.receiptImage || t.receipt_image || null,
              createdAt: t.created_at || t.createdAt ? new Date(t.created_at || t.createdAt) : undefined,
            }
          });

          await prisma.walletTransaction.create({
            data: {
              userId: matchedUserId,
              amount: amount,
              type: type.includes('خصم') ? 'withdrawal' : 'deposit',
              status: 'completed',
              createdAt: t.created_at || t.createdAt ? new Date(t.created_at || t.createdAt) : undefined,
            }
          });

          stats.transactionsProcessed++;
        }
      } catch (err: any) {
        console.warn('[Restore Txn] Skip:', err.message);
      }
    }
  }

  // 5. Process Blog Posts
  if (options.blogPosts && Array.isArray(rawBlogPosts) && rawBlogPosts.length > 0) {
    for (const bp of rawBlogPosts) {
      try {
        const titleAr = bp.titleAr || bp.title_ar || bp.title || '';
        const titleEn = bp.titleEn || bp.title_en || bp.title || titleAr;
        if (!titleAr && !titleEn) continue;

        await prisma.blogPost.create({
          data: {
            titleAr: titleAr,
            titleEn: titleEn,
            excerptAr: bp.excerptAr || bp.excerpt_ar || '',
            excerptEn: bp.excerptEn || bp.excerpt_en || '',
            contentAr: bp.contentAr || bp.content_ar || '',
            contentEn: bp.contentEn || bp.content_en || '',
            imageUrl: bp.imageUrl || bp.image_url || '/images/blog/default.jpg',
            category: bp.category || 'General',
            createdAt: bp.created_at || bp.createdAt ? new Date(bp.created_at || bp.createdAt) : undefined,
          }
        });
        stats.blogPostsProcessed++;
      } catch (e) {}
    }
  }

  return stats;
}

// GET /api/backup - List available backups
router.get('/', isAdmin, async (req, res) => {
  try {
    const files = fs.readdirSync(BACKUPS_DIR);
    const backups = files
      .filter((file) => file.endsWith('.json'))
      .map((file) => {
        const stats = fs.statSync(path.join(BACKUPS_DIR, file));
        return {
          filename: file,
          size: stats.size,
          createdAt: stats.mtime
        };
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    res.json({ success: true, backups });
  } catch (error: any) {
    console.error('List backups error:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء جلب قائمة النسخ الاحتياطية' });
  }
});

// POST /api/backup/create - Create a new JSON backup
router.post('/create', isAdmin, async (req, res) => {
  try {
    const backupData = await generateBackupSnapshot();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `backup-${timestamp}.json`;
    const destPath = path.join(BACKUPS_DIR, backupFilename);

    fs.writeFileSync(destPath, JSON.stringify(backupData, null, 2), 'utf8');

    res.json({
      success: true,
      message: 'تم إنشاء النسخة الاحتياطية بنجاح!',
      filename: backupFilename
    });
  } catch (error: any) {
    console.error('Create backup error:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء إنشاء النسخة الاحتياطية' });
  }
});

// GET /api/backup/download/:filename - Download a specific backup
router.get('/download/:filename', isAdmin, async (req, res) => {
  try {
    const safeFilename = path.basename(String(req.params.filename));
    const filePath = path.join(BACKUPS_DIR, safeFilename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'ملف النسخة الاحتياطية غير موجود' });
    }

    res.download(filePath, safeFilename);
  } catch (error: any) {
    console.error('Download backup error:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء تحميل النسخة الاحتياطية' });
  }
});

// POST /api/backup/selective-restore - Perform customized and selective restore
router.post('/selective-restore', isAdmin, async (req, res) => {
  try {
    const { backupData, options, filename } = req.body;
    let data = backupData;

    if (!data && filename) {
      const safeFilename = path.basename(filename);
      const filePath = path.join(BACKUPS_DIR, safeFilename);
      if (fs.existsSync(filePath)) {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      }
    }

    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: 'بيانات النسخة الاحتياطية غير صالحة أو غير متوفرة' });
    }

    // Save a copy if uploaded
    if (backupData) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFilename = `uploaded-selective-${timestamp}.json`;
      const destPath = path.join(BACKUPS_DIR, backupFilename);
      fs.writeFileSync(destPath, JSON.stringify(backupData, null, 2), 'utf8');
    }

    const stats = await performSelectiveRestore(data, options || {
      customers: true,
      updateBalances: true,
      orders: true,
      transactions: true,
      mode: 'merge'
    });

    res.json({
      success: true,
      message: 'تم استرجاع وتحديث البيانات المحددة بنجاح!',
      stats
    });
  } catch (error: any) {
    console.error('Selective restore error:', error);
    res.status(500).json({ error: `فشل الاسترجاع المخصص: ${error.message}` });
  }
});

// POST /api/backup/restore - Restore a specific backup from server (Full)
router.post('/restore', isAdmin, async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) {
      return res.status(400).json({ error: 'اسم الملف مطلوب' });
    }

    const safeFilename = path.basename(filename);
    const backupPath = path.join(BACKUPS_DIR, safeFilename);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'ملف النسخة الاحتياطية غير موجود' });
    }

    const content = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const stats = await performSelectiveRestore(content, {
      customers: true,
      updateBalances: true,
      orders: true,
      transactions: true,
      services: true,
      blogPosts: true,
      videos: true,
      mode: 'overwrite'
    });

    res.json({
      success: true,
      message: 'تم استرجاع النسخة الاحتياطية بنجاح!',
      stats
    });
  } catch (error: any) {
    console.error('Restore backup error:', error);
    res.status(500).json({ error: `حدث خطأ أثناء استرجاع النسخة الاحتياطية: ${error.message}` });
  }
});

// POST /api/backup/upload-restore - Upload JSON from device and restore
router.post('/upload-restore', isAdmin, async (req, res) => {
  try {
    const { backupData } = req.body;
    if (!backupData || typeof backupData !== 'object') {
      return res.status(400).json({ error: 'بيانات النسخة الاحتياطية غير صالحة' });
    }

    // Save a copy to backups folder as well
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `uploaded-backup-${timestamp}.json`;
    const destPath = path.join(BACKUPS_DIR, backupFilename);
    fs.writeFileSync(destPath, JSON.stringify(backupData, null, 2), 'utf8');

    // Perform restore
    const stats = await performSelectiveRestore(backupData, {
      customers: true,
      updateBalances: true,
      orders: true,
      transactions: true,
      mode: 'merge'
    });

    res.json({
      success: true,
      message: 'تم رفع واسترجاع وتحديث البيانات بنجاح!',
      stats
    });
  } catch (error: any) {
    console.error('Upload & Restore backup error:', error);
    res.status(500).json({ error: `فشل استرجاع النسخة المرفوعة: ${error.message}` });
  }
});

// DELETE /api/backup/:filename - Delete a backup
router.delete('/:filename', isAdmin, async (req, res) => {
  try {
    const safeFilename = path.basename(String(req.params.filename));
    const backupPath = path.join(BACKUPS_DIR, safeFilename);

    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'النسخة الاحتياطية غير موجودة' });
    }

    fs.unlinkSync(backupPath);
    res.json({ success: true, message: 'تم حذف النسخة الاحتياطية بنجاح' });
  } catch (error: any) {
    console.error('Delete backup error:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء الحذف' });
  }
});

export default router;
