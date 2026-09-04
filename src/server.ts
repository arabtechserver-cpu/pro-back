import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { prisma } from './utils/prisma';
const app = express();
const PORT = Number(process.env.PORT) || 5000;
const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.set('trust proxy', 1);

app.use(helmet({
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
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

import path from 'path';
import { getUploadDir, ensureUploadDir } from './utils/uploads';
ensureUploadDir();
app.use(express.static(path.join(__dirname, '../public')));
app.use('/uploads', express.static(getUploadDir(), { maxAge: '30d', immutable: true }));

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

app.use('/api/auth', authRoutes);
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
app.use('/api/media', uploadRoutes);
app.use('/uploads', uploadRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/memberships', membershipsRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/telemetry', analyticsRoutes);
app.use('/api/app-events', analyticsRoutes);
app.use('/api/backup', backupRoutes);
app.use('/api/newsletter', newsletterRoutes);
app.use('/api/v1/provider', externalApiRoutes); // Dhru compatible API endpoint

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Backend is running' });
});

import { initOrderSyncCron } from './cron/orderSync';
import { initBackupCron } from './cron/backupDb';
import { bootstrapDatabase } from './utils/bootstrap';

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server is running on http://0.0.0.0:${PORT}`);
  initOrderSyncCron();
  initBackupCron();
  bootstrapDatabase();
});
