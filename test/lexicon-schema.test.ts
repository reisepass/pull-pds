import { describe, it, expect } from 'vitest';
import { buildRecordValidator } from '../src/pds-websub/lexicon-validate.js';
import { ERROR_METRICS_NSID, USAGE_METRICS_NSID } from '../src/collections.js';

const validate = buildRecordValidator();

function errorRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serviceType: 'llm',
    'gen_ai.provider.name': 'openai',
    'gen_ai.request.model': 'gpt-4o',
    windowStartUnixMicro: 1785000000000000,
    windowEndUnixMicro: 1785000300000000,
    errors: [{ code: '429', count: 5 }],
    totalErrors: 5,
    requestVolumeBucket: '1K-9.9K',
    'telemetry.distro.name': 'omniroute',
    observedAt: '2026-07-21T00:00:00.000Z',
    ...over,
  };
}

describe('org.peertelemetry.errorMetrics lexicon', () => {
  it('validates a well-formed record', () => {
    expect(validate(ERROR_METRICS_NSID, errorRecord())).toBeNull();
  });

  it('requires serviceType', () => {
    const { serviceType, ...without } = errorRecord();
    void serviceType;
    expect(validate(ERROR_METRICS_NSID, without)).not.toBeNull();
  });

  it('accepts an open-vocabulary serviceType beyond the known values', () => {
    // The scope is any digital service provider; a value the lexicon does not
    // enumerate (it is NOT a closed enum) must still validate and be preserved.
    expect(validate(ERROR_METRICS_NSID, errorRecord({ serviceType: 'isp' }))).toBeNull();
    expect(validate(ERROR_METRICS_NSID, errorRecord({ serviceType: 'quantum-widget' }))).toBeNull();
  });

  it('allows an ISP-style record with no model (model is not required)', () => {
    const { ['gen_ai.request.model']: _m, ...noModel } = errorRecord({ serviceType: 'isp', 'gen_ai.provider.name': 'deutsche-telekom' });
    void _m;
    expect(validate(ERROR_METRICS_NSID, noModel)).toBeNull();
  });

  it('still rejects an unknown top-level field (closed-world guard)', () => {
    expect(validate(ERROR_METRICS_NSID, errorRecord({ bogus: 1 }))).not.toBeNull();
  });
});

describe('org.peertelemetry.usageMetrics lexicon', () => {
  const usage = {
    serviceType: 'llm',
    'gen_ai.provider.name': 'openai',
    'gen_ai.request.model': 'gpt-4o',
    windowStartUnixMicro: 1785000000000000,
    windowEndUnixMicro: 1785000300000000,
    operationCount: 100,
    'gen_ai.usage.input_tokens': 5000,
    'gen_ai.usage.output_tokens': 2000,
    latencyMsP50: 300,
    latencyMsP90: 900,
    latencyMsP99: 2500,
    'telemetry.distro.name': 'omniroute',
    observedAt: '2026-07-21T00:00:00.000Z',
  };

  it('validates a well-formed usage record', () => {
    expect(validate(USAGE_METRICS_NSID, usage)).toBeNull();
  });

  it('requires serviceType', () => {
    const { serviceType, ...without } = usage;
    void serviceType;
    expect(validate(USAGE_METRICS_NSID, without)).not.toBeNull();
  });

  it('allows a usage record with no model (serviceType is the axis, not model)', () => {
    const { ['gen_ai.request.model']: _m, ...noModel } = { ...usage, serviceType: 'isp', 'gen_ai.provider.name': 'comcast' };
    void _m;
    expect(validate(USAGE_METRICS_NSID, noModel)).toBeNull();
  });
});
