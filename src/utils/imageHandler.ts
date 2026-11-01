import crypto from 'crypto';
import { saveBufferToUploads } from './uploads';
import { sanitizeImageDataUri, InvalidImageError } from './safe-image';

export async function saveArticleImage(input: unknown, baseUrl: string): Promise<string> {
  const image = await sanitizeImageDataUri(input, true);
  const filename = `article_${crypto.randomUUID()}.${image.extension}`;
  saveBufferToUploads(filename, image.buffer);
  return `${baseUrl}/uploads/${filename}`;
}

export async function processBase64Images(htmlContent: string | undefined | null, baseUrl: string): Promise<string> {
  if (!htmlContent) return '';
  if (typeof htmlContent !== 'string' || htmlContent.length > 5 * 1024 * 1024) throw new InvalidImageError('Invalid article content');
  const pattern = /src=(["'])(data:image\/[^"']+)\1/gi;
  let result = '';
  let offset = 0;
  let count = 0;
  for (const match of htmlContent.matchAll(pattern)) {
    if (++count > 10) throw new InvalidImageError('Maximum 10 embedded images per article');
    const url = await saveArticleImage(match[2], baseUrl);
    result += htmlContent.slice(offset, match.index) + `src="${url}"`;
    offset = match.index! + match[0].length;
  }
  return result + htmlContent.slice(offset);
}
