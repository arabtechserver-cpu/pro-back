import { prisma } from '../utils/prisma';
import { normalizeIp, isValidIp } from '../utils/ipUtils';
import {
  IP_RESTRICTION_SETTING_KEY,
  MAX_ALLOWED_IPS
} from '../services/ipAccessService';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  if (!command || command === '--help' || command === '-h') {
    console.log(`
Dashboard IP Restriction - Emergency Server Management Utility
Usage:
  npx tsx src/scripts/resetIpRestriction.ts --status
  npx tsx src/scripts/resetIpRestriction.ts --disable
  npx tsx src/scripts/resetIpRestriction.ts --enable
  npx tsx src/scripts/resetIpRestriction.ts --add-ip <IP> [label]
  npx tsx src/scripts/resetIpRestriction.ts --list
    `);
    process.exit(0);
  }

  if (command === '--status') {
    const setting = await prisma.setting.findUnique({
      where: { key: IP_RESTRICTION_SETTING_KEY }
    });
    const enabled = setting?.value === 'true' || setting?.value === '1';
    const count = await prisma.allowedDashboardIP.count();
    console.log(`Restriction status: ${enabled ? 'ENABLED' : 'DISABLED'}`);
    console.log(`Allowed IPs count: ${count} / ${MAX_ALLOWED_IPS}`);
    process.exit(0);
  }

  if (command === '--disable' || command === '--off') {
    await prisma.setting.upsert({
      where: { key: IP_RESTRICTION_SETTING_KEY },
      create: { key: IP_RESTRICTION_SETTING_KEY, value: 'false' },
      update: { value: 'false' }
    });
    console.log('IP restriction has been DISABLED successfully.');
    process.exit(0);
  }

  if (command === '--enable' || command === '--on') {
    const activeCount = await prisma.allowedDashboardIP.count({
      where: { isActive: true }
    });
    if (activeCount === 0) {
      console.error('Error: Cannot enable restriction with 0 active allowed IPs.');
      process.exit(1);
    }
    await prisma.setting.upsert({
      where: { key: IP_RESTRICTION_SETTING_KEY },
      create: { key: IP_RESTRICTION_SETTING_KEY, value: 'true' },
      update: { value: 'true' }
    });
    console.log('IP restriction has been ENABLED successfully.');
    process.exit(0);
  }

  if (command === '--add-ip') {
    const rawIp = args[1];
    const label = args[2] || 'Emergency Admin IP';

    if (!rawIp) {
      console.error('Error: Please specify an IP address.');
      process.exit(1);
    }

    const normalized = normalizeIp(rawIp);
    if (!isValidIp(normalized)) {
      console.error(`Error: "${rawIp}" is not a valid IP address.`);
      process.exit(1);
    }

    const currentCount = await prisma.allowedDashboardIP.count();
    if (currentCount >= MAX_ALLOWED_IPS) {
      console.error(`Error: Cannot add IP. Limit reached (${MAX_ALLOWED_IPS} IPs max).`);
      process.exit(1);
    }

    const existing = await prisma.allowedDashboardIP.findUnique({
      where: { ipAddress: normalized }
    });

    if (existing) {
      await prisma.allowedDashboardIP.update({
        where: { id: existing.id },
        data: { isActive: true, label }
      });
      console.log(`IP ${normalized} was already present; reactivated and updated label.`);
    } else {
      await prisma.allowedDashboardIP.create({
        data: {
          ipAddress: normalized,
          label,
          isActive: true,
          createdBy: 'Server Console Emergency'
        }
      });
      console.log(`IP ${normalized} added to allowed list successfully.`);
    }
    process.exit(0);
  }

  if (command === '--list') {
    const items = await prisma.allowedDashboardIP.findMany({
      orderBy: { createdAt: 'desc' }
    });
    console.log('Allowed Dashboard IPs:');
    items.forEach((item, idx) => {
      console.log(`[${idx + 1}] ${item.ipAddress} | Label: ${item.label || 'None'} | Active: ${item.isActive}`);
    });
    process.exit(0);
  }

  console.error(`Unknown command: ${command}. Use --help.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
