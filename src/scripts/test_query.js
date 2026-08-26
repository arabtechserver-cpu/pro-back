const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const services = await prisma.dhruService.findMany({ where: { requiresCustom: { contains: 'Router France' } } });
  console.log("Services found with 'Router France' in requiresCustom:");
  console.log(services.map(s => s.name));
}
run().finally(()=>prisma.$disconnect());
