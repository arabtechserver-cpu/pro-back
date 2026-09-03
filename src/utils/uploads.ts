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
 * Saves a binary buffer to the persistent upload volume.
 */
export function saveBufferToUploads(filename: string, buffer: Buffer): string {
  const uploadDir = ensureUploadDir();
  const filePath = path.join(uploadDir, filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Checks if a file exists in the uploads volume.
 */
export function getUploadFilePath(filename: string): string | null {
  const uploadDir = getUploadDir();
  const primaryPath = path.join(uploadDir, filename);
  if (fs.existsSync(primaryPath)) return primaryPath;

  // Secondary fallback checks (in case files were in old public/uploads)
  const secondaryPath = path.join(process.cwd(), 'public/uploads', filename);
  if (fs.existsSync(secondaryPath)) return secondaryPath;

  const appUploadsFallback = path.join('/app/uploads', filename);
  if (fs.existsSync(appUploadsFallback)) return appUploadsFallback;

  return null;
}
