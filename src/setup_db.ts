import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function run() {
  try {
    console.log("Creating Admin User...");
    const hashedPassword = await bcrypt.hash('123456', 10);
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
    console.log("Password: 123456");
  } catch (error) {
    console.error("Error setting up DB:", error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
