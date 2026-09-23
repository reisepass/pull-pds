import { describe, it, expect } from 'vitest';
import { isBlockedAddress } from '../src/net/ssrf.js';

/**
 * SSRF address predicate, including the IPv6-encoding bypasses that a naive
 * dotted-decimal-only check misses. Every alternative spelling of
 * a blocked v4 address must be blocked; genuine public addresses must pass.
 */

describe('isBlockedAddress - IPv4', () => {
  const blocked = [
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '127.1.2.3', '100.64.0.1',
    '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '192.0.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
  ];
  const allowed = ['1.1.1.1', '8.8.8.8', '203.0.113.5', '35.198.162.107', '172.32.0.1', '100.63.0.1'];
  it.each(blocked)('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(allowed)('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('isBlockedAddress - IPv6 and embedded-v4 bypasses', () => {
  const blocked = [
    '::1',                      // loopback
    '::',                       // unspecified
    'fc00::1',                  // ULA
    'fd12:3456::1',             // ULA
    'fe80::1',                  // link-local
    'ff02::1',                  // multicast
    '::ffff:127.0.0.1',         // IPv4-mapped loopback (dotted)
    '::ffff:7f00:1',            // IPv4-mapped loopback (HEX) - the bypass
    '0:0:0:0:0:ffff:7f00:1',    // same, fully expanded
    '::ffff:10.0.0.1',          // IPv4-mapped RFC1918
    '::ffff:a00:1',             // IPv4-mapped RFC1918 (hex)
    '::ffff:169.254.169.254',   // IPv4-mapped link-local metadata
    '2002:7f00:1::',            // 6to4 embedding 127.0.0.1
    '2002:a9fe:a9fe::',         // 6to4 embedding 169.254.169.254
    '64:ff9b::7f00:1',          // NAT64 embedding 127.0.0.1
    '64:ff9b::a9fe:a9fe',       // NAT64 embedding 169.254.169.254
  ];
  const allowed = [
    '2606:4700:4700::1111',     // Cloudflare
    '2001:4860:4860::8888',     // Google
    '::ffff:1.1.1.1',           // IPv4-mapped public
    '::ffff:808:808',           // IPv4-mapped 8.8.8.8 (hex)
    '2002:0808:0808::',         // 6to4 embedding 8.8.8.8 (public)
    '64:ff9b::808:808',         // NAT64 embedding public
  ];
  it.each(blocked)('blocks %s', (ip) => expect(isBlockedAddress(ip)).toBe(true));
  it.each(allowed)('allows %s', (ip) => expect(isBlockedAddress(ip)).toBe(false));
});

describe('isBlockedAddress - malformed', () => {
  it('blocks anything that is not a parseable IP', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress('999.999.999.999')).toBe(true);
    expect(isBlockedAddress('::ffff:999.0.0.1')).toBe(true);
  });
});
