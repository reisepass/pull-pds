/**
 * Turn a run's probe results into `org.peertelemetry.errorMetrics` records.
 *
 * This is where the two privacy rules of the errors tier are enforced, and both
 * happen BEFORE anything is handed to a publisher:
 *
 *   1. Account-scoped codes are dropped (`partitionErrors`), so an expired key
 *      or an exhausted quota never enters a signed, public record.
 *   2. Request volume is BUCKETED (`bucketRequestVolume`), never an exact count.
 *      A prober's exact attempt count is not very sensitive, but the tier's
 *      contract is that this field is coarse, and a publisher that emits exact
 *      counts here teaches consumers to read the field as exact.
 *
 * THE TRAP THIS MODULE HAS TO HANDLE. Dropping account-scoped codes means a
 * prober whose API key just expired reports `totalErrors: 0` - a record that
 * reads "the provider is fine" when in truth nothing was measured at all. That
 * silence is the worst possible failure for an active prober, so:
 *   - `totalErrorsAllScopes` (an optional lexicon field, existing exactly for
 *     this) carries the count of ALL errors including the dropped ones, which
 *     tells a consumer "something failed here" without disclosing WHICH
 *     account-scoped code it was, and
 *   - {@link AggregateStats} reports the account-scoped count back to the caller
 *     so the run logs a loud warning locally, where the operator can see it.
 *
 * WHAT THIS SCHEMA CANNOT CARRY: latency. `errorMetrics` has no latency field
 * (percentiles live on `org.peertelemetry.usageMetrics`, the separate
 * higher-disclosure opt-in tier), and lexicon validation is closed-world, so an
 * added field would be rejected. Probe latency is therefore measured, logged,
 * and returned to the caller, but NOT published by this daemon. Stated here
 * rather than silently dropped.
 */
import { ERROR_METRICS_NSID } from '../collections.js';
import { partitionErrors, type ErrorCodeCount } from '../genai/error-classify.js';
import { bucketRequestVolume } from '../genai/volume.js';
import type { EndpointConfig } from './config.js';
import type { ProbeResult } from './probe.js';
import type { TelemetryRecord } from './publish.js';

/** Lexicon `maxLength` on both `errors[]` and `unclassified[]`. */
const MAX_CODE_ENTRIES = 64;

export interface AggregateOptions {
  /** Window start, epoch ms. Converted to the lexicon's microseconds. */
  windowStartMs: number;
  /** Window end, epoch ms. */
  windowEndMs: number;
  /** OTel `telemetry.distro.name`. */
  distroName: string;
  distroVersion?: string;
}

/** Local-only counters. Never published; drives logging and the exit code. */
export interface AggregateStats {
  attempts: number;
  ok: number;
  /** Health-classified errored probes - the published signal. */
  healthErrors: number;
  /** Account-scoped errored probes, dropped before the record was built. */
  accountErrors: number;
  /**
   * Model-level failures (2xx service, unusable output) and gateway-internal
   * routing failures, both dropped before the record was built. A prober never
   * produces either - it makes one direct request and reads the HTTP outcome -
   * so these stay 0 here; they exist because `partitionErrors` is shared with
   * `src/gateway/`, and counting them keeps `totalErrorsAllScopes` honest for
   * every caller instead of only the prober.
   */
  modelErrors: number;
  gatewayErrors: number;
  unclassifiedErrors: number;
  /** Round-trip latencies in ms, in probe order. Not publishable on this schema. */
  latenciesMs: number[];
}

export interface AggregatedEndpoint {
  record: TelemetryRecord;
  stats: AggregateStats;
}

/**
 * Build one endpoint's record plus its local stats. `results` is every probe
 * attempted for that endpoint in this run; an empty array is not valid input
 * (an endpoint that could not be probed emits no record - see `run.ts`).
 */
export function aggregateEndpoint(
  ep: EndpointConfig,
  results: readonly ProbeResult[],
  opts: AggregateOptions,
): AggregatedEndpoint {
  // Roll per-probe outcomes up into per-code counts. `httpStatus` rides along
  // as the classifier's weak secondary signal and is stripped by partitionErrors
  // before anything reaches a record.
  const byCode = new Map<string, ErrorCodeCount>();
  for (const r of results) {
    if (r.ok || r.errorCode === undefined) continue;
    const existing = byCode.get(r.errorCode);
    if (existing) {
      existing.count += 1;
      continue;
    }
    byCode.set(r.errorCode, {
      code: r.errorCode,
      count: 1,
      ...(r.httpStatus === undefined ? {} : { httpStatus: r.httpStatus }),
    });
  }

  const partitioned = partitionErrors(ep.provider, [...byCode.values()]);
  const sum = (codes: readonly ErrorCodeCount[]): number =>
    codes.reduce((n, c) => n + c.count, 0);

  const stats: AggregateStats = {
    attempts: results.length,
    ok: results.filter((r) => r.ok).length,
    healthErrors: sum(partitioned.health),
    accountErrors: sum(partitioned.account),
    modelErrors: sum(partitioned.model),
    gatewayErrors: sum(partitioned.gateway),
    unclassifiedErrors: sum(partitioned.unclassified),
    latenciesMs: results.map((r) => r.latencyMs),
  };

  const errors = capCodes(partitioned.health);
  const unclassified = capCodes(partitioned.unclassified);
  const observedAt = new Date(opts.windowEndMs).toISOString();

  const record: Record<string, unknown> = {
    $type: ERROR_METRICS_NSID,
    serviceType: ep.serviceType,
    'gen_ai.provider.name': ep.provider,
    ...(ep.model === undefined ? {} : { 'gen_ai.request.model': ep.model }),
    windowStartUnixMicro: toUnixMicro(opts.windowStartMs),
    windowEndUnixMicro: toUnixMicro(opts.windowEndMs),
    errors,
    ...(unclassified.length > 0 ? { unclassified } : {}),
    totalErrors: sum(errors),
    // The EXACT attempt count, paired with the window bounds, so a consumer can
    // divide rather than estimate. The coarse bucket is emitted alongside it for
    // consumers reading records signed before requestCount existed.
    requestCount: results.length,
    requestVolumeBucket: bucketRequestVolume(results.length),
    'telemetry.distro.name': opts.distroName,
    ...(opts.distroVersion === undefined ? {} : { 'telemetry.distro.version': opts.distroVersion }),
    // See the module header: this is what stops a dead credential from being
    // published as a clean bill of health.
    totalErrorsAllScopes:
      stats.healthErrors +
      stats.accountErrors +
      stats.modelErrors +
      stats.gatewayErrors +
      stats.unclassifiedErrors,
    observedAt,
    emittedAt: observedAt,
  };

  return { record: { collection: ERROR_METRICS_NSID, rkey: ep.rkey, record }, stats };
}

/**
 * Highest counts first, capped at the lexicon's array limit. A prober will never
 * approach 64 distinct codes in one window; the cap exists so a pathological
 * input produces a valid record instead of a rejected one.
 */
function capCodes(codes: readonly ErrorCodeCount[]): { code: string; count: number }[] {
  return [...codes]
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, MAX_CODE_ENTRIES)
    .map((c) => ({ code: c.code, count: c.count }));
}

/**
 * Epoch ms -> the lexicon's MICROseconds. Microseconds (not OTel's nanoseconds)
 * because nanoseconds exceed Number.MAX_SAFE_INTEGER and the AT data-model CBOR
 * encoder rejects non-safe integers.
 */
function toUnixMicro(ms: number): number {
  return Math.round(ms) * 1000;
}
