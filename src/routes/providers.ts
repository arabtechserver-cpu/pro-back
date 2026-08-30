import { Router } from "express";
import { prisma } from "../server";
import { cleanServiceName } from "../scripts/syncDhruServices";

const router = Router();

// Helper to format API url
function normalizeApiUrl(rawUrl: string): string {
  let url = rawUrl.trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  // If user entered only domain without path e.g. https://ea-unlocker.com or https://ea-unlocker.com/
  try {
    const parsed = new URL(url);
    if (!parsed.pathname || parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/api/index.php";
      return parsed.toString();
    }
  } catch {}
  return url;
}

// Helper to make API calls to any provider
export async function makeProviderApiCall(
  apiUrl: string,
  username: string | null | undefined,
  apiKey: string,
  action: string,
  parameters: Record<string, string> = {}
) {
  const targetUrl = normalizeApiUrl(apiUrl);
  const data = new URLSearchParams();
  if (username) data.append("username", username.trim());
  data.append("key", apiKey.trim());
  data.append("apiaccesskey", apiKey.trim());
  data.append("action", action);
  data.append("requestformat", "JSON");

  Object.entries(parameters).forEach(([k, v]) => {
    data.append(`parameters[${k}]`, v);
  });

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      body: data.toString(),
      cache: "no-store",
    });

    const rawText = await response.text();
    let result: any;
    try {
      result = JSON.parse(rawText);
    } catch {
      result = { error: rawText };
    }
    return { ok: response.ok, status: response.status, data: result, raw: rawText, targetUrl };
  } catch (err: any) {
    return { ok: false, error: err.message || "Failed to reach provider API" };
  }
}

// GET /api/providers - List all real providers
router.get("/", async (req, res) => {
  try {
    let providers = await prisma.apiProvider.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        _count: {
          select: { services: true }
        }
      }
    });

    // If empty, initialize only the real default configured server
    if (providers.length === 0) {
      const realProvider = {
        name: "سيرفر عرب تك (Dhru Fusion API)",
        apiUrl: process.env.DHRU_API_URL || "https://arab-tech1.online/api/v1",
        username: process.env.DHRU_USERNAME || "mina15g4y",
        apiKey: process.env.DHRU_API_KEY || "3AE-27F-14D-104-830-375-6D",
        type: "dhru",
        isActive: true,
        balance: 23.21,
        currency: "USD",
        servicesCount: 2295
      };

      const created = await prisma.apiProvider.create({ data: realProvider });
      await prisma.dhruService.updateMany({
        where: { providerId: null },
        data: { providerId: created.id }
      });

      providers = await prisma.apiProvider.findMany({
        orderBy: { createdAt: "asc" },
        include: {
          _count: {
            select: { services: true }
          }
        }
      });
    }

    return res.json({
      success: true,
      providers: providers.map(p => ({
        ...p,
        servicesCount: p._count?.services || p.servicesCount || 0
      }))
    });
  } catch (error: any) {
    console.error("Fetch providers error:", error);
    return res.status(500).json({ error: "فشل جلب مزودي الخدمة" });
  }
});

// POST /api/providers - Create new provider
router.post("/", async (req, res) => {
  try {
    const { name, apiUrl, username, apiKey, type, isActive } = req.body;
    if (!name || !apiUrl || !apiKey) {
      return res.status(400).json({ error: "اسم المزود، رابط الـ API، ومفتاح API كلها حقول مطلوبة" });
    }

    let initialBalance = 0.0;
    let initialCurrency = "USD";
    try {
      const balRes = await makeProviderApiCall(apiUrl.trim(), username ? username.trim() : null, apiKey.trim(), "accountinfo");
      if (balRes.data && Array.isArray(balRes.data.SUCCESS) && balRes.data.SUCCESS[0]) {
        const row = balRes.data.SUCCESS[0];
        initialBalance = parseFloat(row.AccountInfo?.credit || row.credit || row.balance || "0") || 0;
        if (row.AccountInfo?.currency || row.currency) {
          initialCurrency = row.AccountInfo?.currency || row.currency;
        }
      }
    } catch (e) {}

    const newProvider = await prisma.apiProvider.create({
      data: {
        name: name.trim(),
        apiUrl: apiUrl.trim(),
        username: username ? username.trim() : null,
        apiKey: apiKey.trim(),
        type: type || "dhru",
        isActive: isActive !== false,
        balance: initialBalance,
        currency: initialCurrency
      }
    });

    return res.json({
      success: true,
      provider: newProvider,
      message: `تمت إضافة المزود (${newProvider.name}) بنجاح!`
    });
  } catch (error: any) {
    console.error("Create provider error:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء إضافة المزود" });
  }
});

