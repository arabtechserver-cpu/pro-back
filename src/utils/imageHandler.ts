import fs from 'fs';
import path from 'path';
import { getUploadDir, ensureUploadDir } from './uploads';

const ALLOWED_IMAGE_EXTENSIONS: Record<string, string> = {
  'jpeg': 'jpg',
  'jpg': 'jpg',
  'png': 'png',
  'webp': 'webp',
  'gif': 'gif'
};

export const processBase64Images = (htmlContent: string | undefined | null, baseUrl: string): string => {
  if (!htmlContent) return '';

  return htmlContent.replace(/src="data:image\/([a-zA-Z0-9+.-]+);base64,([^"]+)"/g, (match, rawExt, data) => {
    try {
      const normalizedExt = String(rawExt).toLowerCase().trim();
      const safeExt = ALLOWED_IMAGE_EXTENSIONS[normalizedExt];
      if (!safeExt) {
        return match;
      }

      const buffer = Buffer.from(data, 'base64');
      if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
        return match;
      }

      const safeFilename = `article_${Date.now()}_${Math.random().toString(36).substring(2, 10)}.${safeExt}`;
      const uploadDir = ensureUploadDir();
      const resolvedTarget = path.resolve(uploadDir, safeFilename);
      const resolvedRoot = path.resolve(uploadDir);

      if (!resolvedTarget.startsWith(resolvedRoot)) {
        return match;
      }

      fs.writeFileSync(resolvedTarget, buffer);
      return `src="${baseUrl}/uploads/${safeFilename}"`;
    } catch (error) {
      console.error("Failed to process base64 image", error);
      return match;
    }
  });
};
