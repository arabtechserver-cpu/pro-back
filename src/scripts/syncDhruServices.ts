import { PrismaClient } from '@prisma/client';
import { getImeiServiceList, getServerServiceList } from '../utils/dhru-api';
import { extractCustomFields, normalizeCustomField } from '../routes/providers';
import { extractQuantityLimits, enrichCustomFieldsWithQuantity } from '../utils/provider-quantity';

import { prisma } from '../utils/prisma';

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
  console.log("Starting Non-Destructive Dhru Services Sync (Preserving All Service & Category IDs)...");
  
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

    // 2. Ensure the 3 standard categories exist without deleting or altering existing category IDs
    const categoryNames = ["IMEI Service", "Server Service", "Remote Service"];
    const categoryMap = new Map<string, string>(); // name -> id

    for (const name of categoryNames) {
      let cat = await prisma.dhruCategory.findFirst({ where: { name } });
      if (!cat) {
        cat = await prisma.dhruCategory.create({ data: { name } });
      }
      categoryMap.set(name, cat.id);
    }

    // 3. Fetch all existing services from database to preserve their IDs and admin settings
    const existingServices = await prisma.dhruService.findMany();
    const existingMap = new Map<string, any>(); // dhruId -> existingService

    for (const s of existingServices) {
      if (s.dhruId) {
        existingMap.set(s.dhruId, s);
      }
    }

    const newServicesToInsert: any[] = [];
    const servicesToUpdate: any[] = [];
    const seenDhruIds = new Set<string>();

    // Helper to process each service item
    const processService = (service: any, groupName: string, defaultCategory: string) => {
      const dhruId = String(service.SERVICEID);
      if (!dhruId || seenDhruIds.has(dhruId)) return;
      seenDhruIds.add(dhruId);

      const serviceName = service.SERVICENAME || "";
      let credit = parseFloat(service.CREDIT);
      if (isNaN(credit)) credit = 0;

      const time = service.TIME || "";
      const info = service.INFO || "";
      
      const rawCustomFields = extractCustomFields(service);
      let normalizedFields = rawCustomFields.map(normalizeCustomField).filter(Boolean);

      const qtyLimits = extractQuantityLimits(service, normalizedFields);
      if (qtyLimits.supportsQty) {
        normalizedFields = enrichCustomFieldsWithQuantity(normalizedFields, qtyLimits);
      }

      let categoryName = defaultCategory;
      if (`${groupName} ${serviceName}`.match(/remote|rent|teamviewer|anydesk|usb|flexi/i)) {
        categoryName = "Remote Service";
      } else if (qtyLimits.supportsQty || `${groupName} ${serviceName}`.match(/tool|activation|credit|account|license|pro|dongle|box|server|log|pack|followers|likes|views|cash|كاش|رصيد|كريدت/i)) {
        categoryName = "Server Service";
      }

      if (categoryName === "IMEI Service" && !qtyLimits.supportsQty) {
        const existingImeiIndex = normalizedFields.findIndex((f: any) => {
           const lowerName = String(f.name || f.field_id || "").toLowerCase();
           return lowerName === "imei" || lowerName === "custom_imei" || lowerName.includes("imei");
        });

        if (existingImeiIndex !== -1) {
          normalizedFields[existingImeiIndex].required = true;
          if (existingImeiIndex > 0) {
            const [imeiField] = normalizedFields.splice(existingImeiIndex, 1);
            normalizedFields.unshift(imeiField);
          }
        } else {
          normalizedFields.unshift({
            id: "custom_IMEI",
            field_id: "IMEI",
            name: "IMEI",
            label: "IMEI",
            type: "text",
            fieldtype: "text",
            required: true,
            description: "",
            placeholder: "أدخل IMEI",
            options: [],
            fieldoptions: []
          });
        }
      }

      let requiresCustomStr: string | null = normalizedFields.length > 0 ? JSON.stringify(normalizedFields) : null;
      const categoryId = categoryMap.get(categoryName)!;
      const cleanName = cleanServiceName(serviceName, info, groupName);

      const existing = existingMap.get(dhruId);

      if (existing) {
        // PRESERVE EXISTING SERVICE ID & ADMIN CUSTOMIZATIONS
        const finalMargin = existing.margin ?? 0;
        const finalName = (existing.name && existing.name !== existing.originalName) ? existing.name : cleanName;
        const finalCredit = (credit === 0 && existing.credit > 0) ? existing.credit : credit;
        const finalActive = existing.isActive;

        servicesToUpdate.push({
          id: existing.id, // KEEP SAME DATABASE ID SO NO LINK BREAKS!
          data: {
            name: finalName,
            originalName: serviceName,
            groupName,
            credit: finalCredit,
            time,
            info,
            categoryId,
            requiresCustom: requiresCustomStr,
            supportsQty: qtyLimits.supportsQty,
            minQty: qtyLimits.minQty,
            maxQty: qtyLimits.maxQty,
            isActive: finalActive,
            margin: finalMargin
          }
        });
      } else {
        // NEW SERVICE: CREATE IT
        const isNoticeOrRefund = 
          credit === 0 && 
          (serviceName.match(/rules?|refund|instruction|notice|تنبيه|شروط|استرجاع/i) || groupName.match(/rules?|refund/i));

        newServicesToInsert.push({
          dhruId,
          name: cleanName,
          originalName: serviceName,
          groupName,
          credit,
          time,
          info,
          categoryId,
          requiresCustom: requiresCustomStr,
          supportsQty: qtyLimits.supportsQty,
          minQty: qtyLimits.minQty,
          maxQty: qtyLimits.maxQty,
          isActive: !isNoticeOrRefund,
          margin: 0
        });
      }
    };

    // 4. Process IMEI groups
    for (const group of imeiGroups) {
      const groupName = group.GROUPNAME || "General IMEI";
      const services = group.SERVICES || [];
      for (const service of services) {
        processService(service, groupName, "IMEI Service");
      }
    }

    // 5. Process Server groups
    for (const group of serverGroups) {
      const groupName = group.GROUPNAME || "General Server";
      const services = group.SERVICES || [];
      for (const service of services) {
        processService(service, groupName, "Server Service");
      }
    }

    // 6. Insert new services in batch
    if (newServicesToInsert.length > 0) {
      const chunkSize = 500;
      for (let i = 0; i < newServicesToInsert.length; i += chunkSize) {
        const chunk = newServicesToInsert.slice(i, i + chunkSize);
        await prisma.dhruService.createMany({
          data: chunk,
          skipDuplicates: true
        });
      }
      console.log(`[Sync] Created ${newServicesToInsert.length} new services.`);
    }

    // 7. Update existing services in parallel chunks of 50 to preserve all IDs & URLs
    if (servicesToUpdate.length > 0) {
      const updateBatchSize = 50;
      for (let i = 0; i < servicesToUpdate.length; i += updateBatchSize) {
        const batch = servicesToUpdate.slice(i, i + updateBatchSize);
        await Promise.all(
          batch.map((item) =>
            prisma.dhruService.update({
              where: { id: item.id },
              data: item.data
            })
          )
        );
      }
      console.log(`[Sync] Updated ${servicesToUpdate.length} existing services in-place without changing any IDs.`);
    }

    const totalCount = newServicesToInsert.length + servicesToUpdate.length;
    console.log(`Sync Complete! Total ${totalCount} services synced without changing any link or ID.`);
    
    return {
      success: true,
      count: totalCount,
      updatedCount: servicesToUpdate.length,
      createdCount: newServicesToInsert.length,
      categoriesCount: categoryNames.length,
      message: `تمت المزامنة بنجاح! تم تحديث ${servicesToUpdate.length} خدمة وإضافة ${newServicesToInsert.length} خدمة جديدة مع الحفاظ الكامل على كافة الروابط الثابتة.`
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
