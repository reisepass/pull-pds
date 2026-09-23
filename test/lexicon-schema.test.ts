import { describe, it, expect } from 'vitest';
import { buildRecordValidator } from '../src/pds-websub/lexicon-validate.js';
import { EXAMPLE_READING_NSID } from '../src/collections.js';

const validate = buildRecordValidator();

function reading(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sensorId: 'station-7',
    metric: 'pm25',
    value: 12,
    unit: 'ug/m3',
    observedAt: '2026-07-21T00:00:00.000Z',
    ...over,
  };
}

describe('com.example.sensor.reading toy lexicon', () => {
  it('validates a well-formed record', () => {
    expect(validate(EXAMPLE_READING_NSID, reading())).toBeNull();
  });

  it.each(['sensorId', 'metric', 'value', 'unit', 'observedAt'])('requires %s', (field) => {
    const without = reading();
    delete without[field];
    expect(validate(EXAMPLE_READING_NSID, without)).not.toBeNull();
  });

  it('rejects a non-integer value', () => {
    expect(validate(EXAMPLE_READING_NSID, reading({ value: 12.5 }))).not.toBeNull();
    expect(validate(EXAMPLE_READING_NSID, reading({ value: '12' }))).not.toBeNull();
  });

  it('rejects a malformed observedAt', () => {
    expect(validate(EXAMPLE_READING_NSID, reading({ observedAt: 'yesterday' }))).not.toBeNull();
  });

  it('rejects an unknown top-level field (closed-world guard)', () => {
    expect(validate(EXAMPLE_READING_NSID, reading({ homeAddress: 'x' }))).not.toBeNull();
  });

  it('leaves collections without a bundled lexicon to structural checks', () => {
    expect(validate('com.example.custom.record', { anything: 1 })).toBeNull();
  });
});
