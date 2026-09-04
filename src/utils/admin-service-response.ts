import { getServiceQuantityConfig } from "./provider-quantity";

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
      const qtyConfig = getServiceQuantityConfig(service);

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
        requiresCustom: service.requiresCustom,
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
      const qtyConfig = getServiceQuantityConfig(service);

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
        requiresCustom: service.requiresCustom,
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
