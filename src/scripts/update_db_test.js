const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const svc = await prisma.dhruService.findFirst({ where: { name: { contains: 'Sony-Ericsson any model France' } } });
  if (svc) {
    let req = {};
    if(svc.requiresCustom) {
      req = JSON.parse(svc.requiresCustom);
    }
    
    // Override the model field to be a select
    req.model = {
      reqid: "model",
      fieldname: "custom_model",
      fieldtype: "select",
      required: "1",
      description: "",
      fieldoptions: "Router France\nRouter Boygues unlock code by imei",
      label: "model"
    };

    await prisma.dhruService.update({
      where: { id: svc.id },
      data: { requiresCustom: JSON.stringify(req) }
    });
    console.log("Updated service", svc.name);
  } else {
    console.log("Not found");
  }
}
run().finally(()=>prisma.$disconnect());
