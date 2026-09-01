export type OrderMetadata = {
  customFields: Record<string, string> | null;
  events: any[];
  rawImei: string | null;
  visibleNote: string | null;
};

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
