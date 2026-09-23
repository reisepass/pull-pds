import { describe, it, expect } from 'vitest';
import { IndexStore } from '../src/appview/index-store.js';
import {
  metricRows,
  aggregateByProvider,
  ispStability,
  liveIncidents,
  bucketMidpoint,
  ERRORMETRICS_COLLECTION,
} from '../src/appview/peertelemetry.js';
import { buildRecordValidator } from '../src/pds-websub/lexicon-validate.js';

const COLL = ERRORMETRICS_COLLECTION;

function put(store: IndexStore, did: string, rkey: string, record: Record<string, unknown>, sigVerified = true) {
  store.putRecord({
    did,
    collection: COLL,
    rkey,
    cid: `bafyrei-${did}-${rkey}`,
    recordJson: JSON.stringify(record),
    rev: `rev-${rkey}`,
    sourcePds: 'p4.0rs.org',
    sigVerified,
    indexedAt: '2026-07-27T12:00:00.000Z',
  });
}

const nowUs = Date.parse('2026-07-27T12:00:00Z') * 1000;

function isp(provider: string, codes: Array<{ code: string; count: number }>, over: Record<string, unknown> = {}) {
  const total = codes.reduce((a, c) => a + c.count, 0);
  return {
    $type: COLL,
    serviceType: 'isp',
    'gen_ai.provider.name': provider,
    windowStartUnixMicro: nowUs,
    windowEndUnixMicro: nowUs + 300000000,
    errors: codes,
    totalErrors: total,
    requestVolumeBucket: '100-999',
    'telemetry.distro.name': 'netreport-sim',
    'telemetry.distro.version': '2',
    observedAt: '2026-07-27T12:00:00.000Z',
    emittedAt: '2026-07-27T12:00:00.100Z',
    seq: 1,
    ...over,
  };
}

function llm(provider: string, codes: Array<{ code: string; count: number }>, over: Record<string, unknown> = {}) {
  const total = codes.reduce((a, c) => a + c.count, 0);
  return {
    $type: COLL,
    serviceType: 'llm',
    'gen_ai.provider.name': provider,
    'gen_ai.request.model': 'gpt-4o',
    windowStartUnixMicro: nowUs,
    windowEndUnixMicro: nowUs + 300000000,
    errors: codes,
    totalErrors: total,
    requestVolumeBucket: '1K-9.9K',
    'telemetry.distro.name': 'omniroute',
    observedAt: '2026-07-27T12:00:00.000Z',
    emittedAt: '2026-07-27T12:00:00.100Z',
    seq: 1,
    ...over,
  };
}

describe('peertelemetry cross-serviceType aggregation', () => {
  it('aggregates llm and isp in one view, filterable by serviceType', () => {
    const store = new IndexStore(':memory:');
    put(store, 'did:web:a.example.com', 'anthropic', llm('anthropic', [{ code: '429', count: 12 }]));
    put(store, 'did:web:b.example.com', 'fiber.de-by', isp('telekom', [{ code: 'packet_loss_high', count: 8 }]));

    const all = aggregateByProvider(store);
    expect(all).toHaveLength(2);
    expect(all.map((a) => a.serviceType).sort()).toEqual(['isp', 'llm']);

    const onlyIsp = aggregateByProvider(store, 'isp');
    expect(onlyIsp).toHaveLength(1);
    expect(onlyIsp[0]!.provider).toBe('telekom');

    const onlyLlm = aggregateByProvider(store, 'llm');
    expect(onlyLlm).toHaveLength(1);
    expect(onlyLlm[0]!.provider).toBe('anthropic');
  });

  it('preserves an unknown serviceType (open vocabulary)', () => {
    const store = new IndexStore(':memory:');
    put(store, 'did:web:c.example.com', 'x', isp('acme', [{ code: 'timeout', count: 1 }], { serviceType: 'cdn' }));
    const cdn = aggregateByProvider(store, 'cdn');
    expect(cdn).toHaveLength(1);
    expect(cdn[0]!.serviceType).toBe('cdn');
  });
});

describe('peertelemetry ISP stability (buying decision)', () => {
  it('ranks by error rate, folds households, recovers regions from rkey', () => {
    const store = new IndexStore(':memory:');
    // telekom: low errors across two households -> stable.
    put(store, 'did:web:h1.example.com', 'fiber.de-by', isp('telekom', [{ code: 'packet_loss_high', count: 2 }]));
    put(store, 'did:web:h2.example.com', 'cable.de-nw', isp('telekom', [{ code: 'packet_loss_high', count: 3 }]));
    // o2: link_down + heavy loss -> unstable.
    put(store, 'did:web:h3.example.com', 'dsl.de-be', isp('o2', [{ code: 'link_down', count: 5 }, { code: 'packet_loss_high', count: 40 }]));

    const table = ispStability(store);
    expect(table).toHaveLength(2);
    expect(table[0]!.provider).toBe('telekom'); // lower error rate ranks first
    expect(table[0]!.households).toBe(2);
    expect(table[0]!.regions).toEqual(['de-by', 'de-nw']);
    expect(table[1]!.provider).toBe('o2');
    expect(table[1]!.linkDownReports).toBe(1);
  });
});

