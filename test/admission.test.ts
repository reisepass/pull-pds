import { describe, it, expect } from 'vitest';
import {
  admitWrite,
  type AdmissionStore,
  type Clock,
} from '../src/policy/admission.js';
import type { AdmissionConfig } from '../src/config.js';

const config: AdmissionConfig = {
  collectionAllowlist: ['app.omniroute.errorReport'],
  maxDidsPerRegistrableDomain: 2,
  newDidRateLimit: { max: 2, windowMs: 1000 },
  globalNewDidRateLimit: { max: 3, windowMs: 1000 },
};

/** A mutable in-memory store for the tests. */
function makeStore(init: Partial<{
  known: Set<string>;
  denied: Set<string>;
  byDomain: Map<string, Set<string>>;
  domainTs: Map<string, number[]>;
  globalTs: number[];
}> = {}): AdmissionStore {
  const known = init.known ?? new Set<string>();
  const denied = init.denied ?? new Set<string>();
  const byDomain = init.byDomain ?? new Map<string, Set<string>>();
  const domainTs = init.domainTs ?? new Map<string, number[]>();
  const globalTs = init.globalTs ?? [];
  return {
    isKnownDid: (did) => known.has(did),
    isDenied: (did) => denied.has(did),
    didsForRegistrableDomain: (domain) => byDomain.get(domain) ?? new Set(),
    recentNewDidTimestamps: (domain) => domainTs.get(domain) ?? [],
    recentNewDidTimestampsGlobal: () => globalTs,
  };
}

function clockAt(t: number): Clock {
  return { now: () => t };
}

const req = {
  did: 'did:web:a.acme.com',
  host: 'a.acme.com',
  collection: 'app.omniroute.errorReport',
};

describe('admitWrite', () => {
  it('admits a new DID on a fresh domain', () => {
    const decision = admitWrite(req, config, makeStore(), clockAt(0));
    expect(decision.admit).toBe(true);
  });

  it('denies a denylisted DID (kill switch), before anything else', () => {
    const store = makeStore({ denied: new Set([req.did]) });
    const decision = admitWrite(req, config, store, clockAt(0));
    expect(decision).toMatchObject({ admit: false, reason: 'denied-did' });
  });

  it('denies a collection not on the allowlist', () => {
    const decision = admitWrite(
      { ...req, collection: 'app.bsky.feed.post' },
      config,
      makeStore(),
      clockAt(0),
    );
    expect(decision).toMatchObject({ admit: false, reason: 'collection-not-allowed' });
  });

  it('denies a host with no registrable domain', () => {
    const decision = admitWrite(
      { ...req, host: 'localhost' },
      config,
      makeStore(),
      clockAt(0),
    );
    expect(decision).toMatchObject({ admit: false, reason: 'no-registrable-domain' });
  });

  it('lets an already-known DID through without touching caps or limits', () => {
    // Domain is at cap and rate limit is saturated, but the DID is established.
    const store = makeStore({
      known: new Set([req.did]),
      byDomain: new Map([['acme.com', new Set(['x', 'y'])]]),
      domainTs: new Map([['acme.com', [0, 0, 0]]]),
      globalTs: [0, 0, 0, 0],
    });
    const decision = admitWrite(req, config, store, clockAt(0));
    expect(decision.admit).toBe(true);
  });

  it('enforces the per-domain distinct-DID cap for a new DID', () => {
    const store = makeStore({
      byDomain: new Map([['acme.com', new Set(['did:web:x.acme.com', 'did:web:y.acme.com'])]]),
    });
    const decision = admitWrite(req, config, store, clockAt(0));
    expect(decision).toMatchObject({ admit: false, reason: 'domain-cap-exceeded' });
  });

  it('shares the cap across subdomains of one registrable domain', () => {
    // a.acme.com and b.acme.com both collapse to acme.com.
    const store = makeStore({
      byDomain: new Map([['acme.com', new Set(['did:web:a.acme.com', 'did:web:b.acme.com'])]]),
    });
    const decision = admitWrite(
      { did: 'did:web:c.acme.com', host: 'c.acme.com', collection: req.collection },
      config,
      store,
      clockAt(0),
    );
    expect(decision).toMatchObject({ admit: false, reason: 'domain-cap-exceeded' });
  });

  it('enforces the per-domain new-DID rate limit within the window', () => {
    const store = makeStore({
      domainTs: new Map([['acme.com', [100, 200]]]), // 2 within window, max is 2
    });
    const decision = admitWrite(req, config, store, clockAt(500));
    expect(decision).toMatchObject({ admit: false, reason: 'domain-rate-limited' });
  });

  it('ignores rate-limit timestamps outside the sliding window', () => {
    const store = makeStore({
      domainTs: new Map([['acme.com', [1, 2]]]), // both older than now-windowMs
    });
    // now = 5000, window = 1000 -> cutoff 4000; both timestamps expired.
    const decision = admitWrite(req, config, store, clockAt(5000));
    expect(decision.admit).toBe(true);
  });

  it('enforces the global new-DID rate limit', () => {
    const store = makeStore({
      globalTs: [10, 20, 30], // 3 within window, global max is 3
    });
    const decision = admitWrite(req, config, store, clockAt(100));
    expect(decision).toMatchObject({ admit: false, reason: 'global-rate-limited' });
  });

  it('checks per-domain limit before the global one', () => {
    const store = makeStore({
      domainTs: new Map([['acme.com', [1, 2]]]),
      globalTs: [1, 2, 3],
    });
    const decision = admitWrite(req, config, store, clockAt(500));
    // Per-domain fires first.
    expect(decision).toMatchObject({ admit: false, reason: 'domain-rate-limited' });
  });
});
