import fs from 'fs';
import path from 'path';

/**
 * Resolves the upload directory path.
 * Priority:
 * 1. process.env.UPLOADS_DIR (if specified)
 * 2. /app/uploads (Mounted Persistent Volume in Docker container)
 * 3. Local fallback: path.join(process.cwd(), 'uploads') or public/uploads
 */
export function getUploadDir(): string {
  if (process.env.UPLOADS_DIR) {
    return process.env.UPLOADS_DIR;
  }

  // In Docker runner (WORKDIR is /app), volume mount path is /app/uploads
  if (fs.existsSync('/app/uploads')) {
    return '/app/uploads';
  }

  // If in Linux root /app exists, try creating /app/uploads
  if (fs.existsSync('/app')) {
    try {
      fs.mkdirSync('/app/uploads', { recursive: true });
      return '/app/uploads';
    } catch (_) {}
  }

  // Local development fallback
  const localUploadDir = path.join(process.cwd(), 'uploads');
  return localUploadDir;
}

/**
 * Ensures the uploads directory exists on disk.
 */
export function ensureUploadDir(): string {
  const dir = getUploadDir();
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (err) {
    console.error(`[Uploads] Failed to create directory ${dir}:`, err);
  }
  return dir;
}

/**
 * Saves a binary buffer to the persistent upload volume on the server.
 */
export function saveBufferToUploads(filename: string, buffer: Buffer): string {
  const uploadDir = ensureUploadDir();
  const filePath = path.join(uploadDir, filename);
  try {
    fs.writeFileSync(filePath, buffer);
  } catch (err) {
    console.error(`[Uploads] Error writing file to primary upload dir ${filePath}:`, err);
  }

  // Also write to local public/uploads if different, to ensure server static serving
  try {
    const pubDir = path.join(process.cwd(), 'public', 'uploads');
    if (!fs.existsSync(pubDir)) fs.mkdirSync(pubDir, { recursive: true });
    const pubPath = path.join(pubDir, filename);
    if (pubPath !== filePath) {
      fs.writeFileSync(pubPath, buffer);
    }
  } catch (_) {}

  return filePath;
}

/**
 * Checks if a file exists in the uploads volume.
 */
export function getUploadFilePath(filename: string): string | null {
  const uploadDir = getUploadDir();
  const primaryPath = path.join(uploadDir, filename);
  if (fs.existsSync(primaryPath)) return primaryPath;

  // Secondary fallback checks
  const secondaryPath = path.join(process.cwd(), 'public/uploads', filename);
  if (fs.existsSync(secondaryPath)) return secondaryPath;

  const appUploadsFallback = path.join('/app/uploads', filename);
  if (fs.existsSync(appUploadsFallback)) return appUploadsFallback;

  return null;
}

/**
 * Automatically syncs & restores all stored images onto the server's disk.
 * This guarantees that every image file physically exists in /uploads on the server even after server reboots!
 */
export async function restoreImagesToDisk(prismaClient: any): Promise<number> {
  try {
    const uploadDir = ensureUploadDir();
    const images = await prismaClient.storedImage.findMany({
      select: { filename: true, data: true }
    });

    let restoredCount = 0;
    for (const img of images) {
      if (!img.filename || !img.data) continue;
      const targetPath = path.join(uploadDir, img.filename);
      if (!fs.existsSync(targetPath)) {
        try {
          const buffer = Buffer.from(img.data, 'base64');
          fs.writeFileSync(targetPath, buffer);
          restoredCount++;
        } catch (e) {
          console.error(`[Uploads] Error restoring image ${img.filename}:`, e);
        }
      }
    }

    if (restoredCount > 0) {
      console.log(`[Uploads] ✅ Restored ${restoredCount} image(s) to server disk at: ${uploadDir}`);
    }
    return restoredCount;
  } catch (err: any) {
    console.error('[Uploads] restoreImagesToDisk error:', err.message);
    return 0;
  }
}

