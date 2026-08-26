import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function run() {
  try {
    console.log("Creating Test User...");
    const hashedPassword = await bcrypt.hash('123456', 10);
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
    console.log("Password: 123456");
  } catch (error) {
    console.error("Error setting up DB:", error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
