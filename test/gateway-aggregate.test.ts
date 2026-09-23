import { describe, it, expect } from 'vitest';
import { aggregateObservations } from '../src/gateway/aggregate.js';
import { UNKNOWN_PROVIDER, type GatewayObservation } from '../src/gateway/types.js';
import { buildRecordValidator } from '../src/pds-websub/lexicon-validate.js';
import { ERROR_METRICS_NSID } from '../src/collections.js';

const validate = buildRecordValidator();

/** Inclusive bounds of an order-of-magnitude bucket, for cross-checking. */
function bucketRange(b: string): { low: number; high: number } {
  const table: Record<string, [number, number]> = {
    '0': [0, 0],
    '1-9': [1, 9],
    '10-99': [10, 99],
    '100-999': [100, 999],
    '1K-9.9K': [1_000, 9_999],
    '10K-99K': [10_000, 99_999],
    '100K-999K': [100_000, 999_999],
    '1M-9.9M': [1_000_000, 9_999_999],
    '10M+': [10_000_000, Number.MAX_SAFE_INTEGER],
  };
  const r = table[b];
  if (r === undefined) throw new Error(`unknown bucket ${b}`);
  return { low: r[0], high: r[1] };
}

const OPTS = {
  source: 'testgw',
  windowStartMs: 1_800_000_000_000,
  windowEndMs: 1_800_003_600_000,
  distroName: 'peertelemetry-gateway',
  distroVersion: '0.1.0',
};

const ok = (provider: string, count: number, model?: string): GatewayObservation => ({
  provider,
  providerAttribution: 'observed',
  ...(model === undefined ? {} : { model }),
  count,
});

const err = (
  provider: string,
  errorCode: string,
  count = 1,
  extra: Partial<GatewayObservation> = {},
): GatewayObservation => ({
  provider,
  providerAttribution: 'observed',
  errorCode,
  count,
  ...extra,
});

describe('aggregateObservations - record shape', () => {
  it('emits a record that passes the committed errorMetrics lexicon', () => {
    const { records } = aggregateObservations(
      [ok('openai', 400, 'gpt-4o'), err('openai', 'rate_limit_exceeded', 5, { model: 'gpt-4o' })],
      OPTS,
    );
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.collection).toBe(ERROR_METRICS_NSID);
    expect(r.rkey).toBe('openai_gpt-4o');
    expect(validate(r.collection, r.record)).toBeNull();
    expect(r.record['gen_ai.provider.name']).toBe('openai');
    expect(r.record['gen_ai.request.model']).toBe('gpt-4o');
    expect(r.record.errors).toEqual([{ code: 'rate_limit_exceeded', count: 5 }]);
    expect(r.record.totalErrors).toBe(5);
  });

  it('publishes the exact denominator alongside the legacy bucket', () => {
    const { records, stats } = aggregateObservations([ok('openai', 4321)], OPTS);
    // requestCount supersedes requestVolumeBucket: a consumer divides by a real
    // number rather than bounding a rate between two powers of ten. Publishing a
    // gateway's true call volume DOES disclose production scale - the deliberate
    // trade recorded in the lexicon description and USAGE-STATS-DESIGN.md.
    expect(records[0]!.record.requestCount).toBe(4321);
    // The bucket is still emitted so a consumer that only knows the old schema
    // keeps working; records signed before requestCount carry it alone.
    expect(records[0]!.record.requestVolumeBucket).toBe('1K-9.9K');
    expect(stats.totalCalls).toBe(4321);
  });

  it('keeps the denominator consistent between the exact count and the bucket', () => {
    // A bucket that disagrees with the count would let a consumer reading the
    // old field and one reading the new field compute different rates.
    for (const n of [0, 7, 88, 950, 4321, 55_000]) {
      const { records } = aggregateObservations([ok('openai', n)], OPTS);
      const rec = records[0]!.record;
      expect(rec.requestCount).toBe(n);
      const { low, high } = bucketRange(rec.requestVolumeBucket as string);
      expect(rec.requestCount).toBeGreaterThanOrEqual(low);
      expect(rec.requestCount).toBeLessThanOrEqual(high);
    }
  });

  it('normalises a gateway display name onto the canonical provider name', () => {
    const { records } = aggregateObservations([ok('Google AI Studio', 10)], OPTS);
    expect(records[0]!.record['gen_ai.provider.name']).toBe('gcp.gemini');
    expect(records[0]!.rkey).toBe('gcp.gemini');
  });

  it('folds one provider reported under two aliases into a single record', () => {
    const { records } = aggregateObservations([ok('Google', 5), ok('vertex_ai_beta', 7)], OPTS);
    expect(records).toHaveLength(1);
    expect(records[0]!.record['gen_ai.provider.name']).toBe('gcp.gemini');
  });
});

