import { describe, it, expect } from 'vitest';
import { parseProberConfig, type EndpointConfig } from '../src/prober/config.js';
import { aggregateEndpoint } from '../src/prober/aggregate.js';
import type { ProbeResult } from '../src/prober/probe.js';
import { buildRecordValidator } from '../src/pds-websub/lexicon-validate.js';
import { ERROR_METRICS_NSID } from '../src/collections.js';
import { REQUEST_VOLUME_BUCKETS } from '../src/genai/volume.js';

const validate = buildRecordValidator();

const OPTS = {
  windowStartMs: 1_800_000_000_000,
  windowEndMs: 1_800_000_060_000,
  distroName: 'peertelemetry-prober',
  distroVersion: '0.1.0',
};

function endpoint(patch: Partial<EndpointConfig> = {}): EndpointConfig {
  const cfg = parseProberConfig({
    publisherDid: 'did:web:node.example.com',
    endpoints: [{ provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' }],
  });
  return { ...(cfg.endpoints[0] as EndpointConfig), ...patch };
}

const ok = (latencyMs = 30): ProbeResult => ({ ok: true, httpStatus: 200, latencyMs });
const fail = (errorCode: string, httpStatus?: number): ProbeResult => ({
  ok: false,
  errorCode,
  ...(httpStatus === undefined ? {} : { httpStatus }),
  latencyMs: 12,
});

describe('aggregateEndpoint - record shape', () => {
  it('emits a record that passes the committed errorMetrics lexicon', () => {
    const { record } = aggregateEndpoint(endpoint(), [ok()], OPTS);
    expect(record.collection).toBe(ERROR_METRICS_NSID);
    expect(record.rkey).toBe('openai_gpt-4o-mini');
    expect(validate(record.collection, record.record)).toBeNull();
  });

  it('carries the OTel field names and microsecond window bounds', () => {
    const { record } = aggregateEndpoint(endpoint(), [ok()], OPTS);
    const r = record.record;
    expect(r['gen_ai.provider.name']).toBe('openai');
    expect(r['gen_ai.request.model']).toBe('gpt-4o-mini');
    expect(r['telemetry.distro.name']).toBe('peertelemetry-prober');
    expect(r['telemetry.distro.version']).toBe('0.1.0');
    expect(r.windowStartUnixMicro).toBe(OPTS.windowStartMs * 1000);
    expect(r.windowEndUnixMicro).toBe(OPTS.windowEndMs * 1000);
    expect(r.serviceType).toBe('llm');
  });

  it('omits the model field entirely for a provider with no model dimension', () => {
    const ep = endpoint({ rkey: 'someisp', serviceType: 'isp' });
    delete (ep as { model?: string }).model;
    const { record } = aggregateEndpoint(ep, [ok()], OPTS);
    expect(record.record).not.toHaveProperty('gen_ai.request.model');
    expect(validate(record.collection, record.record)).toBeNull();
  });
});

describe('aggregateEndpoint - volume is bucketed, never exact', () => {
  it('publishes a bucket label, not the attempt count', () => {
    const { record } = aggregateEndpoint(endpoint({ attempts: 3 }), [ok(), ok(), fail('503', 503)], OPTS);
    expect(record.record.requestVolumeBucket).toBe('1-9');
    expect(REQUEST_VOLUME_BUCKETS).toContain(record.record.requestVolumeBucket);
    // The exact denominator must appear nowhere in the record.
    expect(record.record).not.toHaveProperty('requestVolume');
    expect(record.record).not.toHaveProperty('operationCount');
  });

  it('never emits a field the errorMetrics lexicon does not declare (closed world)', () => {
    // Latency is measured but has no home on this schema; if it ever leaked into
    // the record, the closed-world validator would reject it. This test is the
    // guard on that.
    const { record, stats } = aggregateEndpoint(endpoint(), [ok(88)], OPTS);
    expect(stats.latenciesMs).toEqual([88]);
    expect(JSON.stringify(record.record)).not.toContain('88');
    expect(validate(record.collection, record.record)).toBeNull();
  });
});

describe('aggregateEndpoint - classification routing', () => {
  it('puts health codes in errors[] and sums them into totalErrors', () => {
    const results = [fail('rate_limit_exceeded', 429), fail('rate_limit_exceeded', 429), fail('503', 503)];
    const { record, stats } = aggregateEndpoint(endpoint({ attempts: 3 }), results, OPTS);
    expect(record.record.errors).toEqual([
      { code: 'rate_limit_exceeded', count: 2 },
      { code: '503', count: 1 },
    ]);
    expect(record.record.totalErrors).toBe(3);
    expect(stats.healthErrors).toBe(3);
  });

  it('DROPS account-scoped codes before the record exists', () => {
    const results = [fail('insufficient_quota', 429), fail('invalid_api_key', 401)];
    const { record, stats } = aggregateEndpoint(endpoint({ attempts: 2 }), results, OPTS);
    const json = JSON.stringify(record.record);
    expect(json).not.toContain('insufficient_quota');
    expect(json).not.toContain('invalid_api_key');
    expect(record.record.errors).toEqual([]);
    expect(record.record.totalErrors).toBe(0);
    expect(stats.accountErrors).toBe(2);
  });

  it('still signals that SOMETHING failed when every error was account-scoped', () => {
    // The trap: a dead API key would otherwise publish "totalErrors: 0", a clean
    // bill of health for a provider that was never successfully contacted.
    const { record } = aggregateEndpoint(endpoint({ attempts: 2 }), [
      fail('invalid_api_key', 401),
      fail('invalid_api_key', 401),
    ], OPTS);
    expect(record.record.totalErrors).toBe(0);
    expect(record.record.totalErrorsAllScopes).toBe(2);
    expect(validate(record.collection, record.record)).toBeNull();
  });

  it('keeps an unrecognised code visible instead of dropping it', () => {
    const { record, stats } = aggregateEndpoint(endpoint(), [fail('brand_new_code')], OPTS);
    expect(record.record.unclassified).toEqual([{ code: 'brand_new_code', count: 1 }]);
    expect(record.record.totalErrors).toBe(0);
    expect(stats.unclassifiedErrors).toBe(1);
  });

  it('classifies transport failures as provider health via the shared table', () => {
    const { record } = aggregateEndpoint(endpoint({ attempts: 2 }), [fail('timeout'), fail('connection_error')], OPTS);
    expect(record.record.errors).toEqual([
      { code: 'connection_error', count: 1 },
      { code: 'timeout', count: 1 },
    ]);
    expect(record.record.totalErrors).toBe(2);
  });

  it('emits an all-clear record with an empty errors array on a healthy run', () => {
    const { record, stats } = aggregateEndpoint(endpoint(), [ok()], OPTS);
    expect(record.record.errors).toEqual([]);
    expect(record.record.totalErrors).toBe(0);
    expect(record.record.totalErrorsAllScopes).toBe(0);
    expect(record.record).not.toHaveProperty('unclassified');
    expect(stats).toMatchObject({ attempts: 1, ok: 1, healthErrors: 0, accountErrors: 0 });
  });
});
