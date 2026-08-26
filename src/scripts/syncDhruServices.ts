import { PrismaClient } from '@prisma/client';
import { getImeiServiceList, getServerServiceList } from '../utils/dhru-api';

const prisma = new PrismaClient();

export function cleanServiceName(serviceName: string, info: string, groupName: string): string {
  let name = (serviceName || '').trim();
  
  if (name.match(/^(تفعيل فوري تلقائي|تفعيل فوري|تفعيل تلقائي|طلب فوري|فوري تلقائي|تفعيل سريع)$/i) || name.length <= 3) {
    if (info) {
      let extracted = info;
      extracted = extracted.replace(/^(تفعيل خدمة|خدمة|باقات وتفعيل خدمات|تفعيل باقة|شراء خدمة|طلب خدمة)\s+/i, '');
      extracted = extracted.replace(/\s+(فوري عبر API|عبر API|فوري|تلقائياً|تلقائي)$/i, '');
      extracted = extracted.trim();

      if (extracted.length > 3 && !extracted.match(/^(تفعيل فوري تلقائي|تفعيل فوري|تفعيل تلقائي)$/i)) {
        return extracted;
      }
    }

    if (groupName && groupName.trim().length > 2) {
      return groupName.trim();
    }
  }

  return name;
}

async function determineCategory(groupName: string, serviceName: string): Promise<string> {
  const text = `${groupName} ${serviceName}`.toLowerCase();
  
  // Remote/Rent Keywords
  if (text.match(/remote|rent|teamviewer|anydesk|usb|flexi/i)) {
    return "Remote Service";
  }
  
  // Server Keywords
  if (text.match(/tool|activation|credit|account|license|pro|dongle|box|server|log|pack/i)) {
    return "Server Service";
  }
  
  return "IMEI Service";
}

export async function syncDhruServices() {
  console.log("Starting Full Fresh Dhru Services Sync (Wiping old data first)...");
  
  try {
    // 0. Clean Wipe All Existing Services & Categories
    await prisma.dhruService.deleteMany({});
    await prisma.dhruCategory.deleteMany({});
    console.log("Deleted old services and categories.");

    const imeiResponse = await getImeiServiceList();
    const serverResponse = await getServerServiceList();
    
    const imeiGroups = (imeiResponse?.SUCCESS?.[0]?.LIST) || [];
    const serverGroups = (serverResponse?.SUCCESS?.[0]?.LIST) || [];
    
    console.log(`Fetched ${imeiGroups.length} IMEI groups and ${serverGroups.length} Server groups from Dhru.`);

    // 1. Ensure the 3 main categories exist
    const categoryNames = ["IMEI Service", "Server Service", "Remote Service"];
    const categoryMap = new Map<string, string>(); // name -> id

    for (const name of categoryNames) {
      let cat = await prisma.dhruCategory.create({ data: { name } });
      categoryMap.set(name, cat.id);
    }

    let createdCount = 0;

    // 2. Process IMEI groups
    for (const group of imeiGroups) {
      const groupName = group.GROUPNAME;
      const services = group.SERVICES || [];

      for (const service of services) {
        const dhruId = String(service.SERVICEID);
        const serviceName = service.SERVICENAME;
        const credit = parseFloat(service.CREDIT) || 0;
        const time = service.TIME || "";
        const info = service.INFO || "";
        
        let requiresCustomStr: string | null = null;
        if (service['Requires.Custom']) {
            requiresCustomStr = JSON.stringify(service['Requires.Custom']);
        }

        let categoryName = "IMEI Service";
        if (`${groupName} ${serviceName}`.match(/remote|rent|teamviewer|anydesk|usb|flexi/i)) {
          categoryName = "Remote Service";
        }
        const categoryId = categoryMap.get(categoryName)!;

        const finalName = cleanServiceName(serviceName, info, groupName);

        await prisma.dhruService.create({
          data: {
            dhruId,
            name: finalName,
            originalName: serviceName,
            groupName,
            credit,
            time,
            info,
            categoryId,
            requiresCustom: requiresCustomStr
          }
        });
        createdCount++;
      }
    }

    // 3. Process Server groups
    for (const group of serverGroups) {
      const groupName = group.GROUPNAME;
      const services = group.SERVICES || [];

      for (const service of services) {
        const dhruId = String(service.SERVICEID);
        const serviceName = service.SERVICENAME;
        const credit = parseFloat(service.CREDIT) || 0;
        const time = service.TIME || "";
        const info = service.INFO || "";
        
        let requiresCustomStr: string | null = null;
        if (service['Requires.Custom']) {
          requiresCustomStr = JSON.stringify(service['Requires.Custom']);
        }

        let categoryName = "Server Service";
        if (`${groupName} ${serviceName}`.match(/remote|rent|teamviewer|anydesk|usb|flexi/i)) {
          categoryName = "Remote Service";
        }
        const categoryId = categoryMap.get(categoryName)!;

        const finalName = cleanServiceName(serviceName, info, groupName);

        // Prevent duplicate dhruId if service exists in both lists
        const existing = await prisma.dhruService.findUnique({ where: { dhruId } });
        if (!existing) {
          await prisma.dhruService.create({
            data: {
              dhruId,
              name: finalName,
              originalName: serviceName,
              groupName,
              credit,
              time,
              info,
              categoryId,
              requiresCustom: requiresCustomStr
            }
          });
          createdCount++;
        }
      }
    }

    console.log(`Sync Complete! Freshly created ${createdCount} services across 3 categories.`);
    
    
  } catch (error) {
    console.error("Error during sync:", error);
  } finally {
    await prisma.$disconnect();
  }
}

// Allow running directly from command line
if (require.main === module) {
  syncDhruServices();
}
