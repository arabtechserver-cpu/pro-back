import fs from 'fs';
import path from 'path';

export const processBase64Images = (htmlContent: string | undefined | null, baseUrl: string): string => {
  if (!htmlContent) return '';

  return htmlContent.replace(/src="data:image\/(.*?);base64,([^"]+)"/g, (match, ext, data) => {
    try {
      const filename = `image_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
      const uploadDir = path.join(__dirname, '../../public/uploads');
      
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      
      const filepath = path.join(uploadDir, filename);
      fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
      
      return `src="${baseUrl}/uploads/${filename}"`;
    } catch (error) {
      console.error("Failed to process base64 image", error);
      // Fallback to original match if something goes wrong
      return match;
    }
  });
};
