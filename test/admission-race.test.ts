import { describe, it, expect } from 'vitest';
import { MetaStore } from '../src/pds-websub/meta-store.js';
import { admitWrite } from '../src/policy/admission.js';
import { DEFAULT_ADMISSION_CONFIG } from '../src/config.js';

/**
 * TOCTOU on the per-registrable-domain DID cap. The admission check reads
 * `didsForRegistrableDomain` and the binding is recorded (`add`) only after the
 * commit. Two *different* new DIDs on the same domain, admitted concurrently
 * (interleaved check-then-add), can both pass a cap of N and push the domain to
 * N+1. The cap is a spam dial, not a security boundary (DESIGN.md), but it should
 * still hold; this test pins the reserve-based fix.
 */

const COLL = 'app.omniroute.errorReport';
const clock = { now: () => 1_000_000 };
const config = { ...DEFAULT_ADMISSION_CONFIG, collectionAllowlist: [COLL], maxDidsPerRegistrableDomain: 1 };

function admit(meta: MetaStore, did: string, host: string) {
  return admitWrite({ did, host, collection: COLL }, config, meta, clock);
}

describe('per-domain DID cap under interleaved first-ingest', () => {
  it('simulated interleave: check both, then add both, must not exceed the cap', () => {
    const meta = new MetaStore();
    const hostA = 'a.example.com';
    const hostB = 'b.example.com'; // same registrable domain example.com

    // Interleave: both DIDs pass the read-only admit check first...
    const decA = admit(meta, 'did:web:a.example.com', hostA);
    const decB = admit(meta, 'did:web:b.example.com', hostB);
    // ...then both try to reserve/record. The reserve must be the enforcement
    // point: exactly one succeeds when the cap is 1.
    const reservedA = meta.reserveNewDid('did:web:a.example.com', 'example.com', config.maxDidsPerRegistrableDomain);
    const reservedB = meta.reserveNewDid('did:web:b.example.com', 'example.com', config.maxDidsPerRegistrableDomain);

    // Both passed the optimistic read check (that is the TOCTOU)...
    expect(decA.admit).toBe(true);
    expect(decB.admit).toBe(true);
    // ...but the atomic reserve enforces the cap: exactly one wins.
    expect([reservedA, reservedB].filter(Boolean).length).toBe(1);
    // The domain ends with exactly the cap, not cap+1.
    expect(meta.didsForRegistrableDomain('example.com').size).toBe(1);
  });

  it('reserveNewDid is idempotent for an already-reserved DID (retry safe)', () => {
    const meta = new MetaStore();
    expect(meta.reserveNewDid('did:web:a.example.com', 'example.com', 2)).toBe(true);
    // The same DID reserving again does not consume a second slot.
    expect(meta.reserveNewDid('did:web:a.example.com', 'example.com', 2)).toBe(true);
    expect(meta.didsForRegistrableDomain('example.com').size).toBe(1);
  });

  it('N distinct DIDs racing one domain cap: exactly `cap` are granted', () => {
    const meta = new MetaStore();
    const cap = 8;
    // 50 distinct new DIDs, all on example.com, all reserving. node:sqlite is
    // synchronous so these serialize, but the transaction is what guarantees the
    // count-and-insert is atomic even if it did not.
    const results = Array.from({ length: 50 }, (_, i) =>
      meta.reserveNewDid(`did:web:n${i}.example.com`, 'example.com', cap),
    );
    expect(results.filter(Boolean).length).toBe(cap);
    expect(meta.didsForRegistrableDomain('example.com').size).toBe(cap);
  });

  it('a subdomain flood cannot exceed the cap even interleaved with commits', () => {
    const meta = new MetaStore();
    const cap = 3;
    let granted = 0;
    for (let i = 0; i < 20; i++) {
      if (meta.reserveNewDid(`did:web:s${i}.acme.co.uk`, 'acme.co.uk', cap)) {
        granted++;
        meta.add(`did:web:s${i}.acme.co.uk`); // simulate the commit that follows
      }
    }
    expect(granted).toBe(cap);
    expect(meta.didsForRegistrableDomain('acme.co.uk').size).toBe(cap);
    // And the rate-limit event log did not double-count reserved+added DIDs.
    expect(meta.recentNewDidTimestamps('acme.co.uk').length).toBe(cap);
  });
});
