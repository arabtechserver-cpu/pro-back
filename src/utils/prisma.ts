import { PrismaClient } from '@prisma/client';

let databaseUrl = process.env.DATABASE_URL;
// Only fallback on local Windows dev machine where internal Docker hostname cannot resolve
if (process.platform === 'win32' && databaseUrl && databaseUrl.includes('pro-1-aerorj')) {
  databaseUrl = databaseUrl.replace('pro-1-aerorj', '127.0.0.1');
}

export const prisma = new PrismaClient(
  databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined
);
