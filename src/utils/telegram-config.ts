export function normalizeTelegramAdminChatIds(
  ids: unknown,
  defaultChatId: unknown
): string[] {
  const candidates = Array.isArray(ids) ? ids : [];
  const normalized = candidates
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);
  const fallback = String(defaultChatId ?? "").trim();

  if (fallback) normalized.push(fallback);
  return Array.from(new Set(normalized));
}
