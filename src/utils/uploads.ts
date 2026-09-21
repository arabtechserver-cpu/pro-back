import fs from 'fs';
import path from 'path';

function isDirectoryWritable(dirPath: string): boolean {
  try {
    fs.accessSync(dirPath, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the upload directory path.
 * Priority:
 * 1. process.env.UPLOADS_DIR (if specified and writable)
 * 2. /app/uploads (Mounted Persistent Volume in Docker container, if writable)
 * 3. Local fallback: path.join(process.cwd(), 'uploads') or public/uploads
 */
export function getUploadDir(): string {
  if (process.env.UPLOADS_DIR) {
    return process.env.UPLOADS_DIR;
  }

  // In Docker runner (WORKDIR is /app), volume mount path is /app/uploads
  if (fs.existsSync('/app/uploads') && isDirectoryWritable('/app/uploads')) {
    return '/app/uploads';
  }

  if (fs.existsSync('/app')) {
    try {
      if (!fs.existsSync('/app/uploads')) {
        fs.mkdirSync('/app/uploads', { recursive: true });
      }
      if (isDirectoryWritable('/app/uploads')) {
        return '/app/uploads';
      }
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
    isDirectoryWritable(dir);
  } catch (err: any) {
    console.error(`[Uploads] Failed to create directory ${dir}:`, err?.message || err);
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
    return filePath;
  } catch (err: any) {
    console.error(`[Uploads] Error writing file to primary upload dir ${filePath}:`, err?.message || err);
    try {
      const fallbackDir = path.join(process.cwd(), 'uploads');
      if (!fs.existsSync(fallbackDir)) fs.mkdirSync(fallbackDir, { recursive: true });
      const fallbackPath = path.join(fallbackDir, filename);
      fs.writeFileSync(fallbackPath, buffer);
      console.log(`[Uploads] Saved to fallback location: ${fallbackPath}`);
      return fallbackPath;
    } catch (fbErr: any) {
      throw new Error(`Failed to write file to storage volume: ${err?.message || err}`);
    }
  }
}

/**
 * Checks if a file exists in the uploads volume.
 */
export function getUploadFilePath(filename: string): string | null {
  const safeFilename = path.basename(filename);
  const uploadDir = getUploadDir();
  const primaryPath = path.join(uploadDir, safeFilename);
  if (fs.existsSync(primaryPath)) return primaryPath;

  // Secondary fallback checks
  const secondaryPath = path.join(process.cwd(), 'public/uploads', safeFilename);
  if (fs.existsSync(secondaryPath)) return secondaryPath;

  const appUploadsFallback = path.join('/app/uploads', safeFilename);
  if (fs.existsSync(appUploadsFallback)) return appUploadsFallback;

  const localUploadsFallback = path.join(process.cwd(), 'uploads', safeFilename);
  if (fs.existsSync(localUploadsFallback)) return localUploadsFallback;

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
    let failedCount = 0;
    for (const img of images) {
      if (!img.filename || !img.data) continue;
      const targetPath = path.join(uploadDir, img.filename);
      if (!fs.existsSync(targetPath)) {
        try {
          const buffer = Buffer.from(img.data, 'base64');
          fs.writeFileSync(targetPath, buffer);
          restoredCount++;
        } catch (e: any) {
          failedCount++;
          if (failedCount <= 2) {
            console.error(`[Uploads] Error restoring image ${img.filename}:`, e?.message || e);
          }
        }
      }
    }

    if (failedCount > 2) {
      console.warn(`[Uploads] Suppressed ${failedCount - 2} additional image restore warnings due to disk permissions.`);
    }

    if (restoredCount > 0) {
      console.log(`[Uploads] Restored ${restoredCount} image(s) to server disk at: ${uploadDir}`);
    }
    return restoredCount;
  } catch (err: any) {
    console.error('[Uploads] restoreImagesToDisk error:', err?.message || err);
    return 0;
  }
}

