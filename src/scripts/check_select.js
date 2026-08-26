const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const svcs = await prisma.dhruService.findMany({ where: { requiresCustom: { contains: 'Router Beeline' } } });
  console.log('Found Router Beeline services:', svcs.length);
  console.log(svcs.map(s => s.name));
  
  const allSelect = await prisma.dhruService.findMany({ where: { requiresCustom: { contains: '"fieldtype":"select"' } } });
  console.log('Found select services:', allSelect.length);
}
run().finally(()=>prisma.$disconnect());
