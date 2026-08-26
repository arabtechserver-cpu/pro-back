const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const svcs = await prisma.dhruService.findMany({ where: { requiresCustom: { contains: 'Router France' } } });
  console.log(svcs.map(s => s.name));
}
run().finally(()=>prisma.$disconnect());
