const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const svc = await prisma.dhruService.findFirst({ where: { name: 'Router Code' } });
  console.log(svc.requiresCustom);
}
run().finally(()=>prisma.$disconnect());
