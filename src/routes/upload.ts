import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { prisma } from "../utils/prisma";
import { isAdmin } from '../middleware/auth';
import { getUploadDir, ensureUploadDir, saveBufferToUploads, getUploadFilePath } from '../utils/uploads';

const router = Router();

// POST /api/upload - Upload Image to Volume & PostgreSQL DB
router.post('/', isAdmin, async (req, res) => {
  try {
    const { image, filename } = req.body;
    if (!image) {
      return res.status(400).json({ success: false, error: 'لم يتم توفير صورة للرفع' });
    }

    ensureUploadDir();

    // Extract mime type and clean Base64 data
    const matches = image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return res.status(400).json({ success: false, error: 'يجب رفع صورة بصيغة Base64 صالحة' });
    }

    const mimeType = matches[1].toLowerCase();
    const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    if (!allowedMimeTypes.has(mimeType)) {
      return res.status(400).json({ success: false, error: 'نوع الصورة غير مسموح' });
    }

    const base64Data = matches[2];
    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
      return res.status(413).json({ success: false, error: 'حجم الصورة يجب ألا يتجاوز 10 ميجابايت' });
    }

    // Verify image magic bytes signature
    const isValidSignature = (
      (mimeType === 'image/jpeg' && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
      (mimeType === 'image/png' && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) ||
      (mimeType === 'image/gif' && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) ||
      (mimeType === 'image/webp' && buffer.length >= 12 && buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50)
    );

    if (!isValidSignature) {
      return res.status(400).json({ success: false, error: 'محتوى الملف لا يطابق صيغة الصورة المصرح بها' });
    }

    const mimeToExt: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'image/gif': '.gif'
    };
    const cleanBasename = (filename || 'uploaded_image').replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const uniqueFilename = `${Date.now()}_${cleanBasename}${mimeToExt[mimeType] || '.jpg'}`;

    // 1. Save directly into persistent volume /app/uploads on disk
    try {
      saveBufferToUploads(uniqueFilename, buffer);
    } catch (fsErr) {
      console.error('[Uploads] Error saving to volume disk:', fsErr);
    }

    // 2. Also save into PostgreSQL database as permanent fallback
    const storedRecord = await prisma.storedImage.create({
      data: {
        filename: uniqueFilename,
        mimeType: mimeType,
        data: base64Data,
        size: buffer.length,
      }
    });

    const imageUrl = `/uploads/${uniqueFilename}`;
    const fallbackApiUrl = `/api/upload/${storedRecord.id}`;
    return res.json({ 
      success: true, 
      id: storedRecord.id,
      url: imageUrl, 
      fallbackUrl: fallbackApiUrl,
      filename: uniqueFilename 
    });
  } catch (error: any) {
    console.error('Error uploading image:', error);
    return res.status(500).json({ success: false, error: 'فشل رفع وحفظ الصورة' });
  }
});

// GET /api/upload/:id - Stream Image Directly from Disk Volume or Database
router.get('/:id', async (req, res) => {
  try {
    const id = String(req.params.id);

    // S12: Block any receipt access from the public upload endpoint
    if (id.toLowerCase().includes('receipt')) {
      return res.status(403).json({ error: 'Access forbidden: receipts require authenticated transaction access' });
    }

    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    // 1. Check persistent volume on disk first
    const diskPath = getUploadFilePath(id);
    if (diskPath && fs.existsSync(diskPath)) {
      const ext = path.extname(diskPath).replace('.', '').toLowerCase() || 'jpeg';
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
      res.setHeader('Content-Type', mime);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      return fs.createReadStream(diskPath).pipe(res);
    }

    // 2. Check if ID matches database record or filename in DB
    let stored = await prisma.storedImage.findFirst({
      where: {
        OR: [
          { id: id },
          { filename: id }
        ]
      }
    });

    if (stored) {
      // A UUID must not bypass the same privacy rule applied to filenames.
      if (stored.filename.toLowerCase().includes('receipt')) {
        res.setHeader('Cache-Control', 'private, no-store');
        return res.status(403).json({ error: 'Receipts require authenticated transaction access' });
      }
      const imgBuffer = Buffer.from(stored.data, 'base64');
      res.setHeader('Content-Type', stored.mimeType || 'image/jpeg');
      res.setHeader('Content-Length', imgBuffer.length);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      return res.end(imgBuffer);
    }

    return res.status(404).json({ error: 'Image not found' });
  } catch (error: any) {
    console.error('Error serving image:', error);
    return res.status(500).json({ error: 'Failed to retrieve image' });
  }
});

// GET /api/upload - List Stored Images (Metadata only)
router.get('/', isAdmin, async (req, res) => {
  try {
    const images = await prisma.storedImage.findMany({
      select: {
        id: true,
        filename: true,
        mimeType: true,
        size: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50
    });

    return res.json({ success: true, images });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to fetch media list' });
  }
});

// DELETE /api/upload/:id - Delete Image from Disk and Database
router.delete('/:id', isAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.storedImage.findFirst({
      where: {
        OR: [{ id }, { filename: id }]
      }
    });

    const targetFilename = existing?.filename || id;
    const diskPath = getUploadFilePath(targetFilename);
    if (diskPath && fs.existsSync(diskPath)) {
      try {
        fs.unlinkSync(diskPath);
      } catch (err) {
        console.error('[Uploads] Error removing file from disk:', err);
      }
    }

    try {
      const pubPath = path.join(process.cwd(), 'public', 'uploads', targetFilename);
      if (fs.existsSync(pubPath)) {
        fs.unlinkSync(pubPath);
      }
    } catch (_) {}

    await prisma.storedImage.deleteMany({
      where: {
        OR: [
          { id: id },
          { filename: id }
        ]
      }
    });
    return res.json({ success: true, message: 'Image deleted successfully' });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to delete image' });
  }
});

export default router;
