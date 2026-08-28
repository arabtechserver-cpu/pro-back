import { Router } from 'express';
import { prisma } from '../server';
import { isAdmin } from '../middleware/auth';

const router = Router();

// GET all video series (with their videos)
router.get('/series', async (req, res) => {
  try {
    const series = await prisma.videoSeries.findMany({
      include: {
        videos: {
          orderBy: {
            orderIndex: 'asc'
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });
    res.json(series);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch video series' });
  }
});

// GET a specific video series by ID
router.get('/series/:id', async (req, res) => {
  try {
    const series = await prisma.videoSeries.findUnique({
      where: { id: req.params.id },
      include: {
        videos: {
          orderBy: {
            orderIndex: 'asc'
          }
        }
      }
    });
    if (!series) {
      return res.status(404).json({ error: 'Video series not found' });
    }
    res.json(series);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch video series' });
  }
});

// POST new video series
router.post('/series', isAdmin, async (req, res) => {
  try {
    const { titleEn, titleAr, descriptionEn, descriptionAr, isSubscriptionRequired, price, thumbnail } = req.body;
    const series = await prisma.videoSeries.create({
      data: {
        titleEn: titleEn || '',
        titleAr: titleAr || '',
        descriptionEn: descriptionEn || null,
        descriptionAr: descriptionAr || null,
        isSubscriptionRequired: Boolean(isSubscriptionRequired),
        price: price !== undefined && price !== null ? parseFloat(price) : null,
        thumbnail: thumbnail || null
      }
    });
    res.status(201).json(series);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create video series' });
  }
});

// PUT update video series
router.put('/series/:id', isAdmin, async (req, res) => {
  try {
    const id = req.params.id as string;
    const { titleEn, titleAr, descriptionEn, descriptionAr, isSubscriptionRequired, price, thumbnail } = req.body;

    const updated = await prisma.videoSeries.update({
      where: { id },
      data: {
        titleEn: titleEn !== undefined ? titleEn : undefined,
        titleAr: titleAr !== undefined ? titleAr : undefined,
        descriptionEn: descriptionEn !== undefined ? descriptionEn : undefined,
        descriptionAr: descriptionAr !== undefined ? descriptionAr : undefined,
        isSubscriptionRequired: isSubscriptionRequired !== undefined ? Boolean(isSubscriptionRequired) : undefined,
        price: price !== undefined ? (price !== null && price !== '' ? parseFloat(price) : null) : undefined,
        thumbnail: thumbnail !== undefined ? thumbnail : undefined
      }
    });

    res.json({ success: true, series: updated });
  } catch (error) {
    console.error('Update series error:', error);
    res.status(500).json({ error: 'Failed to update video series' });
  }
});

// DELETE video series
router.delete('/series/:id', isAdmin, async (req, res) => {
  try {
    const id = req.params.id as string;
    
    // First detach any tutorials linked to this series
    await prisma.videoTutorial.updateMany({
      where: { seriesId: id },
      data: { seriesId: null }
    });

    await prisma.videoSeries.delete({
      where: { id }
    });

    res.json({ success: true, message: 'Series deleted successfully' });
  } catch (error) {
    console.error('Delete series error:', error);
    res.status(500).json({ error: 'Failed to delete video series' });
  }
});

// GET all video tutorials (optionally filter by seriesId)
router.get('/tutorials', async (req, res) => {
  try {
    const { seriesId } = req.query;
    
    let whereClause = {};
    if (seriesId) {
      whereClause = { seriesId: String(seriesId) };
    }

    const tutorials = await prisma.videoTutorial.findMany({
      where: whereClause,
      include: {
        series: true
      },
      orderBy: [
        { seriesId: 'asc' },
        { orderIndex: 'asc' },
        { createdAt: 'desc' }
      ]
    });
    res.json(tutorials);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch tutorials' });
  }
});

// GET single video tutorial
router.get('/tutorials/:id', async (req, res) => {
  try {
    const tutorial = await prisma.videoTutorial.findUnique({
      where: { id: req.params.id },
      include: {
        series: true
      }
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

// POST new video tutorial
router.post('/tutorials', isAdmin, async (req, res) => {
  try {
    const { titleEn, titleAr, descriptionEn, descriptionAr, videoUrl, thumbnail, category, seriesId, orderIndex, isFreePreview } = req.body;
    const tutorial = await prisma.videoTutorial.create({
      data: {
        titleEn: titleEn || '',
        titleAr: titleAr || '',
        descriptionEn: descriptionEn || null,
        descriptionAr: descriptionAr || null,
        videoUrl,
        thumbnail: thumbnail || null,
        category: category || null,
        seriesId: seriesId || null,
        orderIndex: orderIndex !== undefined ? parseInt(orderIndex) || 0 : 0,
        isFreePreview: isFreePreview !== undefined ? Boolean(isFreePreview) : true
      }
    });

    // Notify subscribers about new tutorial
    broadcastNewItemToSubscribers({
      title: `درس وفيديو جديد: ${tutorial.titleAr || tutorial.titleEn}`,
      message: `تمت إضافة شرح تعليمي جديد: ${tutorial.titleAr || tutorial.titleEn}. تفضل بمشاهدة الفيديو والتطبيق العملي.`,
      category: "Tutorial",
      actionUrl: `https://arabtechproserver.tech/ar/tutorials/${tutorial.id}`,
      actionText: "مشاهدة الفيديو"
    }).catch(() => {});

    res.status(201).json(tutorial);
  } catch (error) {
    console.error('Create tutorial error:', error);
    res.status(500).json({ error: 'Failed to create video tutorial' });
  }
});

// PUT update video tutorial
router.put('/tutorials/:id', isAdmin, async (req, res) => {
  try {
    const id = req.params.id as string;
    const { titleEn, titleAr, descriptionEn, descriptionAr, videoUrl, thumbnail, category, seriesId, orderIndex, isFreePreview } = req.body;

    const updated = await prisma.videoTutorial.update({
      where: { id },
      data: {
        titleEn: titleEn !== undefined ? titleEn : undefined,
        titleAr: titleAr !== undefined ? titleAr : undefined,
        descriptionEn: descriptionEn !== undefined ? descriptionEn : undefined,
        descriptionAr: descriptionAr !== undefined ? descriptionAr : undefined,
        videoUrl: videoUrl !== undefined ? videoUrl : undefined,
        thumbnail: thumbnail !== undefined ? thumbnail : undefined,
        category: category !== undefined ? category : undefined,
        seriesId: seriesId !== undefined ? (seriesId || null) : undefined,
        orderIndex: orderIndex !== undefined ? parseInt(orderIndex) || 0 : undefined,
        isFreePreview: isFreePreview !== undefined ? Boolean(isFreePreview) : undefined
      }
    });

    res.json({ success: true, tutorial: updated });
  } catch (error) {
    console.error('Update tutorial error:', error);
    res.status(500).json({ error: 'Failed to update video tutorial' });
  }
});

// DELETE video tutorial
router.delete('/tutorials/:id', isAdmin, async (req, res) => {
  try {
    const id = req.params.id as string;

    await prisma.videoTutorial.delete({
      where: { id }
    });

    res.json({ success: true, message: 'Tutorial deleted successfully' });
  } catch (error) {
    console.error('Delete tutorial error:', error);
    res.status(500).json({ error: 'Failed to delete video tutorial' });
  }
});

export default router;
