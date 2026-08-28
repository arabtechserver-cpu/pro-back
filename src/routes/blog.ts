import { Router } from 'express';
import { prisma } from '../server';
import { authenticateToken } from '../middleware/auth';
import { processBase64Images } from '../utils/imageHandler';

const router = Router();

// GET all blogs
router.get('/posts', async (req, res) => {
  try {
    const posts = await prisma.blogPost.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(posts);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch posts' });
  }
});

// GET single blog post
router.get('/posts/:id', async (req, res) => {
  try {
    const post = await prisma.blogPost.findUnique({
      where: { id: req.params.id }
    });
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }
    res.json(post);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch post' });
  }
});

// GET all tutorials
router.get('/tutorials', async (req, res) => {
  try {
    const tutorials = await prisma.videoTutorial.findMany({ orderBy: { createdAt: 'desc' } });
    res.json(tutorials);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tutorials' });
  }
});

// GET single tutorial
router.get('/tutorials/:id', async (req, res) => {
  try {
    const tutorial = await prisma.videoTutorial.findUnique({
      where: { id: req.params.id }
    });
    if (!tutorial) {
      return res.status(404).json({ error: 'Tutorial not found' });
    }
    res.json(tutorial);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tutorial' });
  }
});

import { broadcastNewItemToSubscribers } from './newsletter';

// POST new blog
router.post('/post', authenticateToken, async (req, res) => {
  try {
    const data = req.body;
    
    // Process any base64 images in HTML and save them to /public/uploads
    // Assuming backend runs on port 3001
    const baseUrl = 'https://api.arabtechproserver.tech';
    
    const processedContentEn = processBase64Images(data.contentEn, baseUrl);
    const processedContentAr = processBase64Images(data.contentAr, baseUrl);
    
    // The main thumbnail could be a direct base64 string
    let processedImageUrl = data.imageUrl;
    if (processedImageUrl && processedImageUrl.startsWith('data:image/')) {
      const imgMatch = processedImageUrl.match(/^data:image\/(.*?);base64,(.+)$/);
      if (imgMatch) {
        const ext = imgMatch[1];
        const base64Data = imgMatch[2];
        const fs = require('fs');
        const path = require('path');
        const filename = `thumb_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
        const uploadDir = path.join(__dirname, '../../public/uploads');
        if (!fs.existsSync(uploadDir)) {
          fs.mkdirSync(uploadDir, { recursive: true });
        }
        fs.writeFileSync(path.join(uploadDir, filename), Buffer.from(base64Data, 'base64'));
        processedImageUrl = `${baseUrl}/uploads/${filename}`;
      }
    }

    const post = await prisma.blogPost.create({
      data: {
        titleEn: data.titleEn,
        titleAr: data.titleAr,
        excerptEn: data.excerptEn,
        excerptAr: data.excerptAr,
        contentEn: processedContentEn,
        contentAr: processedContentAr,
        imageUrl: processedImageUrl,
        category: data.category
      }
    });

    // Notify subscribers in background about the new article
    broadcastNewItemToSubscribers({
      title: `مقال جديد: ${post.titleAr || post.titleEn}`,
      message: `${post.excerptAr || post.excerptEn}\n\nتم نشر مقال جديد في مدونة عرب تك برو سيرفر. اضغط على الرابط لقراءة المقال كاملاً والاستفادة من الشرح.`,
      category: "Blog",
      actionUrl: `https://arabtechproserver.tech/ar/blog/${post.id}`,
      actionText: "قراءة المقال الآن"
    }).catch((err) => console.error("Error sending blog newsletter:", err));

    res.status(201).json(post);
  } catch (error) {
    console.error("Error creating blog post:", error);
    res.status(500).json({ error: 'Failed to create blog post' });
  }
});

// POST new tutorial
router.post('/tutorial', authenticateToken, async (req, res) => {
  try {
    const data = req.body;
    const tutorial = await prisma.videoTutorial.create({
      data: {
        titleEn: data.titleEn,
        titleAr: data.titleAr,
        videoUrl: data.youtubeId,
        category: data.category || "General"
      }
    });

    // Notify subscribers in background about the new video tutorial
    broadcastNewItemToSubscribers({
      title: `فيديو وشرح تعليمي جديد: ${tutorial.titleAr || tutorial.titleEn}`,
      message: `تم إضافة فيديو وشرح تعليمي جديد في أكاديمية عرب تك برو: ${tutorial.titleAr || tutorial.titleEn}. شاهد الفيديو الآن وتعلم طريقة التنفيذ خطوة بخطوة.`,
      category: "Tutorial",
      actionUrl: `https://arabtechproserver.tech/ar/tutorials/${tutorial.id}`,
      actionText: "مشاهدة الفيديو التعليمي"
    }).catch((err) => console.error("Error sending tutorial newsletter:", err));

    res.status(201).json(tutorial);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create tutorial' });
  }
});

export default router;
