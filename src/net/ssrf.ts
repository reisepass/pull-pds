import { isIP } from 'node:net';

/**
 * True if `ip` is loopback, link-local, private (RFC1918 and friends), or
 * otherwise not a public unicast address. Operates on a resolved address, never
 * on a hostname - the caller resolves the name and checks the address, so a
 * hostile origin cannot smuggle a private target past a hostname pattern.
 *
 * This is the core of both the SSRF guard and the DNS-rebinding pin: every
 * address we might dial is run through here before we connect, and the address
 * that passes is the exact address we pin the socket to.
 */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  // Not a parseable IP -> treat as blocked; we should only ever be handed
  // addresses that came back from a DNS lookup.
  return true;
}

function isBlockedV4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

function isBlockedV6(ip: string): boolean {
  const addr = ip.toLowerCase().split('%')[0] ?? ip.toLowerCase(); // strip zone id
  if (addr === '::1') return true; // loopback
  if (addr === '::') return true; // unspecified

  // Expand to the full 8-hextet numeric form so every encoding of the same
  // address is checked identically. This closes the bypass where an
  // IPv4-mapped/embedded loopback is written in hex (`::ffff:7f00:1`) rather
  // than dotted-decimal (`::ffff:127.0.0.1`).
  const expanded = expandV6(addr);
  if (!expanded || expanded.length !== 8) return true; // unparseable -> blocked
  const groups = expanded as [number, number, number, number, number, number, number, number];

  // IPv4-mapped ::ffff:0:0/96 -> the low 32 bits are an embedded v4 address.
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
  ) {
    return isBlockedV4(v4FromHextets(groups[6], groups[7]));
  }
  // IPv4-compatible ::a.b.c.d (deprecated) -> also an embedded v4 address.
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0 &&
    !(groups[6] === 0 && groups[7] <= 1) // exclude :: and ::1 handled above
  ) {
    return isBlockedV4(v4FromHextets(groups[6], groups[7]));
  }
  // 6to4 2002:V4::/16 embeds a v4 address in the next 32 bits.
  if (groups[0] === 0x2002) {
    return isBlockedV4(v4FromHextets(groups[1], groups[2]));
  }
  // NAT64 64:ff9b::/96 (well-known prefix) embeds a v4 in the low 32 bits.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
    return isBlockedV4(v4FromHextets(groups[6], groups[7]));
  }

  const high = groups[0];
  if ((high & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((high & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((high & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/**
 * Expand an IPv6 string (already lowercased, zone stripped) to eight numeric
 * hextets, handling `::` compression and a trailing dotted-quad. Returns null on
 * anything malformed.
 */
function expandV6(addr: string): number[] | null {
  // Split off a trailing embedded IPv4 (`...:a.b.c.d`) into two hextets.
  let head = addr;
  let tailHextets: number[] = [];
  const dotted = addr.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted && dotted[1]) {
    const v4 = dotted[1].split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    tailHextets = [(v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!];
    // Strip the dotted-quad, and the single ':' separating it from the hextets
    // (but keep a '::' compression marker intact).
    head = addr.slice(0, addr.length - dotted[1].length);
    if (head.endsWith(':') && !head.endsWith('::')) head = head.slice(0, -1);
  }

  const hasCompression = head.includes('::');
  const sides = head.split('::');
  if (sides.length > 2) return null;

  const parseSide = (s: string): number[] | null => {
    if (s === '') return [];
    const out: number[] = [];
    for (const h of s.split(':')) {
      if (h === '') return null;
      const n = parseInt(h, 16);
      if (Number.isNaN(n) || n < 0 || n > 0xffff || !/^[0-9a-f]{1,4}$/.test(h)) return null;
      out.push(n);
    }
    return out;
  };

  const left = parseSide(sides[0] ?? '');
  if (left === null) return null;
  const right = hasCompression ? parseSide(sides[1] ?? '') : [];
  if (right === null) return null;

  const explicit = [...left, ...right, ...tailHextets];
  if (hasCompression) {
    const missing = 8 - explicit.length;
    if (missing < 0) return null;
    return [...left, ...Array(missing).fill(0), ...right, ...tailHextets];
  }
  return explicit.length === 8 ? explicit : null;
}

function v4FromHextets(hi: number, lo: number): string {
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}
