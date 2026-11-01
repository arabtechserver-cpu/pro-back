import sharp from 'sharp';

export class InvalidImageError extends Error {}
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const mimeFormats: Record<string, string> = {
  'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif'
};

// Bound native decoder memory/cache use on small servers. Admission control
// also limits how many image requests can reach this decoder concurrently.
sharp.cache(false);
sharp.concurrency(1);

export async function sanitizeImageDataUri(input: unknown, allowGif = false) {
  if (typeof input !== 'string' || input.length > Math.ceil(MAX_BYTES / 3) * 4 + 64) {
    throw new InvalidImageError('حجم الصورة غير صالح أو يتجاوز 10 ميجابايت');
  }
  const match = /^data:(image\/[a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(input);
  const format = match && mimeFormats[match[1].toLowerCase()];
  if (!match || !format || (!allowGif && format === 'gif')) {
    throw new InvalidImageError('صيغة الصورة غير مدعومة أو محتواها غير صالح');
  }
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_BYTES || buffer.toString('base64').replace(/=+$/, '') !== match[2].replace(/=+$/, '')) {
    throw new InvalidImageError('بيانات الصورة غير صالحة');
  }
  try {
    const options = { limitInputPixels: MAX_PIXELS, failOn: 'warning' as const, animated: false };
    const metadata = await sharp(buffer, options).metadata();
    if (metadata.format !== format || !metadata.width || !metadata.height ||
        metadata.width * metadata.height > MAX_PIXELS || (metadata.pages || 1) > 1) {
      throw new InvalidImageError('الصورة كبيرة جداً أو متعددة الإطارات أو لا تطابق نوعها');
    }
    // Decode and re-encode: signatures alone allow truncated files and payloads
    // appended to images. WebP output strips metadata and trailing content.
    const clean = await sharp(buffer, options).rotate().webp({ quality: 85 }).timeout({ seconds: 5 }).toBuffer();
    if (clean.length > MAX_BYTES) throw new InvalidImageError('الصورة كبيرة جداً');
    return { buffer: clean, mimeType: 'image/webp', extension: 'webp', base64: clean.toString('base64') };
  } catch (error) {
    if (error instanceof InvalidImageError) throw error;
    throw new InvalidImageError('تعذر قراءة الصورة؛ ارفع صورة سليمة بصيغة JPG أو PNG أو WEBP');
  }
}
