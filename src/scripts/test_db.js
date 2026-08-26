const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const svc = await prisma.dhruService.findFirst({ where: { name: 'Router Code' } });
  console.log('Raw requiresCustom:');
  console.log(svc.requiresCustom);
  const parsed = JSON.parse(svc.requiresCustom);
  console.log('Parsed fieldoptions:');
  console.log(parsed.model.fieldoptions);
}
run().finally(() => prisma.$disconnect());
