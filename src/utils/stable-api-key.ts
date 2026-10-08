import { randomBytes } from 'crypto';

// Conditional initialization also protects simultaneous activation/settings requests.
// Only the explicit regenerate endpoint is allowed to replace an existing key.
export async function ensureStableApiKey(db: any, userId: string): Promise<void> {
  await db.user.updateMany({
    where: { id: userId, apiKey: null },
    data: { apiKey: 'ATS-' + randomBytes(16).toString('hex') }
  });
}
