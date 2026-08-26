const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const svc = await prisma.dhruService.findFirst({ where: { name: 'Router Code' } });
  console.log('Is Active:', svc.isActive);
}
run().finally(()=>prisma.$disconnect());