describe('aggregateObservations - scope filtering', () => {
  it('drops account-scoped codes from errors[] but counts them in totalErrorsAllScopes', () => {
    const { records, stats } = aggregateObservations(
      [
        ok('openai', 100),
        err('openai', 'rate_limit_exceeded', 3),
        err('openai', 'insufficient_quota', 9),
      ],
      OPTS,
    );
    const r = records[0]!.record;
    expect(r.errors).toEqual([{ code: 'rate_limit_exceeded', count: 3 }]);
    expect(r.totalErrors).toBe(3);
    expect(r.totalErrorsAllScopes).toBe(12);
    expect(JSON.stringify(r)).not.toContain('insufficient_quota');
    expect(stats.accountErrors).toBe(9);
  });

  it('keeps a MODEL-level failure out of errors[] entirely', () => {
    // The whole point of the gateway sources: a healthy provider that returned
    // an unusable generation must not read as provider downtime.
    const { records, stats } = aggregateObservations(
      [ok('gcp.gemini', 50), err('gcp.gemini', 'malformed_function_call', 24)],
      OPTS,
    );
    const r = records[0]!.record;
    expect(r.errors).toEqual([]);
    expect(r.totalErrors).toBe(0);
    expect(r.totalErrorsAllScopes).toBe(24);
    expect(stats.modelErrors).toBe(24);
    expect(stats.healthErrors).toBe(0);
    expect(validate(records[0]!.collection, r)).toBeNull();
  });

  it('keeps unrecognised codes visible in unclassified[] rather than dropping them', () => {
    const { records, stats } = aggregateObservations(
      [ok('openai', 20), err('openai', 'brand_new_code_2027', 2)],
      OPTS,
    );
    expect(records[0]!.record.unclassified).toEqual([{ code: 'brand_new_code_2027', count: 2 }]);
    expect(stats.unclassifiedErrors).toBe(2);
  });
});

describe('aggregateObservations - provider attribution', () => {
  it('emits no record for an unattributable provider and says so', () => {
    const { records, stats, limitations } = aggregateObservations(
      [
        { provider: UNKNOWN_PROVIDER, providerAttribution: 'unknown', count: 30 },
        { provider: UNKNOWN_PROVIDER, providerAttribution: 'unknown', errorCode: '500', count: 4 },
      ],
      OPTS,
    );
    expect(records).toHaveLength(0);
    expect(stats.providerUnknown).toBe(34);
    expect(limitations.join(' ')).toContain('no attributable provider');
  });

  it('classifies a gateway-internal failure as `gateway` and still publishes nothing', () => {
    // A pseudo-provider with attribution `unknown`: the litellm table resolves
    // the scope for the operator's counters, RULE 3 suppresses the record.
    const { records, stats } = aggregateObservations(
      [{ provider: 'litellm', providerAttribution: 'unknown', errorCode: 'routerratelimiterror', count: 306 }],
      OPTS,
    );
    expect(records).toHaveLength(0);
    expect(stats.gatewayErrors).toBe(306);
  });

  it('withholds an INFERRED provider by default and reports the withholding', () => {
    const { records, stats, limitations } = aggregateObservations(
      [
        { provider: 'gcp.gemini', providerAttribution: 'inferred', count: 40 },
        { provider: 'gcp.gemini', providerAttribution: 'inferred', errorCode: '503', count: 2 },
      ],
      OPTS,
    );
    expect(records).toHaveLength(0);
    expect(stats.providerInferred).toBe(42);
    // The failures are still classified, so the operator sees them locally.
    expect(stats.healthErrors).toBe(2);
    expect(limitations.join(' ')).toContain('INFERRED');
  });

  it('publishes an INFERRED provider only on explicit opt-in, and flags it', () => {
    const { records, limitations } = aggregateObservations(
      [{ provider: 'gcp.gemini', providerAttribution: 'inferred', count: 40 }],
      { ...OPTS, publishInferredProviders: true },
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.record['gen_ai.provider.name']).toBe('gcp.gemini');
    expect(limitations.join(' ')).toContain('published with an INFERRED provider');
  });

  it('lets the weakest attribution in a group decide', () => {
    const { records, stats } = aggregateObservations(
      [
        { provider: 'openai', providerAttribution: 'observed', count: 10 },
        { provider: 'openai', providerAttribution: 'inferred', count: 5 },
      ],
      OPTS,
    );
    expect(records).toHaveLength(0);
    expect(stats.providerInferred).toBe(15);
    expect(stats.providerObserved).toBe(0);
  });
});

