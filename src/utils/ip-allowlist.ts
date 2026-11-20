import { BlockList, isIPv4, isIPv6 } from 'node:net';

export interface IpAllowlist {
  /** The CIDR ranges as configured, for logging. */
  readonly ranges: readonly string[];
  allows(address: string | undefined): boolean;
}

/** Parses "a.b.c.d/n" or "v6::/n" (a bare address means a single host). Null when invalid. */
export function parseCidr(
  entry: string,
): { address: string; prefix: number; type: 'ipv4' | 'ipv6' } | null {
  const [address = '', prefixText, extra] = entry.trim().split('/');
  if (extra !== undefined) return null;
  const type = isIPv4(address) ? 'ipv4' : isIPv6(address) ? 'ipv6' : null;
  if (!type) return null;
  const maxPrefix = type === 'ipv4' ? 32 : 128;
  const prefix = prefixText === undefined ? maxPrefix : Number(prefixText);
  if (!/^\d{1,3}$/.test(prefixText ?? String(maxPrefix)) || prefix < 0 || prefix > maxPrefix) {
    return null;
  }
  return { address, prefix, type };
}

export function createIpAllowlist(ranges: readonly string[]): IpAllowlist {
  const list = new BlockList();
  for (const range of ranges) {
    const parsed = parseCidr(range);
    if (!parsed) throw new Error(`Invalid CIDR range: ${range}`);
    list.addSubnet(parsed.address, parsed.prefix, parsed.type);
  }
  return {
    ranges,
    allows(address) {
      if (!address || ranges.length === 0) return false;
      // Dual-stack sockets report IPv4 clients as IPv4-mapped IPv6 (::ffff:a.b.c.d).
      const normalized =
        address.startsWith('::ffff:') && isIPv4(address.slice(7)) ? address.slice(7) : address;
      if (isIPv4(normalized)) return list.check(normalized, 'ipv4');
      if (isIPv6(normalized)) return list.check(normalized, 'ipv6');
      return false;
    },
  };
}
