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
      if (field.id) candidateStrings.push(String(field.id));
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

  // Match explicit quantity min: qnt_min: 10, min qnt: 10, min quantity: 10, أقل كمية: 10
  const minMatch =
    sanitized.match(/(?:qnt_min|min_qnt|min\s*qnt|minimum\s*qnt|min\s*quantity|minimum\s*quantity|أقل\s*كمية|اقل\s*كمية|الحد\s*الأدنى\s*للكمية|الحد\s*الادنى\s*للكمية|أدنى\s*كمية)[:\s]*([0-9]+)/i);
  if (minMatch && minMatch[1]) {
    min = parseInt(minMatch[1], 10);
  }

  // Match explicit quantity max: qnt_max: 500, max qnt: 500, max quantity: 500, أقصى كمية: 500
  const maxMatch =
    sanitized.match(/(?:qnt_max|max_qnt|max\s*qnt|maximum\s*qnt|max\s*quantity|maximum\s*quantity|أقصى\s*كمية|اقصى\s*كمية|الحد\s*الأقصى\s*للكمية|الحد\s*الاقصى\s*للكمية|أعلى\s*كمية)[:\s]*([0-9]+)/i);
  if (maxMatch && maxMatch[1]) {
    max = parseInt(maxMatch[1], 10);
  }

  // Match Min 50 Pcs / (Min 50 Pcs) / Min 25
  if (min === null) {
    const minPcsMatch = sanitized.match(/\b(?:min|minimum|أقل|اقل|أدنى|ادنى)[:\s]*([0-9]+)\s*(?:pcs|pieces|قطع|قطعة|حبة|حبات|credits?|عملات)?\b/i);
    if (minPcsMatch && minPcsMatch[1]) {
      min = parseInt(minPcsMatch[1], 10);
    }
  }

  // Match Max 1000 Pcs / Max 1000
  if (max === null) {
    const maxPcsMatch = sanitized.match(/\b(?:max|maximum|أقصى|اقصى|أعلى|اعلى)[:\s]*([0-9]+)\s*(?:pcs|pieces|قطع|قطعة|حبة|حبات|credits?|عملات)?\b/i);
    if (maxPcsMatch && maxPcsMatch[1]) {
      max = parseInt(maxPcsMatch[1], 10);
    }
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
          id: val?.id || key,
          field_id: val?.field_id || val?.reqid || key,
          name: val?.name || val?.fieldname || key
        }));
      }
    } catch {}
  }

  // Filter out any artificial custom_QNT
  fieldsList = fieldsList.filter((f) => f && f.id !== "custom_QNT" && f.field_id !== "custom_QNT");

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
      if (Array.isArray(parsed) && parsed.some(f => f && f.id !== "custom_QNT" && f.field_id !== "custom_QNT" && isQuantityField(f))) {
        hasExplicitQuantityField = true;
      }
    } catch {}
  }

  // 4. Check name patterns for dynamic quantity (Credits, Any Qnt/Qty, Min Pcs, Social media, E-wallets)
  const isWithoutCredit = /\b(?:without|no|0)\s*credits?\b|بدون\s*(?:كريدت|رصيد)/i.test(combinedText);

  const hasCreditPattern =
    !isWithoutCredit &&
    (
      /\bcredits?\b/i.test(sName) ||
      /\bcredits?\b/i.test(sInfo) ||
      /\bcredit\b/i.test(sName) ||
      /\bcredits?\s*refill\b/i.test(combinedText) ||
      /\badd\s*credits?\b/i.test(combinedText) ||
      /\btransfer\s*credits?\b/i.test(combinedText) ||
      /\bكريدت\b|\bرصيد\b/i.test(sName) ||
      /\bكريدت\b|\bرصيد\b/i.test(sInfo)
    );

  const hasAnyQuantityPattern =
    /\bany\s*(?:qnt|qty|quantity)\b/i.test(combinedText) ||
    /\bcustom\s*(?:qnt|qty|quantity)\b/i.test(combinedText) ||
    /\bcredits?\s*(?:qnt|qty|quantity)\b/i.test(combinedText) ||
    /\b(?:qnt|qty)\b/i.test(sName) ||
    /بأي\s*كمية|كمية\s*مخصصة/i.test(combinedText);

  const hasMinPiecesPattern =
    /\b(?:min|minimum|أقل|اقل|أدنى|ادنى)[:\s]*[0-9]+\s*(?:pcs|pieces|قطع|قطعة|حبة|حبات|credits?|عملات)?\b/i.test(combinedText) ||
    /\b(?:max|maximum|أقصى|اقصى|أعلى|اعلى)[:\s]*[0-9]+\s*(?:pcs|pieces|قطع|قطعة|حبة|حبات|credits?|عملات)?\b/i.test(combinedText) ||
    (textLimits.min !== null && textLimits.min > 1) ||
    (textLimits.max !== null && textLimits.max > 0);

  const hasSocialMediaPattern =
    /\b(?:followers?|subscribers?|views?|likes?|comments?|shares?|retweets?|members?)\b/i.test(combinedText) ||
    /متابعين|مشتركين|مشاهدات|لايكات|إعجابات|تعليقات|مشاركات|ريتويت|أعضاء/i.test(combinedText);

  const hasWalletTransferPattern =
    /vodafone\s*cash|فودافون\s*كاش|instapay|انستاباي|شحن\s*رصيد|تحويل\s*رصيد/i.test(combinedText);

  const hasQuantityNamePattern = Boolean(
    hasCreditPattern ||
    hasAnyQuantityPattern ||
    hasMinPiecesPattern ||
    hasSocialMediaPattern ||
    hasWalletTransferPattern
  );

  // Check if provider explicitly declared quantity status
  const isExplicitlyDisabled =
    s.QNT === "0" ||
    s.QNT === 0 ||
    s.REQUIRES_QUANTITY === "0" ||
    s.REQUIRES_QUANTITY === false;

  // 5. Explicit provider or DB quantity attributes
  const hasExplicitProviderQuantityAttr =
    s.supportsQty === true ||
    s.supports_quantity === true ||
    s.QNT === "1" ||
    s.QNT === 1 ||
    s.QNT === true ||
    s.REQUIRES_QUANTITY === "1" ||
    s.REQUIRES_QUANTITY === true ||
    s.requires_quantity === true ||
    s.requires_quantity === "1";

  // Check if service belongs to IMEI/Device category or requires single-device hardware identifiers
  const categoryName = String(s.categoryName || s.category?.name || s.dhruCategory?.name || "").toLowerCase();
  const groupName = String(s.groupName || "").toLowerCase();
  const sType = String(s.SERVICETYPE || s.servicetype || "").toLowerCase();

  const isImeiOrDeviceService =
    (sType === "imei" || categoryName.includes("imei") || groupName.includes("imei")) &&
    !hasQuantityNamePattern &&
    fieldsList.some((f) => {
      const fn = String(f?.field_id || f?.name || f?.customname || f?.fieldname || "").toLowerCase();
      return fn === "imei" || fn === "ecid" || fn === "sn" || fn === "serial";
    });

  // IMEI and device bypass/unlock services are strictly single-device (1 unit) unless provider explicitly sets QNT: "1" or name has quantity
  if (isImeiOrDeviceService && !hasExplicitProviderQuantityAttr && !hasQuantityNamePattern) {
    return {
      supportsQty: false,
      minQty: 1,
      maxQty: 0
    };
  }

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
 * If the service supports quantity but lacks a QNT field, injects one so consumers
 * can seamlessly recognize and submit quantity.
 */
