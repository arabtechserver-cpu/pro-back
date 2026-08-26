const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const svc = await prisma.dhruService.findFirst({ where: { name: 'Router Code' } });
  console.log('Raw fields:');
  console.log(JSON.stringify(svc.fields, null, 2));
}
run().finally(() => prisma.$disconnect());
