/**
 * Coarse request-volume bucketing for the errors-only tier (USAGE-STATS §3).
 *
 * Error counts without a denominator are close to meaningless (100 errors out of
 * 100 requests and out of 1,000,000 are opposite signals). But an EXACT request
 * count discloses competitive scale, which is exactly what the low-sensitivity
 * errors tier is meant to avoid. The resolution: the errors tier carries a
 * COARSE order-of-magnitude bucket - enough to compute an approximate rate, too
 * little to reveal scale. Precise counts live only in the separate opt-in
 * usageMetrics collection.
 *
 * A bucketed number must NEVER be presented as exact. Consumers computing a rate
 * from a bucket get an approximate rate, and the UI labels it as such.
 */

/** The bucket labels, ascending. Must match the enum in the errorMetrics lexicon. */
export const REQUEST_VOLUME_BUCKETS = [
  '0',
  '1-9',
  '10-99',
  '100-999',
  '1K-9.9K',
  '10K-99K',
  '100K-999K',
  '1M-9.9M',
  '10M+',
] as const;

export type RequestVolumeBucket = (typeof REQUEST_VOLUME_BUCKETS)[number];

/**
 * Map an exact request count to its order-of-magnitude bucket label. The
 * publisher calls this BEFORE building the record, so the exact count never
 * leaves the publisher for the errors tier.
 */
export function bucketRequestVolume(count: number): RequestVolumeBucket {
  if (!Number.isFinite(count) || count <= 0) return '0';
  if (count < 10) return '1-9';
  if (count < 100) return '10-99';
  if (count < 1_000) return '100-999';
  if (count < 10_000) return '1K-9.9K';
  if (count < 100_000) return '10K-99K';
  if (count < 1_000_000) return '100K-999K';
  if (count < 10_000_000) return '1M-9.9M';
  return '10M+';
}

/**
 * The inclusive [low, high] request-count range a bucket represents, for
 * computing an approximate rate INTERVAL from a bucket. `high` is null for the
 * open-ended top bucket. Used by consumers/UI to show a rate as a range rather
 * than a false-precision point value.
 */
export function bucketBounds(bucket: string): { low: number; high: number | null } {
  switch (bucket) {
    case '0':
      return { low: 0, high: 0 };
    case '1-9':
      return { low: 1, high: 9 };
    case '10-99':
      return { low: 10, high: 99 };
    case '100-999':
      return { low: 100, high: 999 };
    case '1K-9.9K':
      return { low: 1_000, high: 9_999 };
    case '10K-99K':
      return { low: 10_000, high: 99_999 };
    case '100K-999K':
      return { low: 100_000, high: 999_999 };
    case '1M-9.9M':
      return { low: 1_000_000, high: 9_999_999 };
    case '10M+':
      return { low: 10_000_000, high: null };
    default:
      return { low: 0, high: null };
  }
}