export function enrichCustomFieldsWithQuantity(
  customFields: any[],
  quantityLimits: QuantityLimits
): any[] {
  if (!Array.isArray(customFields)) {
    if (quantityLimits.supportsQty) {
      return [
        {
          id: "custom_QNT",
          field_id: "QNT",
          name: "QNT",
          fieldname: "custom_QNT",
          label: "الكمية (Quantity)",
          type: "quantity",
          fieldtype: "quantity",
          is_quantity: true,
          required: false,
          min_quantity: quantityLimits.minQty,
          max_quantity: quantityLimits.maxQty
        }
      ];
    }
    return [];
  }

  // If service does not support quantity, strip any erroneously injected QNT fields
  if (!quantityLimits.supportsQty) {
    return customFields.filter((field) => {
      const fid = String(field?.field_id || field?.reqid || field?.name || field?.id || "").trim();
      return fid !== "custom_QNT" && fid !== "QNT";
    });
  }

  let foundQuantity = false;
  const enriched = customFields.map((field) => {
    if (!field || typeof field !== "object") return field;

    if (isQuantityField(field)) {
      foundQuantity = true;
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

  if (!foundQuantity) {
    enriched.push({
      id: "custom_QNT",
      field_id: "QNT",
      name: "QNT",
      fieldname: "custom_QNT",
      label: "الكمية (Quantity)",
      type: "quantity",
      fieldtype: "quantity",
      is_quantity: true,
      required: false,
      min_quantity: quantityLimits.minQty,
      max_quantity: quantityLimits.maxQty
    });
  }

  return enriched;
}
