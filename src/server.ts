import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { prisma } from './utils/prisma';
import { publicFileGuard } from './middleware/publicFileGuard';
import { getTrustedProxies } from './utils/trustedProxy';
import { startTelegramBotPolling } from './utils/telegramService';
import { createResourceGuard } from './middleware/resourceGuard';
import rateLimit from 'express-rate-limit';
import { BoundedRateLimitStore } from './utils/bounded-rate-limit-store';
const app = express();
app.use(compression());
const PORT = Number(process.env.PORT) || 5000;
const allowedOrigins = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://arabtechproserver.tech',
  'https://www.arabtechproserver.tech',
  ...(process.env.FRONTEND_URL || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
];

app.set('trust proxy', getTrustedProxies());

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'none'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({
  origin(origin, callback) {
    if (
      !origin ||
      allowedOrigins.includes(origin) ||
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
      /^https?:\/\/(www\.)?arabtechproserver\.tech$/.test(origin)
    ) {
      return callback(null, true);
    }
    console.warn(`[CORS Blocked] Origin: ${origin}`);
    return callback(new Error(`Origin ${origin} is not allowed by CORS`));
  },
  credentials: true,
}));
const generalJsonParser = express.json({ limit: '5mb' });
const imageJsonParser = express.json({ limit: '15mb' });
app.use(createResourceGuard());

const globalApiLimiter = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Too many requests. Please slow down.' },
  validate: { xForwardedForHeader: false },
  skip: (req) => req.path === '/api/health' || req.path.startsWith('/api/wallet/paypal/webhook') || req.path.startsWith('/api/wallet/binance/webhook')
});

app.use('/api', globalApiLimiter);

app.use((req, res, next) => {
  if (req.path.startsWith('/api/upload') || req.path.startsWith('/api/transactions')) {
    return imageJsonParser(req, res, next);
  }
  return generalJsonParser(req, res, next);
});
process.on('unhandledRejection', (reason: any) => {
  console.error('[UNHANDLED REJECTION]', {
    name: reason?.name || 'Error',
    code: reason?.code || 'UNHANDLED_REJECTION'
  });
});

process.on('uncaughtException', (error: Error) => {
  console.error('[UNCAUGHT EXCEPTION]', {
    name: error.name,
    code: 'UNCAUGHT_EXCEPTION'
  });
  process.exit(1);
});

app.use(express.urlencoded({ limit: '5mb', extended: true }));

app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = function (body: any) {
    if (res.statusCode >= 500) {
      const errMsg = body?.error || body?.message || (typeof body === 'string' ? body : JSON.stringify(body));
      console.error(`[HTTP ${res.statusCode} SERVER ERROR] ${req.method} ${req.path} - IP: ${req.ip} - User: ${(req as any).user?.username || 'Guest'} - Error: ${errMsg}`);
    } else if (res.statusCode >= 400 && res.statusCode !== 404) {
      const errMsg = body?.error || body?.message || (typeof body === 'string' ? body : JSON.stringify(body));
      console.warn(`[HTTP ${res.statusCode} CLIENT] ${req.method} ${req.path} - IP: ${req.ip} - User: ${(req as any).user?.username || 'Guest'} - Notice: ${errMsg}`);
    }
    return originalJson(body);
  };

  res.send = function (body: any) {
    if (res.statusCode >= 500) {
      const errMsg = typeof body === 'string' ? body.slice(0, 300) : '';
      console.error(`[HTTP ${res.statusCode} SERVER ERROR] ${req.method} ${req.path} - IP: ${req.ip} - User: ${(req as any).user?.username || 'Guest'} - ${errMsg}`);
    } else if (res.statusCode >= 400 && res.statusCode !== 404) {
      const errMsg = typeof body === 'string' ? body.slice(0, 300) : '';
      console.warn(`[HTTP ${res.statusCode} CLIENT] ${req.method} ${req.path} - IP: ${req.ip} - User: ${(req as any).user?.username || 'Guest'} - ${errMsg}`);
    }
    return originalSend(body);
  };

  next();
});