describe('aggregateObservations - edges', () => {
  it('emits nothing for an empty window rather than a clean bill of health', () => {
    const { records, stats } = aggregateObservations([], OPTS);
    expect(records).toHaveLength(0);
    expect(stats.totalCalls).toBe(0);
  });

  it('separates providers and models into their own records', () => {
    const { records } = aggregateObservations(
      [ok('openai', 5, 'gpt-4o'), ok('openai', 7, 'gpt-4o-mini'), ok('anthropic', 3)],
      OPTS,
    );
    expect(records.map((r) => r.rkey).sort()).toEqual([
      'anthropic',
      'openai_gpt-4o',
      'openai_gpt-4o-mini',
    ]);
    for (const r of records) expect(validate(r.collection, r.record)).toBeNull();
  });

  it('carries through the collector\'s own limitations', () => {
    const { limitations } = aggregateObservations([ok('openai', 1)], {
      ...OPTS,
      limitations: ['the endpoint was rate limited'],
    });
    expect(limitations).toContain('the endpoint was rate limited');
  });

  it('caps errors[] at the lexicon array limit, highest counts first', () => {
    const many: GatewayObservation[] = [ok('openai', 1000)];
    // 80 distinct bare 5xx status codes, all of which classify as health.
    for (let i = 0; i < 80; i++) many.push(err('openai', String(500 + i), i + 1));
    const { records } = aggregateObservations(many, OPTS);
    const errors = records[0]!.record.errors as { count: number }[];
    expect(errors.length).toBeLessThanOrEqual(64);
    expect(errors[0]!.count).toBeGreaterThanOrEqual(errors[errors.length - 1]!.count);
    expect(validate(records[0]!.collection, records[0]!.record)).toBeNull();
  });
});

describe('aggregateObservations - provider display names seen live', () => {
  // Every provider string OpenRouter returned across a sampled month. A display
  // name that does not fold onto a canonical `gen_ai.provider.name` gets filed
  // under a name no classification table can read, which is how "amazon bedrock"
  // reached a record before this test existed.
  it.each([
    ['Google', 'gcp.gemini'],
    ['Google AI Studio', 'gcp.gemini'],
    ['Google Vertex', 'gcp.gemini'],
    ['Amazon Bedrock', 'aws.bedrock'],
    ['Azure', 'azure.ai.openai'],
    ['OpenAI', 'openai'],
    ['Anthropic', 'anthropic'],
    ['vertex_ai_beta', 'gcp.gemini'],
    ['vertex_ai', 'gcp.gemini'],
  ])('folds %s onto %s', (displayName, canonical) => {
    const { records } = aggregateObservations([ok(displayName, 10)], OPTS);
    expect(records[0]!.record['gen_ai.provider.name']).toBe(canonical);
  });

  it('classifies a Bedrock exception name once the display name is folded', () => {
    const { records, stats } = aggregateObservations(
      [ok('Amazon Bedrock', 100), err('Amazon Bedrock', 'throttlingexception', 4)],
      OPTS,
    );
    expect(records[0]!.record['gen_ai.provider.name']).toBe('aws.bedrock');
    expect(records[0]!.record.errors).toEqual([{ code: 'throttlingexception', count: 4 }]);
    expect(stats.healthErrors).toBe(4);
  });
});
