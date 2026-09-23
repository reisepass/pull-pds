import { describe, it, expect } from 'vitest';
import {
  guardedFetch,
  GuardedFetchError,
  type Dialer,
  type GuardedResponse,
  type HostResolver,
} from '../src/net/guarded-fetch.js';

const baseOpts = { timeoutMs: 1000, maxBytes: 64 * 1024, maxRedirects: 3 };

/** A dialer that records the address it was told to pin and returns a canned response. */
function recordingDialer(
  response: (parsed: URL, addr: string) => Partial<GuardedResponse>,
): { dialer: Dialer; dialledAddresses: string[]; dialledHosts: string[] } {
  const dialledAddresses: string[] = [];
  const dialledHosts: string[] = [];
  const dialer: Dialer = async (parsed, pinnedAddress) => {
    dialledAddresses.push(pinnedAddress);
    dialledHosts.push(parsed.hostname);
    return {
      status: 200,
      headers: new Map(),
      body: new Uint8Array(),
      url: parsed.toString(),
      peerAddress: pinnedAddress,
      ...response(parsed, pinnedAddress),
    };
  };
  return { dialer, dialledAddresses, dialledHosts };
}

describe('guardedFetch address pinning (DNS-rebinding fix)', () => {
  it('resolves once and pins exactly the validated address to the dial', async () => {
    let lookups = 0;
    const resolver: HostResolver = async () => {
      lookups++;
      return ['93.184.216.34'];
    };
    const { dialer, dialledAddresses, dialledHosts } = recordingDialer(() => ({}));

    await guardedFetch('https://example.com/.well-known/did.json', {
      ...baseOpts,
      resolver,
      dialer,
    });

    // Exactly one DNS resolution; the dial targets the resolved IP while the
    // hostname is preserved for SNI/Host/TLS.
    expect(lookups).toBe(1);
    expect(dialledAddresses).toEqual(['93.184.216.34']);
    expect(dialledHosts).toEqual(['example.com']);
  });

  it('REGRESSION: a rebinding resolver that returns [public, private] is rejected', async () => {
    // The classic DNS-rebinding payload: a public address to pass a naive guard,
    // plus a private one the dial might otherwise land on. Validating *all*
    // returned addresses means we reject rather than gamble.
    const resolver: HostResolver = async () => ['93.184.216.34', '169.254.169.254'];
    const { dialer, dialledAddresses } = recordingDialer(() => ({}));

    await expect(
      guardedFetch('https://evil.example/.well-known/did.json', {
        ...baseOpts,
        resolver,
        dialer,
      }),
    ).rejects.toMatchObject({ code: 'blocked-address' });

    // And crucially: we never dialled anything.
    expect(dialledAddresses).toEqual([]);
  });

  it('REGRESSION: the address the dialer receives is the one that was validated, not a re-resolution', async () => {
    // Model the time-of-check/time-of-use gap directly: the resolver would hand
    // back a *different* address on a hypothetical second call. Because
    // guardedFetch resolves once and pins, the dialer must receive the address
    // from the single validated lookup - never a second, unvalidated one.
    const addresses = [['93.184.216.34'], ['10.0.0.5']];
    let call = 0;
    const resolver: HostResolver = async () => addresses[call++] ?? ['10.0.0.5'];

    const seenByDial: string[] = [];
    const dialer: Dialer = async (parsed, pinnedAddress) => {
      seenByDial.push(pinnedAddress);
      return {
        status: 200,
        headers: new Map(),
        body: new Uint8Array(),
        url: parsed.toString(),
        peerAddress: pinnedAddress,
      };
    };

    await guardedFetch('https://example.com/x', { ...baseOpts, resolver, dialer });

    // Resolved once, and the dial got the *validated* public IP, not the private
    // second-call address. A per-fetch re-resolution (the bug) would surface
    // 10.0.0.5 here.
    expect(call).toBe(1);
    expect(seenByDial).toEqual(['93.184.216.34']);
  });

  it('blocks a purely loopback resolution', async () => {
    const resolver: HostResolver = async () => ['127.0.0.1'];
    const { dialer } = recordingDialer(() => ({}));
    await expect(
      guardedFetch('https://x.example/y', { ...baseOpts, resolver, dialer }),
    ).rejects.toMatchObject({ code: 'blocked-address' });
  });

  it('exempts an allowHosts host from the block check but still pins its address', async () => {
    const resolver: HostResolver = async () => ['127.0.0.1'];
    const { dialer, dialledAddresses } = recordingDialer(() => ({}));
    await guardedFetch('https://localhost/z', {
      ...baseOpts,
      resolver,
      dialer,
      allowHosts: new Set(['localhost']),
    });
    expect(dialledAddresses).toEqual(['127.0.0.1']);
  });
});

