/**
 * Turn collected events into `org.peertelemetry.errorMetrics` records.
 *
 * This mirrors `src/prober/aggregate.ts` and enforces the same two privacy
 * rules of the errors tier, both BEFORE anything reaches a publisher:
 * account-scoped codes are dropped by `partitionErrors`, and request volume is
 * bucketed by `bucketRequestVolume` rather than published as a count.
 *
 * IT DIFFERS FROM THE PROBER IN ONE IMPORTANT WAY: THE DENOMINATOR.
 *
 * A prober makes its own requests, so it always knows how many it made. This
 * collector reads someone else's logs, and whether those logs record SUCCESSES
 * varies by source - AGY logs one info line per completed request, Claude Code's
 * transcripts carry one assistant turn per completion, and Codex's structured
 * log ring may hold neither in the window that survived.
 *
 * So a group with errors and ZERO observed successful requests is NOT published.
 * Publishing it would assert `totalErrors: 5, requestVolumeBucket: "1-9"` - a
 * ~100% provider failure rate - when the truth is that this source never records
 * the successes. That claim, federated across publishers, is worse than silence:
 * it is a confident wrong answer where a missing record would simply have been
 * absent. The group is reported to the caller instead, which logs it, and
 * `publishWithoutSuccesses` exists for an operator who knows their source really
 * does log every request.
 */
import { ERROR_METRICS_NSID } from '../collections.js';
import { partitionErrors, type ErrorCodeCount } from '../genai/error-classify.js';
import { bucketRequestVolume } from '../genai/volume.js';
import { deriveRkey } from '../prober/config.js';
import type { TelemetryRecord } from '../prober/publish.js';
import { UNKNOWN, groupKey, type AttemptCount, type ErrorEvent } from './types.js';

/** Lexicon `maxLength` on both `errors[]` and `unclassified[]`. */
const MAX_CODE_ENTRIES = 64;

export interface CollectorAggregateOptions {
  windowStartMs: number;
  windowEndMs: number;
  distroName: string;
  distroVersion?: string;
  /** `serviceType` on the record. `llm` for every source this collector reads. */
  serviceType: string;
  /**
   * Emit a record even when the source observed no successful request, so the
   * volume bucket is derived from the error count alone. Off by default: see the
   * module header.
   */
  publishWithoutSuccesses: boolean;
}

/** Per-group local counters. Never published. */
export interface GroupStats {
  provider: string;
  model: string;
  successes: number;
  healthErrors: number;
  /** Dropped before the record was built. The operator's only sight of them. */
  accountErrors: number;
  unclassifiedErrors: number;
  /** Which adapters contributed, for the local log line. */
  sources: string[];
}

export interface CollectorAggregateResult {
  records: TelemetryRecord[];
  stats: GroupStats[];
  /** Groups withheld for having no observed denominator. */
  withheld: GroupStats[];
}

interface Group {
  provider: string;
  model: string;
  codes: Map<string, ErrorCodeCount>;
  successes: number;
  sources: Set<string>;
}

/**
 * Build one record per (provider, model). Groups whose provider AND model are
 * both `unknown` are dropped entirely - a record that names neither is not a
 * statement about any provider, and the lexicon's whole point is that it is.
 */
export function aggregateEvents(
  events: readonly ErrorEvent[],
  attempts: readonly AttemptCount[],
  opts: CollectorAggregateOptions,
): CollectorAggregateResult {
  const groups = new Map<string, Group>();
  const keyOf = (provider: string, model: string): string => groupKey(provider, model);
  const groupFor = (provider: string, model: string): Group => {
    const key = keyOf(provider, model);
    let g = groups.get(key);
    if (g === undefined) {
      g = { provider, model, codes: new Map(), successes: 0, sources: new Set() };
      groups.set(key, g);
    }
    return g;
  };

  for (const a of attempts) {
    groupFor(a.provider, a.model).successes += a.successes;
  }
  for (const ev of events) {
    const g = groupFor(ev.provider, ev.model);
    g.sources.add(ev.sourceCli);
    const existing = g.codes.get(ev.errorCode);
    if (existing) {
      existing.count += 1;
    } else {
      g.codes.set(ev.errorCode, {
        code: ev.errorCode,
        count: 1,
        ...(ev.httpStatus === undefined ? {} : { httpStatus: ev.httpStatus }),
      });
    }
  }

  const records: TelemetryRecord[] = [];
  const stats: GroupStats[] = [];
  const withheld: GroupStats[] = [];
  const observedAt = new Date(opts.windowEndMs).toISOString();

  for (const g of groups.values()) {
    const errorCount = [...g.codes.values()].reduce((n, c) => n + c.count, 0);
    if (errorCount === 0) continue; // a clean window emits nothing, not a zero record
    if (g.provider === UNKNOWN && g.model === UNKNOWN) continue;

    const partitioned = partitionErrors(g.provider, [...g.codes.values()]);
    const sum = (codes: readonly ErrorCodeCount[]): number =>
      codes.reduce((n, c) => n + c.count, 0);
    const groupStats: GroupStats = {
      provider: g.provider,
      model: g.model,
      successes: g.successes,
      healthErrors: sum(partitioned.health),
      accountErrors: sum(partitioned.account),
      unclassifiedErrors: sum(partitioned.unclassified),
      sources: [...g.sources].sort(),
    };

    if (g.successes === 0 && !opts.publishWithoutSuccesses) {
      withheld.push(groupStats);
      continue;
    }

    const errors = capCodes(partitioned.health);
    const unclassified = capCodes(partitioned.unclassified);
    const record: Record<string, unknown> = {
      $type: ERROR_METRICS_NSID,
      serviceType: opts.serviceType,
      'gen_ai.provider.name': g.provider,
      ...(g.model === UNKNOWN ? {} : { 'gen_ai.request.model': g.model }),
      windowStartUnixMicro: toUnixMicro(opts.windowStartMs),
      windowEndUnixMicro: toUnixMicro(opts.windowEndMs),
      errors,
      ...(unclassified.length > 0 ? { unclassified } : {}),
      totalErrors: sum(errors),
      // Successes PLUS every error, so the denominator is request attempts and
      // not just the ones that worked. Exact, with the bucket kept alongside for
      // consumers reading records signed before requestCount existed.
      requestCount: g.successes + errorCount,
      requestVolumeBucket: bucketRequestVolume(g.successes + errorCount),
      'telemetry.distro.name': opts.distroName,
      ...(opts.distroVersion === undefined ? {} : { 'telemetry.distro.version': opts.distroVersion }),
      // Without this a window whose only failures were account-scoped publishes
      // `totalErrors: 0` and reads as a clean bill of health.
      totalErrorsAllScopes: errorCount,
      observedAt,
      emittedAt: observedAt,
    };

    records.push({ collection: ERROR_METRICS_NSID, rkey: deriveRkey(g.provider, g.model), record });
    stats.push(groupStats);
  }

  return { records, stats, withheld };
}

/** Highest counts first, capped at the lexicon's array limit. */
function capCodes(codes: readonly ErrorCodeCount[]): { code: string; count: number }[] {
  return [...codes]
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, MAX_CODE_ENTRIES)
    .map((c) => ({ code: c.code, count: c.count }));
}

/** Epoch ms -> the lexicon's MICROseconds. See `prober/aggregate.ts`. */
function toUnixMicro(ms: number): number {
  return Math.round(ms) * 1000;
}
