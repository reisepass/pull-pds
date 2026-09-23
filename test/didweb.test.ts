import { describe, it, expect } from 'vitest';
import {
  parseDidWeb,
  isBlockedAddress,
  validateDidDocument,
  resolveDidWeb,
  DidWebError,
  type ResolverDeps,
  type GuardedTransport,
} from '../src/identity/didweb.js';
import { GuardedFetchError, type GuardedResponse } from '../src/net/guarded-fetch.js';
import type { ResolverConfig } from '../src/config.js';
import { makeDidDoc, newKeypair, TEST_ENDPOINT } from './helpers.js';

const config: ResolverConfig = {
  serviceEndpoint: TEST_ENDPOINT,
  fetchTimeoutMs: 1000,
  maxDocumentBytes: 64 * 1024,
  allowLocalhost: false,
};

const localhostConfig: ResolverConfig = { ...config, allowLocalhost: true };

/**
 * Build resolver deps whose transport short-circuits the network and returns a
 * canned response. Address validation is exercised separately (isBlockedAddress
 * unit tests + the real-guardedFetch rebinding test below); this fake covers the
 * resolver's own logic (validate doc, map status/JSON errors).
 */
function depsReturning(
  doc: unknown,
  opts: { status?: number; headers?: Record<string, string> } = {},
): ResolverDeps {
  const transport: GuardedTransport = async (url) => {
    const body = typeof doc === 'string' ? doc : JSON.stringify(doc);
    const headers = new Map<string, string>();
    for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k.toLowerCase(), v);
    return {
      status: opts.status ?? 200,
      headers,
      body: new TextEncoder().encode(body),
      url,
      peerAddress: '93.184.216.34',
    } satisfies GuardedResponse;
  };
  return { resolver: async () => ['93.184.216.34'], transport };
}

describe('parseDidWeb', () => {
  it('maps a hostname-only did:web to its did.json URL', () => {
    const parsed = parseDidWeb('did:web:example.com', config);
    expect(parsed.host).toBe('example.com');
    expect(parsed.url).toBe('https://example.com/.well-known/did.json');
  });

  it('rejects path components', () => {
    expect(() => parseDidWeb('did:web:example.com:foo', config)).toThrowError(
      /path components/i,
    );
    try {
      parseDidWeb('did:web:example.com:foo', config);
    } catch (e) {
      expect((e as DidWebError).code).toBe('path-components');
    }
  });

  it('rejects a non did:web string', () => {
    expect(() => parseDidWeb('did:plc:abc', config)).toThrowError(/not a did:web/i);
  });

  it('rejects a port by default', () => {
    try {
      parseDidWeb('did:web:example.com%3A8443', config);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as DidWebError).code).toBe('port-not-allowed');
    }
  });

  it('allows a localhost port only when the escape hatch is on', () => {
    const parsed = parseDidWeb('did:web:localhost%3A3000', localhostConfig);
    expect(parsed.host).toBe('localhost');
    expect(parsed.url).toBe('https://localhost:3000/.well-known/did.json');
    // Non-localhost host with a port is still rejected even in localhost mode.
    try {
      parseDidWeb('did:web:evil.com%3A3000', localhostConfig);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as DidWebError).code).toBe('port-not-allowed');
    }
  });

  it('rejects an empty host', () => {
    try {
      parseDidWeb('did:web:', config);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as DidWebError).code).toBe('empty-host');
    }
  });
});

