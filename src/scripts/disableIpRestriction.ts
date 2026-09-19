import { prisma } from '../utils/prisma';
import { SETTING_KEY_RESTRICTION_ENABLED } from '../utils/ipUtils';

async function disableRestriction() {
  console.log('Emergency Recovery: Disabling Dashboard IP Restriction...');
  await prisma.setting.upsert({
    where: { key: SETTING_KEY_RESTRICTION_ENABLED },
    update: { value: 'false' },
    create: { key: SETTING_KEY_RESTRICTION_ENABLED, value: 'false' },
  });
  console.log('Dashboard IP Restriction successfully DISABLED.');
  process.exit(0);
}

disableRestriction().catch((err) => {
  console.error('Recovery failed:', err);
  process.exit(1);
});
