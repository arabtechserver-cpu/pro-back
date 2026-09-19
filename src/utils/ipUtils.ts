import { Request } from 'express';
import net from 'net';

export const MAX_ALLOWED_IPS = 2;
export const SETTING_KEY_RESTRICTION_ENABLED = 'dashboard_ip_restriction_enabled';

/**
 * Normalizes an IP string:
 * - Strips enclosing quotes and brackets
 * - Strips IPv4-mapped IPv6 prefix (::ffff:)
 * - Normalizes IPv6 localhost (::1 -> 127.0.0.1)
 * - Strips port numbers from IPv4 and IPv6
 * - Lowercases IPv6 representations
 */
export function normalizeIp(rawIp: string | null | undefined): string {
  if (!rawIp || typeof rawIp !== 'string') {
    return '';
  }

  let cleaned = rawIp.trim().replace(/^["']|["']$/g, '');

  // If brackets around IPv6 with or without port e.g. [2001:db8::1]:443 or [2001:db8::1]
  if (cleaned.startsWith('[')) {
    const closingBracket = cleaned.indexOf(']');
    if (closingBracket !== -1) {
      cleaned = cleaned.substring(1, closingBracket);
    }
  }

  // Strip IPv4-mapped IPv6 prefix
  if (cleaned.toLowerCase().startsWith('::ffff:')) {
    cleaned = cleaned.substring(7);
  }

  // Normalize localhost
  if (cleaned === '::1') {
    return '127.0.0.1';
  }

  // Strip port if present in IPv4 (e.g. 192.168.1.1:8080)
  if (cleaned.includes('.') && cleaned.includes(':')) {
    const parts = cleaned.split(':');
    if (parts.length === 2 && net.isIP(parts[0]) === 4) {
      cleaned = parts[0];
    }
  }

  return cleaned.toLowerCase();
}

/**
 * Checks whether an IP address is a syntactically valid single IPv4 or IPv6.
 */
export function isValidSingleIp(ip: string): boolean {
  if (!ip) return false;
  const normalized = normalizeIp(ip);
  return net.isIP(normalized) !== 0;
}

/**
 * Checks whether an IP address is syntactically valid (IPv4, IPv6, wildcard, or CIDR).
 */
export function isValidIp(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return false;
  const normalized = normalizeIp(ip);

  // Check standard single IP
  if (net.isIP(normalized) !== 0) return true;

  // Wildcard IPv4 pattern (e.g., 197.252.98.* or 197.252.*.*)
  if (normalized.includes('*')) {
    const parts = normalized.split('.');
    if (parts.length !== 4) return false;
    let seenStar = false;
    for (const part of parts) {
      if (part === '*') {
        seenStar = true;
      } else {
        if (seenStar) return false;
        if (!/^\d+$/.test(part)) return false;
        const num = Number(part);
        if (num < 0 || num > 255) return false;
      }
    }
    return true;
  }

  // CIDR notation (e.g., 197.252.98.0/24)
  if (normalized.includes('/')) {
    const [ipPart, maskPart] = normalized.split('/');
    if (!ipPart || !maskPart || !/^\d+$/.test(maskPart)) return false;
    const mask = Number(maskPart);
    if (net.isIP(ipPart) === 4 && mask >= 8 && mask <= 32) return true;
    if (net.isIP(ipPart) === 6 && mask >= 16 && mask <= 128) return true;
  }

  return false;
}

/**
 * Checks whether an IP belongs to private/internal ranges (RFC 1918 / Loopback)
 */
export function isPrivateOrLocalIp(ip: string): boolean {
  if (!ip) return false;
  const normalized = normalizeIp(ip);
  if (!normalized) return false;

  const localhostIps = ['127.0.0.1', '::1', 'localhost'];
  if (localhostIps.includes(normalized)) return true;

  if (net.isIP(normalized) === 4) {
    const parts = normalized.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
  }

  return false;
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => ((acc << 8) + Number(octet)) >>> 0, 0);
}

/**
 * Compares two IP addresses for semantic equality after normalization,
 * supporting exact matches, wildcards (e.g. 197.252.98.*), and CIDR ranges.
 */
export function areIpsEqual(configuredIp: string, clientIp: string): boolean {
  if (!configuredIp || !clientIp) return false;
  const n1 = normalizeIp(configuredIp);
  const n2 = normalizeIp(clientIp);
  if (n1 === n2) return true;

  const localhostIps = ['127.0.0.1', '::1', 'localhost'];
  if (localhostIps.includes(n1) && localhostIps.includes(n2)) {
    return true;
  }

  // Wildcard pattern e.g. 197.252.98.*
  if (n1.includes('*') && net.isIP(n2) === 4) {
    const patternParts = n1.split('.');
    const clientParts = n2.split('.');
    if (patternParts.length === 4 && clientParts.length === 4) {
      return patternParts.every((part, i) => part === '*' || part === clientParts[i]);
    }
  }

  // CIDR notation e.g. 197.252.98.0/24
  if (n1.includes('/') && net.isIP(n2) === 4) {
    const [baseIp, maskStr] = n1.split('/');
    if (net.isIP(baseIp) === 4) {
      const maskBits = Number(maskStr);
      if (maskBits >= 0 && maskBits <= 32) {
        const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
        const baseInt = (ipv4ToInt(baseIp) & mask) >>> 0;
        const clientInt = (ipv4ToInt(n2) & mask) >>> 0;
        return baseInt === clientInt;
      }
    }
  }

  return false;
}

/**
 * Extracts the real client IP from Express request, handling:
 * - Cloudflare (cf-connecting-ip)
 * - Standard Reverse Proxies (x-forwarded-for, x-real-ip)
 * - Express trust proxy (req.ip)
 * - Socket address
 */
export function extractClientIp(req: Request): string {
  // 1. Cloudflare genuine client IP header
  const cfConnectingIp = req.headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string' && cfConnectingIp.trim()) {
    const candidate = normalizeIp(cfConnectingIp.split(',')[0]);
    if (isValidSingleIp(candidate)) return candidate;
  }

  // 2. X-Real-IP header (direct upstream proxy set)
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    const candidate = normalizeIp(realIp.split(',')[0]);
    if (isValidSingleIp(candidate)) return candidate;
  }

  // 3. Standard X-Forwarded-For header (first hop is client)
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    const candidate = normalizeIp(forwardedFor.split(',')[0]);
    if (isValidSingleIp(candidate)) return candidate;
  }

  // 4. Express req.ip
  if (req.ip) {
    const candidate = normalizeIp(req.ip);
    if (isValidSingleIp(candidate)) return candidate;
  }

  // 5. Socket remote address
  const socketAddress = req.socket?.remoteAddress;
  if (socketAddress) {
    const candidate = normalizeIp(socketAddress);
    if (isValidSingleIp(candidate)) return candidate;
  }

  return '127.0.0.1';
}
