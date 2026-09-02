export type ApiActivationInput = {
  apiSiteName?: unknown;
  apiSiteUrl?: unknown;
  confirmActivation?: unknown;
};

export function prepareApiActivation(
  input: ApiActivationInput,
  existingApiKey: string | null | undefined,
  createApiKey: () => string
) {
  if (input.confirmActivation !== true) {
    throw new Error("API activation confirmation is required");
  }

  const apiSiteName = String(input.apiSiteName || "").trim();
  const rawUrl = String(input.apiSiteUrl || "").trim();
  if (!apiSiteName || !rawUrl) {
    throw new Error("Site name and URL are required");
  }

  let apiSiteUrl: string;
  try {
    const parsedUrl = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsedUrl.protocol)) throw new Error("invalid protocol");
    apiSiteUrl = parsedUrl.toString();
  } catch {
    throw new Error("A valid HTTP or HTTPS site URL is required");
  }

  return {
    apiEnabled: true,
    apiSiteName,
    apiSiteUrl,
    apiKey: existingApiKey || createApiKey()
  };
}
