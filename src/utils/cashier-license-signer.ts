import * as crypto from 'node:crypto';

export type CashierEntitlementStatus = 'ACTIVE' | 'TRIAL' | 'EXPIRED' | 'REVOKED';

export interface CashierEntitlementClaims {
  v: 1;
  machine: string;
  status: CashierEntitlementStatus;
  until: string | null;
  serverTime: string;
  leaseSeconds: number;
  nonce: string;
  shopName: string;
  email: string;
}

export interface SignedCashierEntitlement {
  status: CashierEntitlementStatus;
  until: string | null;
  shopName: string;
  email: string;
  serverTime: string;
  leaseSeconds: number;
  nonce: string;
  keyId: string;
  signature: string;
}

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function normalizePem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes('BEGIN PRIVATE KEY') || trimmed.includes('BEGIN PUBLIC KEY')) {
    return trimmed.replace(/\\n/g, '\n');
  }
  return Buffer.from(trimmed, 'base64').toString('utf8');
}

function derivePrivateKeyFromSecret(secret: string): crypto.KeyObject {
  const seed = Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'arabpro-cashier-ed25519-v1', 'license-signing-key', 32),
  );
  return crypto.createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

export function resolveCashierSigningKeys(): {
  privateKey: crypto.KeyObject;
  publicKey: crypto.KeyObject;
  publicKeyPem: string;
  keyId: string;
} {
  const explicitPrivate = process.env.CASHIER_LICENSE_PRIVATE_KEY?.trim();
  let privateKey: crypto.KeyObject;
  if (explicitPrivate) {
    privateKey = crypto.createPrivateKey(normalizePem(explicitPrivate));
    if (privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('CASHIER_LICENSE_PRIVATE_KEY must be an Ed25519 private key');
    }
  } else {
    const secret = (process.env.CASHIER_LICENSE_SIGNING_SECRET || process.env.JWT_SECRET || '').trim();
    if (secret.length < 32) {
      throw new Error('Cashier license signing secret is not configured (minimum 32 characters)');
    }
    privateKey = derivePrivateKeyFromSecret(secret);
  }

  const publicKey = crypto.createPublicKey(privateKey);
  const publicKeyPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const keyId = crypto.createHash('sha256').update(publicKeyPem).digest('hex').slice(0, 16);
  return { privateKey, publicKey, publicKeyPem, keyId };
}

export function canonicalizeEntitlementClaims(claims: CashierEntitlementClaims): string {
  return JSON.stringify({
    v: claims.v,
    machine: claims.machine,
    status: claims.status,
    until: claims.until,
    serverTime: claims.serverTime,
    leaseSeconds: claims.leaseSeconds,
    nonce: claims.nonce,
    shopName: claims.shopName,
    email: claims.email,
  });
}

export function signCashierEntitlement(input: {
  machine: string;
  status: CashierEntitlementStatus;
  until: Date | string | null;
  shopName: string;
  email: string;
  nonce?: string;
  leaseSeconds?: number;
  serverTime?: Date | string;
}): SignedCashierEntitlement {
  const { privateKey, keyId } = resolveCashierSigningKeys();
  const untilIso = input.until
    ? (input.until instanceof Date ? input.until.toISOString() : new Date(input.until).toISOString())
    : null;
  const serverTimeIso = input.serverTime
    ? (input.serverTime instanceof Date ? input.serverTime.toISOString() : new Date(input.serverTime).toISOString())
    : new Date().toISOString();
  const leaseSeconds = Math.min(Math.max(10, Number(input.leaseSeconds ?? 30)), 35);
  const nonce = input.nonce || '';

  const claims: CashierEntitlementClaims = {
    v: 1,
    machine: input.machine,
    status: input.status,
    until: untilIso,
    serverTime: serverTimeIso,
    leaseSeconds,
    nonce,
    shopName: input.shopName,
    email: input.email,
  };

  const payload = Buffer.from(canonicalizeEntitlementClaims(claims), 'utf8');
  const signature = crypto.sign(null, payload, privateKey).toString('base64url');

  return {
    status: claims.status,
    until: claims.until,
    shopName: claims.shopName,
    email: claims.email,
    serverTime: claims.serverTime,
    leaseSeconds: claims.leaseSeconds,
    nonce: claims.nonce,
    keyId,
    signature,
  };
}

export function verifyCashierEntitlement(
  envelope: {
    machine: string;
    status: CashierEntitlementStatus;
    until: string | null;
    serverTime: string;
    leaseSeconds: number;
    nonce: string;
    shopName: string;
    email: string;
    signature: string;
  },
  publicKeyPem: string
): boolean {
  const payload = Buffer.from(
    canonicalizeEntitlementClaims({
      v: 1,
      machine: envelope.machine,
      status: envelope.status,
      until: envelope.until,
      serverTime: envelope.serverTime,
      leaseSeconds: envelope.leaseSeconds,
      nonce: envelope.nonce,
      shopName: envelope.shopName,
      email: envelope.email,
    }),
    'utf8'
  );
  const sig = Buffer.from(envelope.signature, 'base64url');
  return crypto.verify(null, payload, publicKeyPem, sig);
}

export function getCashierSigningKeyInfo(): { keyId: string; publicKeyPem: string } {
  const { keyId, publicKeyPem } = resolveCashierSigningKeys();
  return { keyId, publicKeyPem };
}
