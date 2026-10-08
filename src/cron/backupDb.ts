import { writeBackupSnapshot } from '../utils/streaming-backup';
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
    
    const userSelect = Object.fromEntries([
      'id', 'fullName', 'email', 'username', 'phone', 'country', 'role', 'status',
      'balance', 'membershipTierId', 'customDiscount', 'createdAt', 'updatedAt',
      'apiEnabled', 'apiMargin', 'apiSiteName', 'apiSiteUrl'
    ].map(key => [key, true]));
    const counts = await writeBackupSnapshot(jsonFilePath, {
      users: { model: prisma.user, select: userSelect }, orders: { model: prisma.order },
      transactions: { model: prisma.transaction }, walletTransactions: { model: prisma.walletTransaction }
    }, { timestamp: new Date().toISOString() }, {
      totalUsers: 'users', totalOrders: 'orders', totalTransactions: 'transactions', totalWalletTransactions: 'walletTransactions'
    });

    const stats = fs.statSync(jsonFilePath);
    const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);
    
    const caption = `[REPORT] <b>تقرير النسخة الاحتياطية اليومي (JSON)</b>\n\n<b>التاريخ:</b> ${dateStr}\n<b>المستخدمين:</b> ${counts.users}\n<b>الطلبات:</b> ${counts.orders}\n<b>المعاملات:</b> ${counts.transactions}\n<b>الحجم:</b> ${fileSizeMB} MB`;
    
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
