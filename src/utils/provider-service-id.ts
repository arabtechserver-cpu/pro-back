const PROVIDER_SERVICE_SEPARATOR = "::";

// A provider can reuse another provider's Dhru service number. Store a scoped
// database ID while preserving the original number for requests to the provider.
export function buildProviderServiceId(providerId: string, remoteServiceId: string): string {
  return `${providerId}${PROVIDER_SERVICE_SEPARATOR}${remoteServiceId}`;
}

export function getProviderRemoteServiceId(storedServiceId: string): string {
  const separatorIndex = storedServiceId.lastIndexOf(PROVIDER_SERVICE_SEPARATOR);
  return separatorIndex === -1 ? storedServiceId : storedServiceId.slice(separatorIndex + PROVIDER_SERVICE_SEPARATOR.length);
}
