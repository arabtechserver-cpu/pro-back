import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { isAdmin } from '../middleware/auth';

const router = Router();

const DB_PATH = path.join(__dirname, '..', '..', 'prisma', 'dev.db');
const BACKUPS_DIR = path.join(__dirname, '..', '..', 'backups');

// Ensure backups dir exists
if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

// GET /api/backup - List available backups
router.get('/', isAdmin, async (req, res) => {
  try {
    const files = fs.readdirSync(BACKUPS_DIR);
    const backups = files
      .filter((file) => file.endsWith('.db'))
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

// POST /api/backup/create - Create a new backup
router.post('/create', isAdmin, async (req, res) => {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return res.status(404).json({ error: 'ملف قاعدة البيانات غير موجود!' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFilename = `backup-${timestamp}.db`;
    const destPath = path.join(BACKUPS_DIR, backupFilename);

    fs.copyFileSync(DB_PATH, destPath);

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

// POST /api/backup/restore - Restore a specific backup
router.post('/restore', isAdmin, async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) {
      return res.status(400).json({ error: 'اسم الملف مطلوب' });
    }

    const backupPath = path.join(BACKUPS_DIR, filename);
    if (!fs.existsSync(backupPath)) {
      return res.status(404).json({ error: 'ملف النسخة الاحتياطية غير موجود' });
    }

    // Replace the current dev.db
    fs.copyFileSync(backupPath, DB_PATH);

    res.json({
      success: true,
      message: 'تم استرجاع النسخة الاحتياطية بنجاح! يُرجى إعادة تشغيل الخادم لتطبيق التغييرات.'
    });
  } catch (error: any) {
    console.error('Restore backup error:', error);
    res.status(500).json({ error: 'حدث خطأ أثناء استرجاع النسخة الاحتياطية' });
  }
});

// DELETE /api/backup/:filename - Delete a backup
router.delete('/:filename', isAdmin, async (req, res) => {
  try {
    const { filename } = req.params;
    const backupPath = path.join(BACKUPS_DIR, String(filename));

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
