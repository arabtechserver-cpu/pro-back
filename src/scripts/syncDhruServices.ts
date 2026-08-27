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
  console.log("Starting Full Fresh Dhru Services Sync with Smart Data Preservation...");
  
  try {
    // 1. Fetch fresh lists from Dhru API first to ensure provider is reachable
    const [imeiResponse, serverResponse] = await Promise.all([
      getImeiServiceList(),
      getServerServiceList()
    ]);
    
    if (imeiResponse?.error && serverResponse?.error) {
      throw new Error(`تعذر الاتصال بمزود الخدمة Dhru API: ${imeiResponse.message || serverResponse.message || 'خطأ في الاتصال'}`);
    }

    const imeiGroups = (imeiResponse?.SUCCESS?.[0]?.LIST) || [];
    const serverGroups = (serverResponse?.SUCCESS?.[0]?.LIST) || [];
    
    if (imeiGroups.length === 0 && serverGroups.length === 0) {
      throw new Error("لم يتم استلام أي خدمات من المزود. يرجى التحقق من إعدادات الـ API أو عنوان IP المعتمد.");
    }

    console.log(`Fetched ${imeiGroups.length} IMEI groups and ${serverGroups.length} Server groups from Dhru API.`);

    // 2. Fetch and backup existing admin customizations (margins, custom names, custom credits, visibility)
    const existingServices = await prisma.dhruService.findMany();
    const existingCustomsMap = new Map<string, { margin: number; customName?: string; customCredit?: number; isActive: boolean }>();

    for (const s of existingServices) {
      if (s.dhruId) {
        existingCustomsMap.set(s.dhruId, {
          margin: s.margin || 0,
          customName: s.name !== s.originalName ? s.name : undefined,
          customCredit: s.credit > 0 ? s.credit : undefined,
          isActive: s.isActive
        });
      }
    }

    // 3. Clean Wipe All Existing Services & Categories
    await prisma.dhruService.deleteMany({});
    await prisma.dhruCategory.deleteMany({});
    console.log("Cleaned old services and categories from database.");

    // 4. Re-create the 3 standard categories
    const categoryNames = ["IMEI Service", "Server Service", "Remote Service"];
    const categoryMap = new Map<string, string>(); // name -> id

    for (const name of categoryNames) {
      const cat = await prisma.dhruCategory.create({ data: { name } });
      categoryMap.set(name, cat.id);
    }

    const servicesToInsert: any[] = [];
    const seenDhruIds = new Set<string>();

    // Helper to process a service item
    const processService = (service: any, groupName: string, defaultCategory: string) => {
      const dhruId = String(service.SERVICEID);
      if (!dhruId || seenDhruIds.has(dhruId)) return;
      seenDhruIds.add(dhruId);

      const serviceName = service.SERVICENAME || "";
      let credit = parseFloat(service.CREDIT);
      if (isNaN(credit)) credit = 0;

      const time = service.TIME || "";
      const info = service.INFO || "";
      
      let requiresCustomStr: string | null = null;
      if (service['Requires.Custom']) {
        requiresCustomStr = JSON.stringify(service['Requires.Custom']);
      }

      let categoryName = defaultCategory;
      if (`${groupName} ${serviceName}`.match(/remote|rent|teamviewer|anydesk|usb|flexi/i)) {
        categoryName = "Remote Service";
      }
      const categoryId = categoryMap.get(categoryName)!;
      const cleanName = cleanServiceName(serviceName, info, groupName);

      // Check existing custom overrides
      const existingCustom = existingCustomsMap.get(dhruId);
      const finalMargin = existingCustom ? existingCustom.margin : 0;
      const finalName = (existingCustom && existingCustom.customName) ? existingCustom.customName : cleanName;
      
      // If admin had set a custom credit previously and provider returned 0, preserve custom credit
      if (credit === 0 && existingCustom && existingCustom.customCredit && existingCustom.customCredit > 0) {
        credit = existingCustom.customCredit;
      }

      // Check if this is a rule, instruction, or refund request with 0 price
      const isNoticeOrRefund = 
        credit === 0 && 
        (serviceName.match(/rules?|refund|instruction|notice|تنبيه|شروط|استرجاع/i) || groupName.match(/rules?|refund/i));

      let isActive = true;
      if (existingCustom !== undefined) {
        isActive = existingCustom.isActive;
      } else if (isNoticeOrRefund) {
        isActive = false; // Hide 0-price rules and refund notices by default from customer catalog
      }

      servicesToInsert.push({
        dhruId,
        name: finalName,
        originalName: serviceName,
        groupName,
        credit,
        time,
        info,
        categoryId,
        requiresCustom: requiresCustomStr,
        isActive,
        margin: finalMargin
      });
    };

    // 5. Process IMEI groups
    for (const group of imeiGroups) {
      const groupName = group.GROUPNAME || "General IMEI";
      const services = group.SERVICES || [];
      for (const service of services) {
        processService(service, groupName, "IMEI Service");
      }
    }

    // 6. Process Server groups
    for (const group of serverGroups) {
      const groupName = group.GROUPNAME || "General Server";
      const services = group.SERVICES || [];
      for (const service of services) {
        processService(service, groupName, "Server Service");
      }
    }

    // 7. Batch insert all services
    if (servicesToInsert.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < servicesToInsert.length; i += chunkSize) {
        const chunk = servicesToInsert.slice(i, i + chunkSize);
        await prisma.dhruService.createMany({
          data: chunk,
          skipDuplicates: true
        });
      }
    }

    console.log(`Sync Complete! Freshly created ${servicesToInsert.length} services across ${categoryNames.length} categories.`);
    
    return {
      success: true,
      count: servicesToInsert.length,
      categoriesCount: categoryNames.length,
      message: `تمت المزامنة بنجاح! تم استيراد ${servicesToInsert.length} خدمة وتحديث كافة الأسعار والأقسام من المزود.`
    };
  } catch (error: any) {
    console.error("Error during sync:", error);
    throw error;
  }
}

// Allow running directly from command line
if (require.main === module) {
  syncDhruServices()
    .then((res) => {
      console.log(res);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
