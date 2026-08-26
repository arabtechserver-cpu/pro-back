const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const svc = await prisma.dhruService.findFirst({ where: { name: { contains: 'Sony-Ericsson any model France' } } });
  if (svc) {
    console.log(svc.requiresCustom);
    console.log(svc.fields);
  } else {
    console.log("Not found");
  }
}
run().finally(()=>prisma.$disconnect());
