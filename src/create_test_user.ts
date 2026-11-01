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
    console.log("Creating Test User...");
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        fullName: 'Test User',
        email: 'user@test.com',
        username: 'testuser',
        password: hashedPassword,
        country: 'EG',
        role: 'user', 
        status: 'active',
        balance: 100.0,
      }
    });
    console.log("Test User Created successfully!");
    console.log("Email: user@test.com");

  } catch (error) {
    console.error("Error setting up DB:", error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
