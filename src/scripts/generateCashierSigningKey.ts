import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getCashierSigningKeyInfo } from '../utils/cashier-license-signer';

const envPath = path.resolve(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

if (process.argv.includes('--print-active')) {
  const info = getCashierSigningKeyInfo();
  console.log('KEY_ID=' + info.keyId);
  console.log(info.publicKeyPem.trim());
  process.exit(0);
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const privPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
const pubPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
const keyId = crypto.createHash('sha256').update(pubPem).digest('hex').slice(0, 16);

console.log('KEY_ID=' + keyId);
console.log('CASHIER_LICENSE_PRIVATE_KEY=' + JSON.stringify(privPem));
console.log('CASHIER_LICENSE_PUBLIC_KEY=' + JSON.stringify(pubPem));
