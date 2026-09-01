export type OrderMetadata = {
  customFields: Record<string, string> | null;
  events: any[];
  rawImei: string | null;
  visibleNote: string | null;
};

export type OrderFieldDetail = {
  id: string;
  providerFieldId: string;
  label: string;
  type: string;
  required: boolean;
  value: string;
  missing: boolean;
};

function parseFieldDefinitions(requiredFields: unknown): any[] {
  let parsed: any = requiredFields;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }

  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];

  return Object.entries(parsed).map(([key, value]) => ({
    ...(value && typeof value === "object" ? value : {}),
    field_id: (value as any)?.field_id || (value as any)?.reqid || key
  }));
}

export function getOrderServiceType(categoryName: unknown): "imei" | "server" | "remote" | "unknown" {
  const normalized = String(categoryName || "").toLowerCase();
  if (normalized.includes("remote")) return "remote";
  if (normalized.includes("server")) return "server";
  if (normalized.includes("imei")) return "imei";
  return "unknown";
}

export function buildOrderFieldDetails(
  requiredFields: unknown,
  submittedFields: Record<string, string> | null = null
): OrderFieldDetail[] {
  const definitions = parseFieldDefinitions(requiredFields);
  const submittedEntries = Object.entries(submittedFields || {});
  const usedKeys = new Set<string>();

  const details = definitions.map((field: any) => {
    const id = String(field?.id || field?.name || field?.field_id || field?.reqid || "field");
    const providerFieldId = String(
      field?.field_id || field?.reqid || field?.REQID || field?.api_name || id
    );
    const aliases = [id, providerFieldId, field?.name, field?.label]
      .filter(Boolean)
      .map((alias) => String(alias).toLowerCase());
    const submitted = submittedEntries.find(([key]) => aliases.includes(key.toLowerCase()));
    if (submitted) usedKeys.add(submitted[0]);

    const value = submitted ? String(submitted[1] ?? "") : "";
    const required = field?.required === true
      || field?.required === 1
      || ["1", "true", "on", "yes"].includes(String(field?.required || "").toLowerCase());

    return {
      id,
      providerFieldId,
      label: providerFieldId.replace(/^custom_/i, "").trim() || id,
      type: String(field?.type || field?.fieldtype || "text"),
      required,
      value,
      missing: required && !value.trim()
    };
  });

  for (const [key, rawValue] of submittedEntries) {
    if (usedKeys.has(key)) continue;
    const value = String(rawValue ?? "");
    details.push({
      id: key,
      providerFieldId: key,
      label: key.replace(/^custom_/i, "").trim() || key,
      type: "text",
      required: false,
      value,
      missing: false
    });
  }

  return details;
}

export function parseOrderMetadata(notes: unknown): OrderMetadata {
  const empty: OrderMetadata = {
    customFields: null,
    events: [],
    rawImei: null,
    visibleNote: null
  };

  if (typeof notes !== "string" || !notes.trim()) return empty;

  try {
    const parsed = JSON.parse(notes);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...empty, visibleNote: typeof parsed === "string" ? parsed : null };
    }

    return {
      customFields: parsed.customFields && typeof parsed.customFields === "object"
        ? parsed.customFields
        : null,
      events: Array.isArray(parsed.events) ? parsed.events : [],
      rawImei: typeof parsed.rawImei === "string" && parsed.rawImei.trim()
        ? parsed.rawImei.trim()
        : null,
      visibleNote: typeof parsed.userNote === "string" && parsed.userNote.trim()
        ? parsed.userNote.trim()
        : null
    };
  } catch {
    return { ...empty, visibleNote: notes };
  }
}