// PUT /api/providers/:id - Update provider
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, apiUrl, username, apiKey, type, isActive, balance } = req.body;

    const existing = await prisma.apiProvider.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "المزود غير موجود" });
    }

    const updated = await prisma.apiProvider.update({
      where: { id },
      data: {
        name: name !== undefined ? name.trim() : existing.name,
        apiUrl: apiUrl !== undefined ? apiUrl.trim() : existing.apiUrl,
        username: username !== undefined ? (username ? username.trim() : null) : existing.username,
        apiKey: apiKey !== undefined ? apiKey.trim() : existing.apiKey,
        type: type !== undefined ? type : existing.type,
        isActive: isActive !== undefined ? Boolean(isActive) : existing.isActive,
        balance: balance !== undefined ? parseFloat(balance) : existing.balance
      }
    });

    return res.json({
      success: true,
      provider: updated,
      message: `تم تحديث بيانات المزود (${updated.name}) بنجاح!`
    });
  } catch (error: any) {
    console.error("Update provider error:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء تعديل المزود" });
  }
});

// DELETE /api/providers/:id - Delete provider
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.apiProvider.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "المزود غير موجود" });
    }

    await prisma.apiProvider.delete({ where: { id } });

    return res.json({
      success: true,
      message: `تم حذف المزود (${existing.name}) بنجاح.`
    });
  } catch (error: any) {
    console.error("Delete provider error:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء حذف المزود" });
  }
});

// POST /api/providers/:id/balance - Check & update live balance
router.post("/:id/balance", async (req, res) => {
  try {
    const { id } = req.params;
    const provider = await prisma.apiProvider.findUnique({ where: { id } });
    if (!provider) {
      return res.status(404).json({ error: "المزود غير موجود" });
    }

    const apiRes = await makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "accountinfo");

    if (apiRes.data?.ERROR && Array.isArray(apiRes.data.ERROR) && apiRes.data.ERROR[0]?.MESSAGE) {
      return res.status(400).json({
        error: `خطأ من مزود الـ API: ${apiRes.data.ERROR[0].MESSAGE}`
      });
    }

    let liveCredit = 0;
    let currency = "USD";

    if (apiRes.data) {
      if (Array.isArray(apiRes.data.SUCCESS) && apiRes.data.SUCCESS[0]) {
        const row = apiRes.data.SUCCESS[0];
        liveCredit = parseFloat(row.AccountInfo?.credit || row.credit || row.balance || "0") || 0;
        if (row.AccountInfo?.currency || row.currency) {
          currency = row.AccountInfo?.currency || row.currency;
        }
      } else if (apiRes.data.credit !== undefined) {
        liveCredit = parseFloat(apiRes.data.credit) || 0;
      } else if (apiRes.data.balance !== undefined) {
        liveCredit = parseFloat(apiRes.data.balance) || 0;
      }
    }

    const updated = await prisma.apiProvider.update({
      where: { id },
      data: {
        balance: liveCredit,
        currency
      }
    });

    return res.json({
      success: true,
      balance: liveCredit,
      currency,
      provider: updated,
      message: `تم تحديث الرصيد للمزود (${provider.name}): ${liveCredit.toFixed(2)} ${currency}`
    });
  } catch (error: any) {
    console.error("Check balance error:", error);
    return res.status(500).json({ error: "فشل تحديث رصيد المزود" });
  }
});

