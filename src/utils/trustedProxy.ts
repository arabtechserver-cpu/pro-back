import net from 'net';

// Never trust a hop count or all private networks: the frontend and API can
// have different ingress paths. An empty setting safely disables forwarding.
export function getTrustedProxies(value = process.env.TRUSTED_PROXY_CIDRS || ''): false | string[] {
  const entries = value.split(',').map(item => item.trim()).filter(Boolean);
  for (const entry of entries) {
    const [address, prefix, extra] = entry.split('/');
    const version = net.isIP(address);
    if (!version || extra !== undefined || (prefix !== undefined &&
      (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (version === 4 ? 32 : 128)))) {
      throw new Error('TRUSTED_PROXY_CIDRS must contain explicit proxy IP addresses or nonzero CIDR ranges');
    }
  }
  return entries.length ? entries : false;
}
