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
 * Checks whether an IP address is syntactically valid (IPv4 or IPv6).
 */
export function isValidIp(ip: string): boolean {
  if (!ip) return false;
  const normalized = normalizeIp(ip);
  return net.isIP(normalized) !== 0;
}

/**
 * Compares two IP addresses for semantic equality after normalization.
 */
export function areIpsEqual(ip1: string, ip2: string): boolean {
  if (!ip1 || !ip2) return false;
  const n1 = normalizeIp(ip1);
  const n2 = normalizeIp(ip2);
  if (n1 === n2) return true;

  const localhostIps = ['127.0.0.1', '::1', 'localhost'];
  if (localhostIps.includes(n1) && localhostIps.includes(n2)) {
    return true;
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
    if (isValidIp(candidate)) return candidate;
  }

  // 2. X-Real-IP header (direct upstream proxy set)
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    const candidate = normalizeIp(realIp.split(',')[0]);
    if (isValidIp(candidate)) return candidate;
  }

  // 3. Standard X-Forwarded-For header (first hop is client)
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    const candidate = normalizeIp(forwardedFor.split(',')[0]);
    if (isValidIp(candidate)) return candidate;
  }

  // 4. Express req.ip
  if (req.ip) {
    const candidate = normalizeIp(req.ip);
    if (isValidIp(candidate)) return candidate;
  }

  // 5. Socket remote address
  const socketAddress = req.socket?.remoteAddress;
  if (socketAddress) {
    const candidate = normalizeIp(socketAddress);
    if (isValidIp(candidate)) return candidate;
  }

  return '127.0.0.1';
}
