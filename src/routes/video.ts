import { Router } from 'express';
import { prisma } from '../server';
import { authenticateToken } from '../middleware/auth';

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
router.post('/series', authenticateToken, async (req, res) => {
  try {
    const { titleEn, titleAr, descriptionEn, descriptionAr, isSubscriptionRequired, price, thumbnail } = req.body;
    const series = await prisma.videoSeries.create({
      data: {
        titleEn,
        titleAr,
        descriptionEn,
        descriptionAr,
        isSubscriptionRequired,
        price,
        thumbnail
      }
    });
    res.status(201).json(series);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create video series' });
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

// POST new video tutorial
router.post('/tutorials', authenticateToken, async (req, res) => {
  try {
    const { titleEn, titleAr, descriptionEn, descriptionAr, videoUrl, thumbnail, category, seriesId, orderIndex, isFreePreview } = req.body;
    const tutorial = await prisma.videoTutorial.create({
      data: {
        titleEn,
        titleAr,
        descriptionEn,
        descriptionAr,
        videoUrl,
        thumbnail,
        category,
        seriesId: seriesId || null,
        orderIndex: orderIndex || 0,
        isFreePreview: isFreePreview !== undefined ? isFreePreview : true
      }
    });
    res.status(201).json(tutorial);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create video tutorial' });
  }
});

export default router;
