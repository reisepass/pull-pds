import { describe, it, expect } from 'vitest';
import {
  bucketRequestVolume,
  bucketBounds,
  REQUEST_VOLUME_BUCKETS,
} from '../src/genai/volume.js';

describe('bucketRequestVolume', () => {
  it('maps counts to order-of-magnitude buckets', () => {
    expect(bucketRequestVolume(0)).toBe('0');
    expect(bucketRequestVolume(5)).toBe('1-9');
    expect(bucketRequestVolume(9)).toBe('1-9');
    expect(bucketRequestVolume(10)).toBe('10-99');
    expect(bucketRequestVolume(999)).toBe('100-999');
    expect(bucketRequestVolume(1_000)).toBe('1K-9.9K');
    expect(bucketRequestVolume(50_000)).toBe('10K-99K');
    expect(bucketRequestVolume(1_000_000)).toBe('1M-9.9M');
    expect(bucketRequestVolume(50_000_000)).toBe('10M+');
  });

  it('treats non-positive and non-finite as the empty bucket', () => {
    expect(bucketRequestVolume(-1)).toBe('0');
    expect(bucketRequestVolume(NaN)).toBe('0');
  });

  it('every produced label is a member of the published enum', () => {
    for (const n of [0, 3, 42, 500, 7000, 80000, 900000, 5e6, 9e7]) {
      expect(REQUEST_VOLUME_BUCKETS).toContain(bucketRequestVolume(n));
    }
  });

  it('does not disclose the exact count (privacy property)', () => {
    // Two very different exact counts in the same decade collapse to one label,
    // so the bucket cannot be inverted to the exact scale.
    expect(bucketRequestVolume(1_001)).toBe(bucketRequestVolume(9_998));
  });
});

describe('bucketBounds', () => {
  it('gives the inclusive range for a bucket', () => {
    expect(bucketBounds('100-999')).toEqual({ low: 100, high: 999 });
    expect(bucketBounds('10M+')).toEqual({ low: 10_000_000, high: null });
    expect(bucketBounds('0')).toEqual({ low: 0, high: 0 });
  });

  it('round-trips: a count buckets into a range that contains it', () => {
    for (const n of [7, 55, 640, 8_400, 42_000, 700_000, 6_000_000]) {
      const b = bucketRequestVolume(n);
      const { low, high } = bucketBounds(b);
      expect(n).toBeGreaterThanOrEqual(low);
      if (high != null) expect(n).toBeLessThanOrEqual(high);
    }
  });
});
