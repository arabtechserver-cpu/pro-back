const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const svc = await prisma.dhruService.findFirst({ where: { name: { contains: 'Sony-Ericsson any model France' } } });
  if (svc && svc.requiresCustom) {
    let req = JSON.parse(svc.requiresCustom);
    if (req.model) {
      req.model.fieldoptions = "";
      req.model.fieldtype = "text";
      await prisma.dhruService.update({
        where: { id: svc.id },
        data: { requiresCustom: JSON.stringify(req) }
      });
      console.log("Reverted Sony-Ericsson");
    }
  }
}
run().finally(()=>prisma.$disconnect());
