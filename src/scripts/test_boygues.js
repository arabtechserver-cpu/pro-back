const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const services = await prisma.dhruService.findMany({
    where: {
      OR: [
        { requiresCustom: { contains: 'Router France' } },
        { requiresCustom: { contains: 'Boygues' } }
      ]
    }
  });
  console.log(services.map(s => s.name));
}
run().finally(()=>prisma.$disconnect());
