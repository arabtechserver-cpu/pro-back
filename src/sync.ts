import { PrismaClient } from '@prisma/client';
import { getImeiServiceList } from './utils/dhru-api';

const prisma = new PrismaClient();

async function run() {
  console.log("Syncing Dhru services...");
  try {
    const list = await getImeiServiceList();
    if (!list?.SUCCESS) {
      console.error("Failed to fetch list from Dhru", list);
      return;
    }

    const servicesData = list.SUCCESS[0].LIST;
    if (!servicesData) {
      console.error("No services found");
      return;
    }

    let importedCount = 0;

    for (const group of servicesData) {
      const groupName = group.GROUPNAME;
      const services = group.SERVICES;

      let category = await prisma.dhruCategory.findFirst({
        where: { name: groupName }
      });

      if (!category) {
        category = await prisma.dhruCategory.create({
          data: { name: groupName }
        });
      }

      for (const srv of services) {
        const dhruId = String(srv.SERVICEID);
        const srvName = srv.SERVICENAME;
        const time = srv.TIME;
        const credit = parseFloat(srv.CREDIT);
        const info = srv.INFO;
        const originalName = srvName;

        const reqCustom = srv.Requirenetork === "1" ? "network" : null;

        await prisma.dhruService.upsert({
          where: { dhruId },
          update: {
            name: srvName,
            originalName,
            groupName,
            time,
            credit,
            info,
            categoryId: category.id,
            requiresCustom: reqCustom
          },
          create: {
            dhruId,
            name: srvName,
            originalName,
            groupName,
            time,
            credit,
            info,
            categoryId: category.id,
            requiresCustom: reqCustom,
            margin: 0
          }
        });
        importedCount++;
      }
    }
    console.log(`Successfully imported/updated ${importedCount} services!`);
  } catch (error) {
    console.error("Error syncing dhru:", error);
  } finally {
    await prisma.$disconnect();
  }
}

run();