// POST /api/providers/:id/sync - Sync services from this provider
router.post("/:id/sync", async (req, res) => {
  try {
    const { id } = req.params;
    const provider = await prisma.apiProvider.findUnique({ where: { id } });
    if (!provider) {
      return res.status(404).json({ error: "المزود غير موجود" });
    }

    // Fetch IMEI & Server services from provider
    const [imeiRes, serverRes] = await Promise.all([
      makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "imeiservicelist"),
      makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "serverservicelist"),
    ]);

    if (imeiRes.data?.ERROR && Array.isArray(imeiRes.data.ERROR) && imeiRes.data.ERROR[0]?.MESSAGE) {
      return res.status(400).json({
        error: `خطأ من مزود الـ API: ${imeiRes.data.ERROR[0].MESSAGE}`
      });
    }

    const imeiGroups = (imeiRes?.data?.SUCCESS?.[0]?.LIST) || [];
    const serverGroups = (serverRes?.data?.SUCCESS?.[0]?.LIST) || [];

    if (imeiGroups.length === 0 && serverGroups.length === 0) {
      return res.status(400).json({
        error: "لم يتم العثور على خدمات في رد المزود. تأكد من صحة الرابط ومفتاح الـ API وتصريح الـ IP."
      });
    }

    // Standard Category Mapping
    const categoryNames = ["IMEI Service", "Server Service", "Remote Service"];
    const categoryMap = new Map<string, string>();

    for (const name of categoryNames) {
      let cat = await prisma.dhruCategory.findFirst({ where: { name } });
      if (!cat) {
        cat = await prisma.dhruCategory.create({ data: { name } });
      }
      categoryMap.set(name, cat.id);
    }

    const existingServices = await prisma.dhruService.findMany({
      where: {
        OR: [{ providerId: provider.id }, { providerId: null }]
      }
    });
    const existingMap = new Map<string, any>();
    for (const s of existingServices) {
      if (s.dhruId) existingMap.set(s.dhruId, s);
    }

    const newServicesToInsert: any[] = [];
    const servicesToUpdate: any[] = [];
    const seenDhruIds = new Set<string>();

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
      if (service["Requires.Custom"]) {
        requiresCustomStr = JSON.stringify(service["Requires.Custom"]);
      }

      let categoryName = defaultCategory;
      if (`${groupName} ${serviceName}`.match(/remote|rent|teamviewer|anydesk|usb|flexi/i)) {
        categoryName = "Remote Service";
      }
      const categoryId = categoryMap.get(categoryName)!;
      const cleanName = cleanServiceName(serviceName, info, groupName);

      const existing = existingMap.get(dhruId);
      if (existing) {
        servicesToUpdate.push({
          id: existing.id,
          data: {
            name: existing.name && existing.name !== existing.originalName ? existing.name : cleanName,
            originalName: serviceName,
            groupName,
            credit: credit === 0 && existing.credit > 0 ? existing.credit : credit,
            time,
            info,
            categoryId,
            providerId: provider.id,
            requiresCustom: requiresCustomStr,
            isActive: existing.isActive,
            margin: existing.margin ?? 0
          }
        });
      } else {
        const isNotice = credit === 0 && (serviceName.match(/rules?|refund|notice|تنبيه/i) || groupName.match(/rules?|refund/i));
        newServicesToInsert.push({
          dhruId,
          name: cleanName,
          originalName: serviceName,
          groupName,
          credit,
          time,
          info,
          categoryId,
          providerId: provider.id,
          requiresCustom: requiresCustomStr,
          isActive: !isNotice,
          margin: 0
        });
      }
    };

    // Helper for groups whether array or object
    const handleGroups = (groupsData: any, defaultCategory: string) => {
      if (Array.isArray(groupsData)) {
        for (const g of groupsData) {
          const groupName = g.GROUPNAME || "General";
          const services = Array.isArray(g.SERVICES) ? g.SERVICES : Object.values(g.SERVICES || {});
          for (const s of services) {
            processService(s, groupName, defaultCategory);
          }
        }
      } else if (typeof groupsData === "object" && groupsData !== null) {
        for (const [groupName, g] of Object.entries<any>(groupsData)) {
          const services = Array.isArray(g.SERVICES) ? g.SERVICES : Object.values(g.SERVICES || {});
          for (const s of services) {
            processService(s, groupName, defaultCategory);
          }
        }
      }
    };

    handleGroups(imeiGroups, "IMEI Service");
    handleGroups(serverGroups, "Server Service");

    // Insert new
    if (newServicesToInsert.length > 0) {
      for (let i = 0; i < newServicesToInsert.length; i += 500) {
        const chunk = newServicesToInsert.slice(i, i + 500);
        await prisma.dhruService.createMany({ data: chunk, skipDuplicates: true });
      }
    }

    // Update existing
    if (servicesToUpdate.length > 0) {
      for (let i = 0; i < servicesToUpdate.length; i += 100) {
        const chunk = servicesToUpdate.slice(i, i + 100);
        await prisma.$transaction(
          chunk.map((item) =>
            prisma.dhruService.update({
              where: { id: item.id },
              data: item.data
            })
          )
        );
      }
    }

    const totalSynced = newServicesToInsert.length + servicesToUpdate.length;

    // Update provider record
    await prisma.apiProvider.update({
      where: { id },
      data: {
        lastSyncAt: new Date(),
        servicesCount: totalSynced
      }
    });

    return res.json({
      success: true,
      count: totalSynced,
      message: `تمت المزامنة بنجاح! تم استيراد وتحديث ${totalSynced} خدمة من المزود (${provider.name}).`
    });
  } catch (error: any) {
    console.error("Provider sync error:", error);
    return res.status(500).json({ error: "فشل مزامنة الخدمات من المزود: " + (error.message || "") });
  }
});

