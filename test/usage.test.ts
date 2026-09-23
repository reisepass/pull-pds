import { describe, it, expect } from 'vitest';
import { IndexStore } from '../src/appview/index-store.js';
import { usageRows, rankUsage } from '../src/appview/server.js';
import { USAGE_METRICS_NSID } from '../src/collections.js';

function usageRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $type: USAGE_METRICS_NSID,
    serviceType: 'llm',
    'gen_ai.provider.name': 'openai',
    'gen_ai.request.model': 'gpt-4o',
    windowStartUnixMicro: 1785000000000000,
    windowEndUnixMicro: 1785000300000000,
    operationCount: 100,
    'gen_ai.usage.input_tokens': 50000,
    'gen_ai.usage.output_tokens': 20000,
    latencyMsP50: 300,
    latencyMsP90: 900,
    latencyMsP99: 2500,
    'telemetry.distro.name': 'omniroute',
    observedAt: '2026-07-21T00:00:00.000Z',
    ...over,
  };
}

function put(
  store: IndexStore,
  did: string,
  rkey: string,
  record: Record<string, unknown>,
  sigVerified = true,
): void {
  store.putRecord({
    did,
    collection: USAGE_METRICS_NSID,
    rkey,
    cid: `cid-${did}-${rkey}`,
    recordJson: JSON.stringify(record),
    rev: 'r1',
    sourcePds: 'https://pds.example',
    sigVerified,
    indexedAt: '2026-07-21T00:00:00.000Z',
  });
}

describe('usageRows', () => {
  it('reads OTel usage fields off the record', () => {
    const store = new IndexStore(':memory:');
    put(store, 'did:web:a.example', 'usage-openai', usageRecord());
    const rows = usageRows(store);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o',
      operationCount: 100,
      inputTokens: 50000,
      outputTokens: 20000,
      latencyMsP50: 300,
      emitter: 'omniroute',
    });
  });

  it('filters to a chosen publisher subset', () => {
    const store = new IndexStore(':memory:');
    put(store, 'did:web:a.example', 'usage-openai', usageRecord());
    put(store, 'did:web:b.example', 'usage-openai', usageRecord());
    const only = new Set(['did:web:a.example']);
    const rows = usageRows(store, only);
    expect(rows.map((r) => r.did)).toEqual(['did:web:a.example']);
  });
});

describe('rankUsage - sybil defenses', () => {
  it('counts only signature-verified records and reports the skipped count', () => {
    const store = new IndexStore(':memory:');
    put(store, 'did:web:honest.example', 'usage-openai', usageRecord({ operationCount: 100 }), true);
    // A record whose signature did not verify must NOT be counted.
    put(store, 'did:web:forger.example', 'usage-openai', usageRecord({ operationCount: 999999 }), false);
    const ranking = rankUsage(store);
    expect(ranking.unverifiedSkipped).toBe(1);
    expect(ranking.rows).toHaveLength(1);
    expect(ranking.rows[0].operationCount).toBe(100); // forger's inflated count excluded
    expect(ranking.publishers).toEqual(['did:web:honest.example']);
  });

  it('always emits the counted publisher set', () => {
    const store = new IndexStore(':memory:');
    put(store, 'did:web:a.example', 'usage-openai', usageRecord());
    put(store, 'did:web:b.example', 'usage-openai', usageRecord());
    const ranking = rankUsage(store);
    expect(ranking.publishers).toEqual(['did:web:a.example', 'did:web:b.example']);
  });

  it('honors a publisher allowlist so a consumer picks whom to count', () => {
    const store = new IndexStore(':memory:');
    put(store, 'did:web:trusted.example', 'usage-openai', usageRecord({ operationCount: 10 }));
    put(store, 'did:web:spammer.example', 'usage-openai', usageRecord({ operationCount: 1e6 }));
    const ranking = rankUsage(store, new Set(['did:web:trusted.example']));
    expect(ranking.publishers).toEqual(['did:web:trusted.example']);
    expect(ranking.rows[0].operationCount).toBe(10);
  });

  it('flags single-source models (k-anonymity / lone-reporter caution)', () => {
    const store = new IndexStore(':memory:');
    put(store, 'did:web:a.example', 'usage-openai', usageRecord({ 'gen_ai.request.model': 'rare-model' }));
    const ranking = rankUsage(store);
    expect(ranking.rows[0].singleSource).toBe(true);
    expect(ranking.rows[0].publishers).toBe(1);
  });

  it('sums across multiple publishers of the same model and marks it multi-source', () => {
    const store = new IndexStore(':memory:');
    put(store, 'did:web:a.example', 'usage-openai', usageRecord({ operationCount: 100 }));
    put(store, 'did:web:b.example', 'usage-openai', usageRecord({ operationCount: 250 }));
    const ranking = rankUsage(store);
    expect(ranking.rows[0].operationCount).toBe(350);
    expect(ranking.rows[0].publishers).toBe(2);
    expect(ranking.rows[0].singleSource).toBe(false);
  });
});