describe('isBlockedAddress', () => {
  it('blocks loopback, private, link-local, CGNAT (v4)', () => {
    for (const ip of [
      '127.0.0.1',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.1.1',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '240.0.0.1',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows public v4 addresses', () => {
    for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1']) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it('blocks loopback, ULA, link-local, mapped-private (v6)', () => {
    for (const ip of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:192.168.0.1',
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it('allows public v6 and mapped-public', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  it('blocks anything that is not a parseable IP', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });
});

describe('validateDidDocument', () => {
  const did = 'did:web:example.com';

  it('accepts a well-formed document and extracts the atproto key', async () => {
    const kp = await newKeypair();
    const doc = await makeDidDoc(did, kp);
    const out = validateDidDocument(did, doc, config);
    expect(out.pdsEndpoint).toBe(TEST_ENDPOINT);
    expect(out.atprotoKey.didKey).toBe(kp.did());
    expect(out.atprotoKey.jwtAlg).toBe('ES256K');
    expect(out.alsoKnownAs[0]).toMatch(/^at:\/\//);
  });

  it('rejects a document id that mismatches the DID', async () => {
    const kp = await newKeypair();
    const doc = await makeDidDoc(did, kp, { overrides: { id: 'did:web:evil.com' } });
    expect(() => validateDidDocument(did, doc, config)).toThrowError(/does not match/i);
  });

  it('rejects a missing document id (F-7)', async () => {
    const kp = await newKeypair();
    const doc = await makeDidDoc(did, kp, { overrides: { id: undefined } });
    expect(() => validateDidDocument(did, doc, config)).toThrowError(/missing or not a string/i);
  });

  it.each([123, ['did:web:example.com'], { v: 1 }, null])(
    'rejects a non-string document id (%j) - F-7',
    async (badId) => {
      const kp = await newKeypair();
      const doc = await makeDidDoc(did, kp, { overrides: { id: badId as unknown as string } });
      expect(() => validateDidDocument(did, doc, config)).toThrowError(/missing or not a string/i);
    },
  );

  it('rejects a missing at:// alsoKnownAs', async () => {
    const kp = await newKeypair();
    const doc = await makeDidDoc(did, kp, { overrides: { alsoKnownAs: ['https://x'] } });
    expect(() => validateDidDocument(did, doc, config)).toThrowError(/alsoKnownAs/i);
  });

  it('rejects when #atproto method is not Multikey', async () => {
    const kp = await newKeypair();
    const doc = await makeDidDoc(did, kp);
    (doc.verificationMethod as Array<{ type: string }>)[0]!.type = 'JsonWebKey2020';
    expect(() => validateDidDocument(did, doc, config)).toThrowError(/#atproto/i);
  });

  it('rejects when there is no #atproto_pds service', async () => {
    const kp = await newKeypair();
    const doc = await makeDidDoc(did, kp);
    (doc.service as Array<{ id: string }>)[0]!.id = `${did}#other`;
    expect(() => validateDidDocument(did, doc, config)).toThrowError(
      /atproto_pds/i,
    );
  });

  it('rejects a service endpoint that is not ours', async () => {
    const kp = await newKeypair();
    const doc = await makeDidDoc(did, kp, { endpoint: 'https://someone-else.example' });
    try {
      validateDidDocument(did, doc, config);
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as DidWebError).code).toBe('wrong-service-endpoint');
    }
  });

  it('accepts an endpoint that differs only by a trailing slash', async () => {
    const kp = await newKeypair();
    const doc = await makeDidDoc(did, kp, { endpoint: `${TEST_ENDPOINT}/` });
    expect(() => validateDidDocument(did, doc, config)).not.toThrow();
  });

  it('rejects a non-Multikey publicKeyMultibase value', async () => {
    const kp = await newKeypair();
    const doc = await makeDidDoc(did, kp);
    (doc.verificationMethod as Array<{ publicKeyMultibase: string }>)[0]!.publicKeyMultibase =
      'znotarealkey';
    expect(() => validateDidDocument(did, doc, config)).toThrowError(/Multikey/i);
  });
});

describe('resolveDidWeb (with injected deps)', () => {
  const did = 'did:web:example.com';

  it('resolves and validates a good identity end to end', async () => {
    const kp = await newKeypair();
    const doc = await makeDidDoc(did, kp);
    const resolved = await resolveDidWeb(did, config, depsReturning(doc));
    expect(resolved.did).toBe(did);
    expect(resolved.host).toBe('example.com');
    expect(resolved.atprotoKey.didKey).toBe(kp.did());
  });

  it('passes the resolver through to the guarded transport (single lookup)', async () => {
    // The resolver deps carry the DNS resolver into guardedFetch; the resolver
    // must be handed to the transport, not shadowed. This asserts the wiring
    // that the DNS-rebinding fix depends on (guarded-fetch.test.ts proves the
    // pin itself).
    const kp = await newKeypair();
    const doc = await makeDidDoc(did, kp);
    let sawResolver = false;
    const resolver = async () => {
      sawResolver = true;
      return ['93.184.216.34'];
    };
    const transport: GuardedTransport = async (url, opts) => {
      // The resolver we injected must be the one the resolver core forwards.
      await opts.resolver?.('example.com');
      return {
        status: 200,
        headers: new Map(),
        body: new TextEncoder().encode(JSON.stringify(doc)),
        url,
        peerAddress: '93.184.216.34',
      };
    };
    const resolved = await resolveDidWeb(did, config, { resolver, transport });
    expect(sawResolver).toBe(true);
    expect(resolved.atprotoKey.didKey).toBe(kp.did());
  });

  it('maps a transport blocked-address error onto the resolver error code', async () => {
    const transport: GuardedTransport = async () => {
      throw new GuardedFetchError('blocked-address', 'resolves to a blocked address');
    };
    await expect(
      resolveDidWeb(did, config, { resolver: async () => ['10.0.0.1'], transport }),
    ).rejects.toMatchObject({ code: 'blocked-address' });
  });

  it('maps a transport response-too-large error through', async () => {
    const transport: GuardedTransport = async () => {
      throw new GuardedFetchError('response-too-large', 'too big');
    };
    await expect(
      resolveDidWeb(did, config, { resolver: async () => ['93.184.216.34'], transport }),
    ).rejects.toMatchObject({ code: 'response-too-large' });
  });

  it('rejects invalid JSON', async () => {
    const deps = depsReturning('{ not json', {});
    await expect(resolveDidWeb(did, config, deps)).rejects.toMatchObject({
      code: 'invalid-json',
    });
  });

  it('rejects a non-200 status', async () => {
    const deps = depsReturning('{}', { status: 404 });
    await expect(resolveDidWeb(did, config, deps)).rejects.toMatchObject({
      code: 'http-status',
    });
  });

  it('passes an allowHosts exemption for localhost in test mode', async () => {
    const kp = await newKeypair();
    const ldid = 'did:web:localhost';
    const doc = await makeDidDoc(ldid, kp);
    let sawAllowHosts: Set<string> | undefined;
    const transport: GuardedTransport = async (url, opts) => {
      sawAllowHosts = opts.allowHosts;
      return {
        status: 200,
        headers: new Map(),
        body: new TextEncoder().encode(JSON.stringify(doc)),
        url,
        peerAddress: '127.0.0.1',
      };
    };
    const resolved = await resolveDidWeb(ldid, localhostConfig, {
      resolver: async () => ['127.0.0.1'],
      transport,
    });
    expect(resolved.host).toBe('localhost');
    expect(sawAllowHosts?.has('localhost')).toBe(true);
  });
});
