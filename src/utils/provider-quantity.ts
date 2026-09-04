/**
 * Provider Quantity Utility
 * Handles quantity detection, limit extraction (min/max), and normalization
 * for provider services and orders.
 */

export interface QuantityLimits {
  supportsQty: boolean;
  minQty: number;
  maxQty: number; // 0 means unlimited / no maximum cap
}

export interface ServiceQuantityConfig extends QuantityLimits {
  min_quantity: number;
  max_quantity: number;
}

/**
 * Checks if a given field definition or key represents a quantity field.
 */
export function isQuantityField(field?: any, key?: string): boolean {
  if (!field && !key) return false;

  const candidateStrings: string[] = [];
  if (key) candidateStrings.push(String(key));
  if (field) {
    if (typeof field === "string") {
      candidateStrings.push(field);
    } else if (typeof field === "object") {
      if (field.is_quantity === true || field.type === "quantity" || field.fieldtype === "quantity") {
        return true;
      }
      if (field.field_id) candidateStrings.push(String(field.field_id));
      if (field.reqid) candidateStrings.push(String(field.reqid));
      if (field.REQID) candidateStrings.push(String(field.REQID));
      if (field.name) candidateStrings.push(String(field.name));
      if (field.NAME) candidateStrings.push(String(field.NAME));
      if (field.fieldname) candidateStrings.push(String(field.fieldname));
      if (field.FIELDNAME) candidateStrings.push(String(field.FIELDNAME));
      if (field.label) candidateStrings.push(String(field.label));
      if (field.customname) candidateStrings.push(String(field.customname));
    }
  }

  for (const raw of candidateStrings) {
    const clean = raw.replace(/^custom_/i, "").trim().toLowerCase();
    if (
      clean === "qnt" ||
      clean === "quantity" ||
      clean === "qty" ||
      clean === "الكمية" ||
      clean === "الكميه" ||
      clean === "amount" ||
      clean === "credits_count" ||
      clean === "minqnt" ||
      clean === "maxqnt" ||
      clean === "min_qnt" ||
      clean === "max_qnt"
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Safely parse a positive integer or return null
 */
export function parseQuantityNumber(val: any): number | null {
  if (val === undefined || val === null || val === "") return null;
  const num = parseInt(String(val).replace(/[^\d]/g, ""), 10);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

/**
 * Extract min and max quantity from textual hints (description, info, service name)
 */
export function extractLimitsFromText(text: string): { min: number | null; max: number | null } {
  if (!text || typeof text !== "string") return { min: null, max: null };

  let min: number | null = null;
  let max: number | null = null;

  // Ignore delivery time expressions (e.g. 1-24 Hours, 1-3 Days, 30 mins) to avoid false limit extraction
  const sanitized = text.replace(/\b\d+\s*[-–—]\s*\d+\s*(?:hours?|hrs?|days?|minutes?|mins?|ساعة|ساعات|يوم|أيام|دقيقة|دقائق)\b/gi, "");

  // Match explicit quantity min: qnt_min: 10, min qnt: 10, min quantity: 10, Min: 10, Min 10, أقل كمية: 10
  const minMatch =
    sanitized.match(/(?:qnt_min|min_qnt|min\s*qnt|minimum\s*qnt|min\s*quantity|minimum\s*quantity|أقل\s*كمية|اقل\s*كمية|الحد\s*الأدنى\s*للكمية|الحد\s*الادنى\s*للكمية|أدنى\s*كمية)[:\s]*([0-9]+)/i) ||
    sanitized.match(/\bmin[:\s]+([0-9]+)\b/i);
  if (minMatch && minMatch[1]) {
    min = parseInt(minMatch[1], 10);
  }

  // Match explicit quantity max: qnt_max: 500, max qnt: 500, max quantity: 500, Max: 500, Max 500, أقصى كمية: 500
  const maxMatch =
    sanitized.match(/(?:qnt_max|max_qnt|max\s*qnt|maximum\s*qnt|max\s*quantity|maximum\s*quantity|أقصى\s*كمية|اقصى\s*كمية|الحد\s*الأقصى\s*للكمية|الحد\s*الاقصى\s*للكمية|أعلى\s*كمية)[:\s]*([0-9]+)/i) ||
    sanitized.match(/\bmax[:\s]+([0-9]+)\b/i);
  if (maxMatch && maxMatch[1]) {
    max = parseInt(maxMatch[1], 10);
  }

  // Pattern: (Min: 10 - Max: 1000) or Min 10 Max 1000
  if (min === null && max === null) {
    const explicitRangeMatch = sanitized.match(/\bmin[:\s]*([0-9]+)\s*[-–—,]\s*max[:\s]*([0-9]+)\b/i);
    if (explicitRangeMatch && explicitRangeMatch[1] && explicitRangeMatch[2]) {
      min = parseInt(explicitRangeMatch[1], 10);
      max = parseInt(explicitRangeMatch[2], 10);
    }
  }

  return { min, max };
}

/**
 * Extracts complete quantity limits and support status from a provider service object or DB record.
 */
export function extractQuantityLimits(service: any, customFields?: any[]): QuantityLimits {
  const s = service || {};
  const sName = String(s.SERVICENAME || s.name || s.originalName || "");
  const sInfo = String(s.INFO || s.info || "");
  const sDesc = String(s.description || s.DESCRIPTION || "");

  // 1. Direct service attributes from provider API or DB (including Dhru MINQNT / MAXQNT without underscore)
  const rawMin =
    s.MINQNT ??
    s.minqnt ??
    s.QNT_MIN ??
    s.qnt_min ??
    s.MIN_QNT ??
    s.min_qnt ??
    s.min_quantity ??
    s.minQuantity ??
    s.minQty ??
    s.MIN_QTY;

  const rawMax =
    s.MAXQNT ??
    s.maxqnt ??
    s.QNT_MAX ??
    s.qnt_max ??
    s.MAX_QNT ??
    s.max_qnt ??
    s.max_quantity ??
    s.maxQuantity ??
    s.maxQty ??
    s.MAX_QTY;

  let minQty = parseQuantityNumber(rawMin);
  let maxQty = parseQuantityNumber(rawMax);

  // 2. Check custom fields if passed or embedded in service
  let fieldsList: any[] = [];
  if (Array.isArray(customFields) && customFields.length > 0) {
    fieldsList = customFields;
  } else if (Array.isArray(s.customFields)) {
    fieldsList = s.customFields;
  } else if (s.requiresCustom) {
    try {
      const parsed = typeof s.requiresCustom === "string" ? JSON.parse(s.requiresCustom) : s.requiresCustom;
      if (Array.isArray(parsed)) {
        fieldsList = parsed;
      } else if (parsed && typeof parsed === "object") {
        fieldsList = Object.entries(parsed).map(([key, val]: any) => ({
          ...(val && typeof val === "object" ? val : {}),
          field_id: val?.field_id || val?.reqid || key,
          name: val?.name || val?.fieldname || key
        }));
      }
    } catch {}
  }

  let hasExplicitQuantityField = false;

  for (const field of fieldsList) {
    if (isQuantityField(field)) {
      hasExplicitQuantityField = true;

      // Extract from field attributes
      const fMin = parseQuantityNumber(field.min_quantity ?? field.minQty ?? field.min ?? field.MIN ?? field.MINQNT ?? field.minqnt);
      const fMax = parseQuantityNumber(field.max_quantity ?? field.maxQty ?? field.max ?? field.MAX ?? field.MAXQNT ?? field.maxqnt);
      if (minQty === null && fMin !== null) minQty = fMin;
      if (maxQty === null && fMax !== null) maxQty = fMax;

      // Extract from field description or placeholder
      const textLimits = extractLimitsFromText(
        `${field.description || ""} ${field.placeholder || ""} ${field.fieldoptions || ""}`
      );
      if (minQty === null && textLimits.min !== null) minQty = textLimits.min;
      if (maxQty === null && textLimits.max !== null) maxQty = textLimits.max;
    }
  }

  // 3. Extract limits from service name, info, or description
  const combinedText = `${sName} ${sInfo} ${sDesc}`;
  const textLimits = extractLimitsFromText(combinedText);
  if (minQty === null && textLimits.min !== null) minQty = textLimits.min;
  if (maxQty === null && textLimits.max !== null) maxQty = textLimits.max;

  // Raw string check on requiresCustom if present
  if (!hasExplicitQuantityField && typeof s.requiresCustom === "string") {
    try {
      const parsed = JSON.parse(s.requiresCustom);
      if (Array.isArray(parsed) && parsed.some(f => isQuantityField(f))) {
        hasExplicitQuantityField = true;
      }
    } catch {}
  }

  // 4. Check name patterns for dynamic quantity (e.g. "Any Qnt", "Credits Qnt", "Any Quantity")
  const hasQuantityNamePattern =
    /\bany\s*qnt\b|\bany\s*quantity\b|\bcustom\s*qnt\b|\bcustom\s*quantity\b|\bcredits?\s*qnt\b/i.test(sName) ||
    /\bany\s*qnt\b|\bany\s*quantity\b|\bcustom\s*qnt\b|\bcustom\s*quantity\b|\bcredits?\s*qnt\b/i.test(sInfo) ||
    /بأي\s*كمية|كمية\s*مخصصة/i.test(sName) ||
    /بأي\s*كمية|كمية\s*مخصصة/i.test(sInfo);

  // Check if provider explicitly declared quantity status
  const rawQntFlag =
    s.QNT ??
    s.qnt ??
    s.REQUIRES_QUANTITY ??
    s.requires_quantity ??
    s.supports_quantity ??
    s.supportsQty;

  const isExplicitlyDisabled =
    rawQntFlag === false ||
    rawQntFlag === "0" ||
    rawQntFlag === 0 ||
    s.supportsQty === false;

  // 5. Explicit provider quantity attributes
  const hasExplicitProviderQuantityAttr =
    rawQntFlag === "1" ||
    rawQntFlag === 1 ||
    rawQntFlag === true ||
    s.REQUIRES_QUANTITY === "1" ||
    s.REQUIRES_QUANTITY === true ||
    s.requires_quantity === true ||
    s.supports_quantity === true ||
    s.supportsQty === true ||
    s.supportsQty === "1" ||
    (minQty !== null && minQty > 1) ||
    (maxQty !== null && maxQty > 1);

  // Determine if service truly supports dynamic quantity
  const supportsQty = Boolean(
    !isExplicitlyDisabled &&
    (
      hasExplicitProviderQuantityAttr ||
      hasQuantityNamePattern ||
      hasExplicitQuantityField
    )
  );

  const finalMin = supportsQty && minQty !== null && minQty > 0 ? minQty : 1;
  const finalMax = supportsQty && maxQty !== null && maxQty > 0 ? maxQty : 0; // 0 = unlimited

  return {
    supportsQty,
    minQty: finalMin,
    maxQty: finalMax
  };
}

/**
 * Formats full service quantity configuration for serialization in APIs
 */
export function getServiceQuantityConfig(service: any): ServiceQuantityConfig {
  const limits = extractQuantityLimits(service);
  return {
    ...limits,
    min_quantity: limits.minQty,
    max_quantity: limits.maxQty
  };
}

/**
 * Normalizes custom fields and ensures any quantity field is properly tagged
 * with fieldtype = "quantity" and populated with min/max quantity.
 */
export function enrichCustomFieldsWithQuantity(
  customFields: any[],
  quantityLimits: QuantityLimits
): any[] {
  if (!Array.isArray(customFields)) return [];

  // If service does not support quantity, strip any erroneously injected QNT fields
  if (!quantityLimits.supportsQty) {
    return customFields.filter((field) => {
      const fid = String(field?.field_id || field?.reqid || field?.name || field?.id || "").trim();
      return fid !== "custom_QNT" && fid !== "QNT";
    });
  }

  let foundQuantityField = false;

  const enriched = customFields.map((field) => {
    if (!field || typeof field !== "object") return field;

    if (isQuantityField(field)) {
      foundQuantityField = true;
      return {
        ...field,
        type: "quantity",
        fieldtype: "quantity",
        is_quantity: true,
        label: field.label || "الكمية (Quantity)",
        required: false,
        min_quantity: quantityLimits.minQty,
        max_quantity: quantityLimits.maxQty
      };
    }

    return field;
  });

  // If the service supports quantity but provider did not define a custom field for QNT,
  // we add the standardized QNT field definition so provider orders can map it seamlessly
  if (quantityLimits.supportsQty && !foundQuantityField) {
    enriched.push({
      id: "custom_QNT",
      field_id: "QNT",
      name: "QNT",
      label: "الكمية (Quantity)",
      type: "quantity",
      fieldtype: "quantity",
      is_quantity: true,
      required: false,
      description: `الحد الأدنى: ${quantityLimits.minQty}${quantityLimits.maxQty > 0 ? ` | الحد الأقصى: ${quantityLimits.maxQty}` : ""}`,
      placeholder: `أدخل الكمية المطلوبة`,
      options: [],
      fieldoptions: [],
      min_quantity: quantityLimits.minQty,
      max_quantity: quantityLimits.maxQty
    });
  }

  return enriched;
}