describe('peertelemetry "is it just me" (live incident)', () => {
  it('one household = just you, two in same region = correlated', () => {
    const store = new IndexStore(':memory:');
    const recent = { emittedAt: new Date().toISOString() };
    // Two o2 households in de-by both link_down now.
    put(store, 'did:web:a.example.com', 'cable.de-by', isp('o2', [{ code: 'link_down', count: 3 }], recent));
    put(store, 'did:web:b.example.com', 'dsl.de-by', isp('o2', [{ code: 'link_down', count: 2 }], recent));
    // One telekom household in de-nw down.
    put(store, 'did:web:c.example.com', 'fiber.de-nw', isp('telekom', [{ code: 'link_down', count: 1 }], recent));

    const incidents = liveIncidents(store);
    const o2 = incidents.find((i) => i.provider === 'o2' && i.region === 'de-by')!;
    expect(o2.affectedHouseholds).toBe(2);
    expect(o2.correlated).toBe(true);
    expect(o2.dids).toEqual(['did:web:a.example.com', 'did:web:b.example.com']);

    const tk = incidents.find((i) => i.provider === 'telekom')!;
    expect(tk.affectedHouseholds).toBe(1);
    expect(tk.correlated).toBe(false);
  });

  it('excludes stale reports outside the recent window', () => {
    const store = new IndexStore(':memory:');
    // Emitted 2 hours ago -> excluded.
    put(store, 'did:web:a.example.com', 'cable.de-by', isp('o2', [{ code: 'link_down', count: 3 }], { emittedAt: '2026-07-27T10:00:00.000Z' }));
    const incidents = liveIncidents(store, Date.parse('2026-07-27T12:00:00Z'));
    expect(incidents).toHaveLength(0);
  });
});

describe('peertelemetry provenance + helpers', () => {
  it('metricRows carries did, cid, rev, sourcePds, sigVerified', () => {
    const store = new IndexStore(':memory:');
    put(store, 'did:web:h1.example.com', 'fiber.de-by', isp('telekom', [{ code: 'packet_loss_high', count: 2 }]), false);
    const rows = metricRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      did: 'did:web:h1.example.com',
      cid: 'bafyrei-did:web:h1.example.com-fiber.de-by',
      rev: 'rev-fiber.de-by',
      sourcePds: 'p4.0rs.org',
      sigVerified: false,
      access: 'fiber',
      region: 'de-by',
    });
  });

  it('bucketMidpoint gives a usable denominator', () => {
    expect(bucketMidpoint('100-999')).toBe(500);
    expect(bucketMidpoint('0')).toBe(0);
    expect(bucketMidpoint('nonsense')).toBe(0);
  });
});

describe('unified schema validation (privacy + classification survive the merge)', () => {
  const validate = buildRecordValidator();

  it('accepts a well-formed isp and llm record', () => {
    expect(validate(COLL, isp('telekom', [{ code: 'link_down', count: 1 }]))).toBeNull();
    expect(validate(COLL, llm('anthropic', [{ code: '429', count: 3 }]))).toBeNull();
  });

  it('rejects a raw-IP / region leak as an undeclared field (privacy)', () => {
    expect(validate(COLL, { ...isp('telekom', [{ code: 'link_down', count: 1 }]), homeIp: '84.1.2.3' })).toMatch(/unknown field "homeIp"/);
    // A throughput field is exactly the thing the schema cannot express: rejected.
    expect(validate(COLL, { ...isp('telekom', [{ code: 'link_down', count: 1 }]), downKbps: 94000 })).toMatch(/unknown field "downKbps"/);
  });

  it('rejects a missing required field', () => {
    const bad = isp('telekom', [{ code: 'link_down', count: 1 }]);
    delete (bad as Record<string, unknown>).totalErrors;
    expect(validate(COLL, bad)).toMatch(/totalErrors/);
  });

  it('accepts a record carrying the exact denominator instead of the bucket', () => {
    // requestVolumeBucket stopped being required when requestCount superseded it.
    // A publisher may now emit the exact count alone - but the pre-requestCount
    // records already signed under the old schema still have to validate, which
    // is why the bucket was made optional rather than removed.
    const exact = { ...isp('telekom', [{ code: 'link_down', count: 1 }]), requestCount: 4321 };
    delete (exact as Record<string, unknown>).requestVolumeBucket;
    expect(validate(COLL, exact)).toBeNull();

    const legacy = isp('telekom', [{ code: 'link_down', count: 1 }]);
    delete (legacy as Record<string, unknown>).requestCount;
    expect(validate(COLL, legacy)).toBeNull();
  });

  it('rejects a negative request count', () => {
    const bad = { ...isp('telekom', [{ code: 'link_down', count: 1 }]), requestCount: -1 };
    expect(validate(COLL, bad)).toMatch(/requestCount/);
  });
});
