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
    const jsonFilePath = path.join(__dirname, `../../../${jsonFilename}`);

    console.log(`[Backup] Fetching data from database for JSON report...`);
    
    // Fetch users (with balances and info)
    const users = await prisma.user.findMany();
    
    // Fetch orders
    const orders = await prisma.order.findMany();
    
    // Fetch transactions (wallet deposits/deductions)
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
    
    const caption = `📊 <b>تقرير النسخة الاحتياطية اليومي (JSON)</b>\n\n📅 <b>التاريخ:</b> ${dateStr}\n👥 <b>المستخدمين:</b> ${users.length}\n🛒 <b>الطلبات:</b> ${orders.length}\n💳 <b>المعاملات:</b> ${transactions.length}\n💾 <b>الحجم:</b> ${fileSizeMB} MB`;
    
    // Send to Telegram
    await sendDocumentToAdmins(jsonFilePath, caption);
    console.log('[Backup] JSON Backup sent to Telegram successfully.');

    // Delete the JSON file after sending
    if (fs.existsSync(jsonFilePath)) {
      fs.unlinkSync(jsonFilePath);
      console.log(`[Backup] Deleted local JSON file ${jsonFilePath} to save space.`);
    }
  } catch (err) {
    console.error('[Backup] Error creating or sending JSON backup:', err);
    throw err;
  }
}
