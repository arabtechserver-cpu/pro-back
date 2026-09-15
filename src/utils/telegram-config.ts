export function normalizeTelegramAdminChatIds(
  ids: unknown,
  defaultChatId: unknown
): string[] {
  const candidates = Array.isArray(ids) ? ids : [];
  const normalized = candidates
    .map((id) => String(id ?? '').trim())
    .filter(Boolean);

  // Support comma-separated list in env var: "111,222,333"
  const fallback = String(defaultChatId ?? '').trim();
  if (fallback) {
    fallback.split(',').map(s => s.trim()).filter(Boolean).forEach(id => normalized.push(id));
  }

  return Array.from(new Set(normalized));
}
