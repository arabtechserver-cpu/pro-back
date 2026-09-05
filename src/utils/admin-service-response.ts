import { getServiceQuantityConfig, enrichCustomFieldsWithQuantity } from "./provider-quantity";

type AdminService = {
  id: string;
  dhruId: string;
  name: string;
  originalName: string;
  groupName: string;
  credit: number;
  margin: number;
  time: string;
  info: string | null;
  isActive: boolean;
  requiresCustom: string | null | any[];
  [key: string]: any;
};

type AdminCategory = {
  id: string;
  name: string;
  dhruServices: AdminService[];
};

export function serializeAdminServiceCategories(
  categories: AdminCategory[],
  cleanName: (name: string, info: string, groupName: string) => string
) {
  return categories.map(({ id, name, dhruServices }) => ({
    id,
    name,
    services: dhruServices.map((service) => {
      const credit = Number(service.credit) || 0;
      const margin = Number(service.margin) || 0;
      const finalPrice = Number((credit + margin).toFixed(2));
      
      let sanitizedCustom = service.requiresCustom;
      if (sanitizedCustom) {
        try {
          const parsed = typeof sanitizedCustom === 'string' ? JSON.parse(sanitizedCustom) : sanitizedCustom;
          if (Array.isArray(parsed)) {
            const filtered = parsed.filter((f: any) => f && f.synthetic_quantity !== true && f.field_id !== 'custom_QNT');
            sanitizedCustom = typeof service.requiresCustom === 'string' ? JSON.stringify(filtered) : filtered;
          }
        } catch {}
      }

      const qtyConfig = getServiceQuantityConfig({ ...service, categoryName: name, requiresCustom: sanitizedCustom });

      let finalCustom = sanitizedCustom;
      if (qtyConfig.supportsQty) {
        try {
          let parsed = typeof sanitizedCustom === 'string' ? JSON.parse(sanitizedCustom) : (sanitizedCustom || []);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsed = Object.entries(parsed).map(([key, val]: any) => ({
              ...(val && typeof val === 'object' ? val : {}),
              id: val?.id || key,
              field_id: val?.field_id || val?.reqid || key,
              name: val?.name || val?.fieldname || key
            }));
          }
          const enriched = enrichCustomFieldsWithQuantity(Array.isArray(parsed) ? parsed : [], qtyConfig);
          finalCustom = typeof service.requiresCustom === 'string' ? JSON.stringify(enriched) : enriched;
        } catch {}
      }

      return {
        id: service.id,
        dhruId: service.dhruId,
        name: cleanName(service.name, service.info || "", service.groupName || ""),
        originalName: service.originalName,
        groupName: service.groupName,
        credit,
        margin,
        price: finalPrice,
        finalPrice,
        sellingPrice: finalPrice,
        time: service.time,
        info: service.info,
        isActive: service.isActive,
        requiresCustom: finalCustom,
        supportsQty: qtyConfig.supportsQty,
        supports_quantity: qtyConfig.supportsQty,
        minQty: qtyConfig.minQty,
        maxQty: qtyConfig.maxQty,
        min_quantity: qtyConfig.min_quantity,
        max_quantity: qtyConfig.max_quantity
      };
    })
  }));
}

export function serializePricingServiceCategories(
  categories: AdminCategory[],
  cleanName: (name: string, info: string, groupName: string) => string
) {
  return categories.map(({ id, name, dhruServices }) => ({
    id,
    name,
    services: dhruServices.map((service) => {
      const credit = Number(service.credit) || 0;
      const margin = Number(service.margin) || 0;
      const finalPrice = Number((credit + margin).toFixed(2));

      let sanitizedCustom = service.requiresCustom;
      if (sanitizedCustom) {
        try {
          const parsed = typeof sanitizedCustom === 'string' ? JSON.parse(sanitizedCustom) : sanitizedCustom;
          if (Array.isArray(parsed)) {
            const filtered = parsed.filter((f: any) => f && f.synthetic_quantity !== true && f.field_id !== 'custom_QNT');
            sanitizedCustom = typeof service.requiresCustom === 'string' ? JSON.stringify(filtered) : filtered;
          }
        } catch {}
      }

      const qtyConfig = getServiceQuantityConfig({ ...service, categoryName: name, requiresCustom: sanitizedCustom });

      let finalCustom = sanitizedCustom;
      if (qtyConfig.supportsQty) {
        try {
          let parsed = typeof sanitizedCustom === 'string' ? JSON.parse(sanitizedCustom) : (sanitizedCustom || []);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            parsed = Object.entries(parsed).map(([key, val]: any) => ({
              ...(val && typeof val === 'object' ? val : {}),
              id: val?.id || key,
              field_id: val?.field_id || val?.reqid || key,
              name: val?.name || val?.fieldname || key
            }));
          }
          const enriched = enrichCustomFieldsWithQuantity(Array.isArray(parsed) ? parsed : [], qtyConfig);
          finalCustom = typeof service.requiresCustom === 'string' ? JSON.stringify(enriched) : enriched;
        } catch {}
      }

      return {
        id: service.id,
        dhruId: service.dhruId,
        name: cleanName(service.name, service.info || "", service.groupName || ""),
        groupName: service.groupName,
        credit,
        margin,
        price: finalPrice,
        finalPrice,
        sellingPrice: finalPrice,
        time: service.time,
        isActive: service.isActive,
        info: service.info,
        originalName: service.originalName,
        requiresCustom: finalCustom,
        supportsQty: qtyConfig.supportsQty,
        supports_quantity: qtyConfig.supportsQty,
        minQty: qtyConfig.minQty,
        maxQty: qtyConfig.maxQty,
        min_quantity: qtyConfig.min_quantity,
        max_quantity: qtyConfig.max_quantity
      };
    })
  }));
}
