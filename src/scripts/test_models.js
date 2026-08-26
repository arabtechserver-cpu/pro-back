const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const services = await prisma.dhruService.findMany({ where: { requiresCustom: { not: null } } });
  let models = [];
  for (let s of services) {
    try {
      const req = JSON.parse(s.requiresCustom);
      if(req.model) {
        models.push({name: s.name, type: req.model.fieldtype, options: req.model.fieldoptions || req.model.options});
      }
    } catch (e) {}
  }
  console.log(JSON.stringify(models, null, 2));
}
run().finally(()=>prisma.$disconnect());
