import { PrismaClient } from '@prisma/client';

let databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && databaseUrl.includes('pro-1-aerorj')) {
  databaseUrl = databaseUrl.replace('pro-1-aerorj', '127.0.0.1');
}

export const prisma = new PrismaClient(
  databaseUrl ? { datasources: { db: { url: databaseUrl } } } : undefined
);
