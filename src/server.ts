import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { prisma } from './utils/prisma';
import { publicFileGuard } from './middleware/publicFileGuard';
import { getTrustedProxies } from './utils/trustedProxy';
import { startTelegramBotPolling } from './utils/telegramService';
const app = express();
app.use(compression());
const PORT = Number(process.env.PORT) || 5000;
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

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
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin is not allowed by CORS'));
  },
  credentials: true,
}));
const generalJsonParser = express.json({ limit: '5mb' });
const imageJsonParser = express.json({ limit: '15mb' });

app.use((req, res, next) => {
  if (req.path.startsWith('/api/upload') || req.path.startsWith('/api/transactions')) {
    return imageJsonParser(req, res, next);
  }
  return generalJsonParser(req, res, next);
});
process.on('unhandledRejection', (reason: any) => {
  console.error('[UNHANDLED REJECTION]', {
    message: reason?.message || String(reason),
    stack: reason?.stack || 'No stack trace',
    reason
  });
});

process.on('uncaughtException', (error: Error) => {
  console.error('[UNCAUGHT EXCEPTION]', {
    name: error.name,
    message: error.message,
    stack: error.stack
  });
});

app.use(express.urlencoded({ limit: '5mb', extended: true }));

app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = function (body: any) {
    if (res.statusCode >= 400) {
      const errMsg = body?.error || body?.message || (typeof body === 'string' ? body : JSON.stringify(body));
      console.error(`[HTTP ${res.statusCode} ERROR] ${req.method} ${req.originalUrl} - IP: ${req.ip} - User: ${(req as any).user?.username || 'Guest'} - Error: ${errMsg}`);
    }
    return originalJson(body);
  };

  res.send = function (body: any) {
    if (res.statusCode >= 400) {
      const errMsg = typeof body === 'string' ? body.slice(0, 300) : '';
      console.error(`[HTTP ${res.statusCode} ERROR] ${req.method} ${req.originalUrl} - IP: ${req.ip} - User: ${(req as any).user?.username || 'Guest'} - ${errMsg}`);
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

app.use('/api/auth', authRoutes);
app.use('/api/coupons', couponsRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/currencies', currenciesRoutes);
app.use('/api/wallet/paypal', paypalRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/blog', blogRoutes);
app.use('/api/dhru', dhruRoutes);
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
app.use('/api/settings', settingsRoutes);
app.use('/api/ip-access', ipAccessRoutes);
app.use('/api/admin/ip-access', ipAccessRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

// 404 Handler for unknown /api routes
app.use('/api', (req, res) => {
  console.warn(`[API 404 NOT FOUND] ${req.method} ${req.originalUrl} - IP: ${req.ip}`);
  res.status(404).json({ error: `المسار المطلوب غير موجود: ${req.method} ${req.originalUrl}` });
});

// Global Express Error Handling Middleware
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(`[EXPRESS UNHANDLED ERROR] ${req.method} ${req.originalUrl}:`, {
    message: err?.message || String(err),
    stack: err?.stack || 'No stack trace',
    ip: req.ip,
    user: (req as any).user?.username || 'Guest',
    body: req.body
  });

  if (res.headersSent) {
    return next(err);
  }

  const statusCode = Number(err?.status || err?.statusCode) || 500;
  res.status(statusCode).json({
    error: err?.message || 'حدث خطأ داخلي في الخادم'
  });
});

async function startServer() {
  try {
    await bootstrapDatabase();
    await startTelegramBotPolling();
    await restoreImagesToDisk(prisma).catch(() => {});
    initOrderSyncCron();
    initBackupCron();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Backend server is running on http://0.0.0.0:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to initialize and start server:', error);
    process.exit(1);
  }
}

startServer();
