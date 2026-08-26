import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { prisma } from '../server';

const router = Router();
const UPLOAD_DIR = path.join(__dirname, '../../public/uploads');

function ensureUploadDirExists() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

// POST /api/upload - Upload Image to PostgreSQL DB & Disk
router.post('/', async (req, res) => {
  try {
    const { image, filename } = req.body;
    if (!image) {
      return res.status(400).json({ success: false, error: 'لم يتم توفير صورة للرفع' });
    }

    ensureUploadDirExists();

    // Extract mime type and clean Base64 data
    const matches = image.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    let base64Data = image;
    let mimeType = 'image/jpeg';
    let ext = 'jpg';

    if (matches && matches.length === 3) {
      mimeType = matches[1];
      ext = mimeType.split('/')[1] || 'jpg';
      base64Data = matches[2];
    }

    const cleanFilename = (filename || 'uploaded_image').replace(/[^a-zA-Z0-9_.-]/g, '_');
    const uniqueFilename = `${Date.now()}_${cleanFilename}`;
    const buffer = Buffer.from(base64Data, 'base64');

    // 1. Save directly into PostgreSQL database for permanent persistence
    const storedRecord = await prisma.storedImage.create({
      data: {
        filename: uniqueFilename,
        mimeType: mimeType,
        data: base64Data,
        size: buffer.length,
      }
    });

    // 2. Also save to disk for fast local static serving if available
    try {
      const filePath = path.join(UPLOAD_DIR, uniqueFilename);
      fs.writeFileSync(filePath, buffer);
    } catch (fsErr) {
      // Non-fatal if container disk is read-only
    }

    const imageUrl = `https://api.arabtechproserver.tech/api/upload/${storedRecord.id}`;
    return res.json({ 
      success: true, 
      id: storedRecord.id,
      url: imageUrl, 
      filename: uniqueFilename 
    });
  } catch (error: any) {
    console.error('Error uploading image:', error);
    return res.status(500).json({ success: false, error: 'فشل رفع وحفظ الصورة في قاعدة البيانات' });
  }
});

// GET /api/upload/:id - Stream Image Directly from Database or Disk
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Check if ID matches database record or filename
    let stored = await prisma.storedImage.findFirst({
      where: {
        OR: [
          { id: id },
          { filename: id }
        ]
      }
    });

    if (stored) {
      const imgBuffer = Buffer.from(stored.data, 'base64');
      res.setHeader('Content-Type', stored.mimeType || 'image/jpeg');
      res.setHeader('Content-Length', imgBuffer.length);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return res.end(imgBuffer);
    }

    // Fallback: check local uploads folder
    const localFilePath = path.join(UPLOAD_DIR, id);
    if (fs.existsSync(localFilePath)) {
      const ext = path.extname(localFilePath).replace('.', '') || 'jpeg';
      res.setHeader('Content-Type', `image/${ext}`);
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return fs.createReadStream(localFilePath).pipe(res);
    }

    return res.status(404).json({ error: 'Image not found' });
  } catch (error: any) {
    console.error('Error serving image:', error);
    return res.status(500).json({ error: 'Failed to retrieve image' });
  }
});

// GET /api/upload - List Stored Images (Metadata only)
router.get('/', async (req, res) => {
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

// DELETE /api/upload/:id - Delete Image from Database
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
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
