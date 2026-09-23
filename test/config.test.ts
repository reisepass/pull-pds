import { describe, it, expect } from 'vitest';
import {
  selfEndpointFromEnv,
  resolverConfigFromEnv,
  PLACEHOLDER_SELF_ENDPOINT,
} from '../src/config.js';
import { pdsConfigFromEnv } from '../src/pds-websub/config.js';
import { loadSharedPdsKey } from '../src/repo/signing-key.js';

describe('selfEndpointFromEnv', () => {
  it('defaults to a never-resolving placeholder when SELF_ENDPOINT is unset', () => {
    expect(selfEndpointFromEnv({})).toBe(PLACEHOLDER_SELF_ENDPOINT);
    expect(PLACEHOLDER_SELF_ENDPOINT).toBe('https://pds.example.invalid');
  });

  it('defaults to the placeholder when SELF_ENDPOINT is blank', () => {
    expect(selfEndpointFromEnv({ SELF_ENDPOINT: '   ' })).toBe(PLACEHOLDER_SELF_ENDPOINT);
  });

  it('reads SELF_ENDPOINT from the environment when set', () => {
    expect(selfEndpointFromEnv({ SELF_ENDPOINT: 'https://pds-b.example.com' })).toBe(
      'https://pds-b.example.com',
    );
  });
});

describe('resolverConfigFromEnv', () => {
  it('wires the env endpoint into the resolver config', () => {
    const cfg = resolverConfigFromEnv({}, { SELF_ENDPOINT: 'https://pds.example.com' });
    expect(cfg.serviceEndpoint).toBe('https://pds.example.com');
    expect(cfg.allowLocalhost).toBe(false);
  });

  it('falls back to the placeholder with an empty env', () => {
    const cfg = resolverConfigFromEnv({}, {});
    expect(cfg.serviceEndpoint).toBe(PLACEHOLDER_SELF_ENDPOINT);
  });

  it('honours overrides over both env and defaults', () => {
    const cfg = resolverConfigFromEnv(
      { serviceEndpoint: 'https://override.example', allowLocalhost: true },
      { SELF_ENDPOINT: 'https://pds.example.com' },
    );
    expect(cfg.serviceEndpoint).toBe('https://override.example');
    expect(cfg.allowLocalhost).toBe(true);
  });
});

describe('env back-compat aliases', () => {
  // A fixed 32-byte hex secp256k1 private key so both env-name paths derive the
  // SAME identity - proving the legacy alias is a true alias, not a new key.
  const KEYHEX = '0'.repeat(63) + '1';

  it('PDS_DID is canonical; AGG_DID is still honoured as a deprecated alias', () => {
    const canonical = pdsConfigFromEnv({}, { PDS_DID: 'did:web:canon.example' } as NodeJS.ProcessEnv);
    expect(canonical.pdsDid).toBe('did:web:canon.example');

    const legacy = pdsConfigFromEnv({}, { AGG_DID: 'did:web:legacy.example' } as NodeJS.ProcessEnv);
    expect(legacy.pdsDid).toBe('did:web:legacy.example');

    // Canonical wins when both are set.
    const both = pdsConfigFromEnv(
      {},
      { PDS_DID: 'did:web:canon.example', AGG_DID: 'did:web:legacy.example' } as NodeJS.ProcessEnv,
    );
    expect(both.pdsDid).toBe('did:web:canon.example');
  });

  it('PDS_SIGNING_KEY and the legacy AGG_SIGNING_KEY load the identical key', async () => {
    const viaNew = await loadSharedPdsKey({ PDS_SIGNING_KEY: KEYHEX } as NodeJS.ProcessEnv);
    const viaOld = await loadSharedPdsKey({ AGG_SIGNING_KEY: KEYHEX } as NodeJS.ProcessEnv);
    expect(viaOld.didKey).toBe(viaNew.didKey);
    expect(viaOld.publicKeyMultibase).toBe(viaNew.publicKeyMultibase);

    // Canonical wins when both are present.
    const both = await loadSharedPdsKey(
      { PDS_SIGNING_KEY: KEYHEX, AGG_SIGNING_KEY: '0'.repeat(64) } as NodeJS.ProcessEnv,
    );
    expect(both.didKey).toBe(viaNew.didKey);
  });
});

describe('Bluesky social namespaces are never accepted', () => {
  it.each(['app.bsky.feed.post', 'app.bsky.feed.like', 'app.bsky.graph.follow', 'chat.bsky.convo.message', 'com.atproto.repo.strongRef'])(
    'ALLOWED_COLLECTIONS containing %s fails configuration',
    (nsid) => {
      expect(() => pdsConfigFromEnv({}, { ALLOWED_COLLECTIONS: `com.example.sensor.reading,${nsid}` })).toThrow(/may not include/);
    },
  );

  it('an override cannot smuggle a blocked collection past validation', () => {
    expect(() => pdsConfigFromEnv({ allowedCollections: ['app.bsky.feed.post'] }, {})).toThrow(/may not include/);
  });

  it('look-alike namespaces outside the blocked prefixes are allowed', () => {
    expect(pdsConfigFromEnv({}, { ALLOWED_COLLECTIONS: 'app.bskyish.data.item' }).allowedCollections).toEqual(['app.bskyish.data.item']);
  });
});