describe('guardedFetch transport policy', () => {
  it('refuses non-HTTPS', async () => {
    await expect(
      guardedFetch('http://example.com/', { ...baseOpts, resolver: async () => ['8.8.8.8'] }),
    ).rejects.toMatchObject({ code: 'https-only' });
  });

  it('a POST body + headers are passed to the pinned dialer (WebSub distribution)', async () => {
    let seenMethod: string | undefined;
    let seenBody: Uint8Array | undefined;
    let seenHeaders: Record<string, string> | undefined;
    const dialer: Dialer = async (parsed, addr, opts) => {
      seenMethod = opts.method;
      seenBody = opts.body;
      seenHeaders = opts.headers;
      return { status: 200, headers: new Map(), body: new Uint8Array(), url: parsed.toString(), peerAddress: addr };
    };
    const body = new TextEncoder().encode('{"x":1}');
    await guardedFetch('https://sub.example/cb', {
      ...baseOpts,
      method: 'POST',
      body,
      headers: { 'X-Hub-Signature': 'sha256=abc' },
      resolver: async () => ['203.0.113.9'],
      dialer,
    });
    expect(seenMethod).toBe('POST');
    expect(seenBody).toEqual(body);
    expect(seenHeaders?.['X-Hub-Signature']).toBe('sha256=abc');
  });

  it('a POST to a private-resolving callback is still SSRF-blocked', async () => {
    await expect(
      guardedFetch('https://sub.example/cb', {
        ...baseOpts,
        method: 'POST',
        body: new Uint8Array([1]),
        resolver: async () => ['10.0.0.9'],
      }),
    ).rejects.toMatchObject({ code: 'blocked-address' });
  });

  it('follows a same-host redirect, re-resolving and re-pinning each hop', async () => {
    const resolver: HostResolver = async () => ['93.184.216.34'];
    let call = 0;
    const dialer: Dialer = async (parsed, addr) => {
      call++;
      if (call === 1) {
        return {
          status: 301,
          headers: new Map([['location', 'https://example.com/v2']]),
          body: new Uint8Array(),
          url: parsed.toString(),
          peerAddress: addr,
        };
      }
      return {
        status: 200,
        headers: new Map(),
        body: new TextEncoder().encode('ok'),
        url: parsed.toString(),
        peerAddress: addr,
      };
    };
    const res = await guardedFetch('https://example.com/v1', { ...baseOpts, resolver, dialer });
    expect(res.status).toBe(200);
    expect(call).toBe(2);
  });

  it('refuses a cross-host redirect', async () => {
    const resolver: HostResolver = async () => ['93.184.216.34'];
    const dialer: Dialer = async (parsed, addr) => ({
      status: 302,
      headers: new Map([['location', 'https://evil.example/']]),
      body: new Uint8Array(),
      url: parsed.toString(),
      peerAddress: addr,
    });
    await expect(
      guardedFetch('https://example.com/', { ...baseOpts, resolver, dialer }),
    ).rejects.toMatchObject({ code: 'cross-host-redirect' });
  });

  it('surfaces a DNS failure', async () => {
    const resolver: HostResolver = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(
      guardedFetch('https://nope.example/', { ...baseOpts, resolver }),
    ).rejects.toMatchObject({ code: 'dns-failure' });
  });

  it('errors on empty resolution', async () => {
    const resolver: HostResolver = async () => [];
    await expect(
      guardedFetch('https://nope.example/', { ...baseOpts, resolver }),
    ).rejects.toBeInstanceOf(GuardedFetchError);
  });

  it('stops after maxRedirects same-host hops', async () => {
    const resolver: HostResolver = async () => ['93.184.216.34'];
    let n = 0;
    const dialer: Dialer = async (parsed, addr) => ({
      status: 301,
      headers: new Map([['location', `https://example.com/${n++}`]]),
      body: new Uint8Array(),
      url: parsed.toString(),
      peerAddress: addr,
    });
    await expect(
      guardedFetch('https://example.com/start', { ...baseOpts, maxRedirects: 2, resolver, dialer }),
    ).rejects.toMatchObject({ code: 'too-many-redirects' });
  });
});
