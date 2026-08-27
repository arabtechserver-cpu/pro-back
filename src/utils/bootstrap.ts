import { prisma } from '../server';
import bcrypt from 'bcryptjs';
import { syncDhruServices } from '../scripts/syncDhruServices';

export async function bootstrapDatabase() {
  try {
    console.log('[Bootstrap] Checking database status...');

    // 1. Check & Ensure Admin User is Active
    const adminUser = await prisma.user.findFirst({
      where: {
        OR: [
          { email: 'admin@admin.com' },
          { username: 'admin' },
          { role: 'admin' }
        ]
      }
    });

    if (!adminUser) {
      console.log('[Bootstrap] No admin user found. Creating default admin user...');
      const hashedPassword = await bcrypt.hash('123456', 10);
      await prisma.user.create({
        data: {
          fullName: 'System Administrator',
          email: 'admin@admin.com',
          username: 'admin',
          password: hashedPassword,
          country: 'EG',
          role: 'admin',
          status: 'active',
          balance: 1000.0,
        },
      });
      console.log('[Bootstrap] Default Admin created (Email: admin@admin.com / Password: 123456)');
    } else {
      // Force ensure admin account is ACTIVE and has admin role
      await prisma.user.update({
        where: { id: adminUser.id },
        data: {
          status: 'active',
          role: 'admin'
        }
      });
      console.log('[Bootstrap] Admin account status restored to ACTIVE.');
    }

    // 2. Check & Sync Dhru Services
    const serviceCount = await prisma.dhruService.count();
    if (serviceCount === 0) {
      console.log('[Bootstrap] No Dhru services found in DB. Starting automatic services sync...');
      await syncDhruServices();
      console.log('[Bootstrap] Automatic services sync finished successfully!');
    } else {
      console.log(`[Bootstrap] Found ${serviceCount} existing Dhru services.`);
    }

  } catch (error) {
    console.error('[Bootstrap] Error during database bootstrap:', error);
  }
}
