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

function parseHttpOrigin(raw: string): URL | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined' || /[,\s]/.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.hostname || /[,\s:]/.test(parsed.hostname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '0.0.0.0' || lower === '::1' || lower === '[::1]';
}

// FRONTEND_URL frequently holds a comma-separated CORS list; building links needs one origin.
export function resolvePrimaryFrontendUrl(
  explicitOrigin?: string | null,
  envFrontendUrl = process.env.FRONTEND_URL,
  envSiteUrl = process.env.NEXT_PUBLIC_SITE_URL
): string {
  const rawSources = [explicitOrigin, envSiteUrl, envFrontendUrl]
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .flatMap((v) => v.split(',').map((part) => part.trim()).filter(Boolean));

  const parsedUrls = rawSources
    .map(parseHttpOrigin)
    .filter((u): u is URL => u !== null);

  if (parsedUrls.length === 0) return '';

  const preferred =
    parsedUrls.find((u) => u.protocol === 'https:' && !isLoopbackHost(u.hostname)) ||
    parsedUrls.find((u) => !isLoopbackHost(u.hostname)) ||
    parsedUrls[0];

  return preferred.origin;
}

export function isValidTelegramButtonUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string') return false;
  const parsed = parseHttpOrigin(rawUrl);
  if (!parsed) return false;
  // Telegram rejects loopback URLs and multi-origin comma strings in inline keyboard buttons.
  return !isLoopbackHost(parsed.hostname);
}

export function sanitizeTelegramReplyMarkup<T = any>(replyMarkup: T): T | undefined {
  if (!replyMarkup || typeof replyMarkup !== 'object') return undefined;
  const markup: any = replyMarkup;
  if (!Array.isArray(markup.inline_keyboard)) return replyMarkup;

  const cleanedRows = markup.inline_keyboard
    .map((row: unknown) => {
      if (!Array.isArray(row)) return [];
      return row.filter((button: any) => {
        if (!button || typeof button !== 'object') return false;
        if ('url' in button && button.url !== undefined) {
          return isValidTelegramButtonUrl(button.url);
        }
        return true;
      });
    })
    .filter((row: any[]) => row.length > 0);

  if (cleanedRows.length === 0) return undefined;
  return { ...markup, inline_keyboard: cleanedRows };
}

