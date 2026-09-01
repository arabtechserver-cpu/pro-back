import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();
const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.set('trust proxy', 1);

app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '150mb' }));
app.use(express.urlencoded({ limit: '150mb', extended: true }));

import path from 'path';
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders: (res) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
}));

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
