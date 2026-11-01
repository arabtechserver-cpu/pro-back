import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function run() {
  if (process.env.NODE_ENV !== 'development' || process.env.ALLOW_DEV_SEED !== 'true') {
    throw new Error('Development account seeding is disabled. Use an isolated development database and ALLOW_DEV_SEED=true.');
  }
  const password = process.env.DEV_SEED_PASSWORD;
  if (!password || password.length < 16) throw new Error('Set DEV_SEED_PASSWORD with at least 16 characters');
  try {
    console.log("Creating Admin User...");
    const hashedPassword = await bcrypt.hash(password, 12);
    const admin = await prisma.user.create({
      data: {
        fullName: 'System Administrator',
        email: 'admin@admin.com',
        username: 'admin',
        password: hashedPassword,
        country: 'EG',
        role: 'admin', // The schema default is "user", probably uses lowercase "admin" in code.
        status: 'active',
        balance: 1000.0,
      }
    });
    console.log("Admin User Created successfully!");
    console.log("Email: admin@admin.com");

  } catch (error) {
    console.error("Error setting up DB:", error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