import path from 'path';
import { getUploadDir, ensureUploadDir, restoreImagesToDisk } from './utils/uploads';
import { bootstrapDatabase } from './utils/bootstrap';
import { initOrderSyncCron } from './cron/orderSync';
import { initBackupCron } from './cron/backupDb';
import { startFoxreloadCatalogWarmup } from './services/foxreloadService';

ensureUploadDir();
// Guard each static mount, after Express has stripped the mount prefix.
// Authenticated transaction routes below are deliberately outside these mounts.
app.use('/uploads', publicFileGuard, express.static(getUploadDir(), { maxAge: '30d', immutable: true }));
app.use((req, res, next) => {
  if (req.path.toLowerCase().startsWith('/api/')) return next();
  return publicFileGuard(req, res, next);
}, express.static(path.join(__dirname, '../public')));

// Routes
import authRoutes from './routes/auth';
import ordersRoutes from './routes/orders';
import walletRoutes from './routes/wallet';
import blogRoutes from './routes/blog';
import dhruRoutes from './routes/dhru';
import videoRoutes from './routes/video';
import homepageRoutes from './routes/homepage';
import uploadRoutes from './routes/upload';
import usersRoutes from './routes/users';
import transactionsRoutes from './routes/transactions';
import paypalRoutes from './routes/paypal';
import binanceRoutes from './routes/binance';
import analyticsRoutes from './routes/analytics';
import backupRoutes from './routes/backup';
import newsletterRoutes from './routes/newsletter';
import providersRoutes from './routes/providers';
import membershipsRoutes from './routes/memberships';
import aiRoutes from './routes/ai';
import currenciesRoutes from './routes/currencies';
import externalApiRoutes from './routes/externalApi';
import couponsRoutes from './routes/coupons';
import settingsRoutes from './routes/settings';
import ipAccessRoutes from './routes/ipAccess';
import foxreloadRoutes from './routes/foxreload';

app.use('/api/auth', authRoutes);
app.use('/api/coupons', couponsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/currencies', currenciesRoutes);
app.use('/api/wallet/paypal', paypalRoutes);
app.use('/api/wallet/binance', binanceRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/dhru', dhruRoutes);
app.use('/api/foxreload', foxreloadRoutes);
app.use('/api/providers', providersRoutes);
app.use('/api/api-providers', providersRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/homepage', homepageRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/telemetry', analyticsRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/newsletter', newsletterRoutes);
app.use('/api/memberships', membershipsRoutes);
app.use('/api/external', externalApiRoutes);
app.use('/api/dhru/api', externalApiRoutes);
app.use('/api/v1/provider', externalApiRoutes);
app.use('/api/provider', externalApiRoutes);
app.use('/api/index.php', externalApiRoutes);
app.use('/api/v1/index.php', externalApiRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/ip-access', ipAccessRoutes);
app.use('/api/admin/ip-access', ipAccessRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

// 404 Handler for unknown /api routes
app.use('/api', (req, res) => {
  console.warn(`[API 404 NOT FOUND] ${req.method} ${req.path} - IP: ${req.ip}`);
  res.status(404).json({ error: `المسار المطلوب غير موجود: ${req.method} ${req.path}` });
});

// Global Express Error Handling Middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(`[EXPRESS UNHANDLED ERROR] ${req.method} ${req.path}:`, {
    name: err?.name || 'Error',
    code: err?.code || err?.type || 'INTERNAL_ERROR',
    ip: req.ip,
    user: (req as any).user?.username || 'Guest',
  });

  if (res.headersSent) {
    return next(err);
  }

  const statusCode = Number(err?.status || err?.statusCode) || 500;
  res.status(statusCode).json({
    error: statusCode >= 500 ? 'حدث خطأ داخلي في الخادم' : (err?.type === 'entity.too.large' ? 'Request body exceeds the allowed size' : 'Invalid request')
  });
});

async function startServer() {
  try {
    if (process.env.STARTUP_MAINTENANCE !== 'false') {
      await bootstrapDatabase();
      await restoreImagesToDisk(prisma).catch(() => {});
    }
    if (process.env.BACKGROUND_JOBS_ENABLED !== 'false') {
      await startTelegramBotPolling();
      initOrderSyncCron();
      initBackupCron();
      startFoxreloadCatalogWarmup();
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Backend server is running on http://0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to initialize and start server:', error);
    process.exit(1);
  }
}

startServer();
