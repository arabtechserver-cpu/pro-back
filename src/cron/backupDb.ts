import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { sendDocumentToAdmins } from '../utils/telegramService';
import { prisma } from "../utils/prisma";

export function initBackupCron() {
  console.log('[CRON] Initializing Daily JSON Backup Cron Job (runs at 00:00 every day)');

  // Run every day at midnight (00:00)
  cron.schedule('0 0 * * *', async () => {
    console.log('[CRON] Running daily JSON backup...');
    try {
      await performJSONBackupAndSend();
    } catch (error) {
      console.error('[CRON] General error in JSON backup:', error);
    }
  });
}

export async function performJSONBackupAndSend() {
  try {
    const dateStr = new Date().toISOString().split('T')[0];
    const jsonFilename = `backup_report_${dateStr}.json`;
    const backupsDir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
    const jsonFilePath = path.join(backupsDir, jsonFilename);

    console.log(`[Backup] Fetching data from database for JSON report...`);
    
    const users = await prisma.user.findMany({
      select: {
        id: true,
        fullName: true,
        email: true,
        username: true,
        phone: true,
        country: true,
        role: true,
        status: true,
        balance: true,
        membershipTierId: true,
        customDiscount: true,
        createdAt: true,
        updatedAt: true,
        apiEnabled: true,
        apiMargin: true,
        apiSiteName: true,
        apiSiteUrl: true
      }
    });
    
    const orders = await prisma.order.findMany();
    const transactions = await prisma.transaction.findMany();
    const walletTransactions = await prisma.walletTransaction.findMany();

    const backupData = {
      timestamp: new Date().toISOString(),
      summary: {
        totalUsers: users.length,
        totalOrders: orders.length,
        totalTransactions: transactions.length,
        totalWalletTransactions: walletTransactions.length
      },
      users,
      orders,
      transactions,
      walletTransactions
    };

    console.log(`[Backup] Writing data to JSON file at ${jsonFilePath}`);
    fs.writeFileSync(jsonFilePath, JSON.stringify(backupData, null, 2), 'utf8');
    
    const stats = fs.statSync(jsonFilePath);
    const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);
    
    const caption = `[REPORT] <b>تقرير النسخة الاحتياطية اليومي (JSON)</b>\n\n<b>التاريخ:</b> ${dateStr}\n<b>المستخدمين:</b> ${users.length}\n<b>الطلبات:</b> ${orders.length}\n<b>المعاملات:</b> ${transactions.length}\n<b>الحجم:</b> ${fileSizeMB} MB`;
    
    const delivered = await sendDocumentToAdmins(jsonFilePath, caption);
    if (delivered) {
      console.log('[Backup] JSON Backup sent to Telegram successfully.');
      if (fs.existsSync(jsonFilePath)) {
        fs.unlinkSync(jsonFilePath);
        console.log(`[Backup] Cleaned up temporary backup file ${jsonFilePath}.`);
      }
    } else {
      console.warn(`[Backup] Telegram delivery could not be completed. Local backup preserved at: ${jsonFilePath}`);
    }
  } catch (err) {
    console.error('[Backup] Error creating or sending JSON backup:', err);
    throw err;
  }
}