// GET /api/providers/:id/services - Get services from a specific provider
router.get("/:id/services", async (req, res) => {
  try {
    const { id } = req.params;
    const services = await prisma.dhruService.findMany({
      where: {
        OR: [
          { providerId: id },
          { providerId: null }
        ]
      },
      include: { category: true },
      orderBy: { name: "asc" }
    });

    return res.json({
      success: true,
      services
    });
  } catch (error: any) {
    console.error("Fetch provider services error:", error);
    return res.status(500).json({ error: "فشل جلب خدمات المزود" });
  }
});

// POST /api/providers/:id/toggle-packages - Toggle multiple or single package visibility
router.post("/:id/toggle-packages", async (req, res) => {
  try {
    const { id } = req.params;
    const { groupNames, isActive } = req.body;

    if (!Array.isArray(groupNames) || groupNames.length === 0) {
      return res.status(400).json({ error: "يرجى تحديد باقة واحدة على الأقل" });
    }

    const nextActive = typeof isActive === "boolean" ? isActive : true;

    const result = await prisma.dhruService.updateMany({
      where: {
        groupName: { in: groupNames },
        OR: [{ providerId: id }, { providerId: null }]
      },
      data: {
        isActive: nextActive
      }
    });

    return res.json({
      success: true,
      count: result.count,
      message: nextActive
        ? `تم إظهار وتفعيل ${result.count} خدمة ضمن (${groupNames.length} باقة) للعملاء بنجاح!`
        : `تم إخفاء ${result.count} خدمة ضمن (${groupNames.length} باقة) عن العملاء بنجاح.`
    });
  } catch (error: any) {
    console.error("Toggle packages error:", error);
    return res.status(500).json({ error: "فشل تغيير حالة ظهور الباقات" });
  }
});

// POST /api/providers/:id/toggle-all - Toggle ALL services visibility for this provider
router.post("/:id/toggle-all", async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    const nextActive = typeof isActive === "boolean" ? isActive : true;

    const result = await prisma.dhruService.updateMany({
      where: {
        OR: [{ providerId: id }, { providerId: null }]
      },
      data: {
        isActive: nextActive
      }
    });

    return res.json({
      success: true,
      count: result.count,
      message: nextActive
        ? `تم تفعيل وإظهار كافة خدمات السيرفر (${result.count} خدمة) في المتجر بنجاح!`
        : `تم إخفاء كافة خدمات السيرفر (${result.count} خدمة) عن المتجر.`
    });
  } catch (error: any) {
    console.error("Toggle all services error:", error);
    return res.status(500).json({ error: "فشل تحديث حالة ظهور الخدمات" });
  }
});

// POST /api/providers/:id/toggle-service - Toggle a single service
router.post("/:id/toggle-service", async (req, res) => {
  try {
    const { serviceId, isActive } = req.body;
    if (!serviceId) {
      return res.status(400).json({ error: "serviceId is required" });
    }

    const updated = await prisma.dhruService.update({
      where: { id: serviceId },
      data: { isActive: Boolean(isActive) }
    });

    return res.json({
      success: true,
      service: updated,
      message: updated.isActive ? "تم إظهار الخدمة للعملاء" : "تم إخفاء الخدمة عن العملاء"
    });
  } catch (error: any) {
    console.error("Toggle service error:", error);
    return res.status(500).json({ error: "فشل تغيير حالة الخدمة" });
  }
});

export default router;
