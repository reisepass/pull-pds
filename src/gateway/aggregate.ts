/**
 * Turn a gateway's {@link GatewayObservation}s into `org.peertelemetry.errorMetrics`
 * records. The gateway-side counterpart of `src/prober/aggregate.ts`, and it
 * enforces the same two privacy rules before anything reaches a publisher:
 * account-scoped codes are dropped, and request volume is bucketed rather than
 * exact. It then adds the two rules that only a gateway needs.
 *
 * RULE 3 - AN UNATTRIBUTED PROVIDER EMITS NO RECORD. A record's whole meaning is
 * "provider X had these errors". `gen_ai.provider.name` is a REQUIRED lexicon
 * field, so an observation whose provider could not be determined has nowhere
 * honest to go: filing it under `"unknown"` would create a permanent, signed,
 * public record naming a provider that does not exist, and consumers aggregating
 * across publishers would see a phantom. Those observations are counted in
 * {@link CollectStats.providerUnknown}, reported in `limitations`, and dropped.
 * This is not rare - on the live LiteLLM deployment 307 of 385 failures in 37
 * days carried no provider at all.
 *
 * RULE 4 - AN INFERRED PROVIDER IS NOT PUBLISHED BY DEFAULT. `errorMetrics` is
 * closed-world and has no field for "how did you arrive at this provider name",
 * so a record built from a slug-derived guess is indistinguishable, on the wire,
 * from one the gateway actually recorded. Publishing it would therefore present
 * an inference as an observation - precisely what {@link ProviderAttribution}
 * exists to prevent. So `publishInferredProviders` defaults to FALSE: inferred
 * observations are counted, surfaced in `limitations`, and withheld. An operator
 * who understands the trade can opt in, and then the limitation string says so
 * on every run, but the DEFAULT never quietly upgrades a guess to a fact.
 *
 * GROUPING. One record per (provider, model), which is the lexicon's shape and
 * the prober's. Successful calls are observations too - they carry no
 * `errorCode` and exist to be the denominator, without which an error count
 * means nothing (USAGE-STATS §3).
 */
import { ERROR_METRICS_NSID } from '../collections.js';
import {
  partitionErrors,
  normalizeProvider,
  type ErrorCodeCount,
} from '../genai/error-classify.js';
import { bucketRequestVolume } from '../genai/volume.js';
import { deriveRkey } from '../prober/config.js';
import type { TelemetryRecord } from '../prober/publish.js';
import {
  UNKNOWN_PROVIDER,
  type CollectResult,
  type CollectStats,
  type GatewayObservation,
  type ProviderAttribution,
} from './types.js';

/** Lexicon `maxLength` on both `errors[]` and `unclassified[]`. */
const MAX_CODE_ENTRIES = 64;

export interface GatewayAggregateOptions {
  /** Stable source id, e.g. `openrouter`. Lands in {@link CollectResult.source}. */
  source: string;
  /** Window start, epoch ms. Converted to the lexicon's microseconds. */
  windowStartMs: number;
  /** Window end, epoch ms. */
  windowEndMs: number;
  /** OTel `telemetry.distro.name`. */
  distroName: string;
  distroVersion?: string;
  /** Open-vocabulary `serviceType`. Every gateway source here is `llm`. */
  serviceType?: string;
  /**
   * Publish records whose provider was INFERRED from a model slug rather than
   * recorded by the gateway. Defaults to false - see RULE 4 in the module
   * header. Turning this on is a deliberate, documented downgrade in the
   * fidelity of every record the source emits.
   */
  publishInferredProviders?: boolean;
  /**
   * Limitations the collector already knows about (an unauthorised endpoint, a
   * truncated result set). Merged with the ones aggregation discovers.
   */
  limitations?: readonly string[];
}

/** How much a given attribution can be trusted; lowest wins within a group. */
const ATTRIBUTION_RANK: Record<ProviderAttribution, number> = {
  unknown: 0,
  inferred: 1,
  observed: 2,
};

interface Group {
  provider: string;
  model?: string;
  attribution: ProviderAttribution;
  /** Every call in the group, errored or not. The exact denominator. */
  totalCalls: number;
  byCode: Map<string, ErrorCodeCount>;
}

/**
 * Build a source's records plus its local stats and limitations.
 *
 * `observations` is everything the collector read for the window - errors AND
 * successes. An empty array is valid input and yields no records: a window with
 * no traffic is not a statement about any provider's health.
 */
export function aggregateObservations(
  observations: readonly GatewayObservation[],
  opts: GatewayAggregateOptions,
): CollectResult {
  const groups = new Map<string, Group>();
  for (const obs of observations) {
    // Normalise here, once, so the group key, the classifier lookup and the
    // published `gen_ai.provider.name` can never disagree about what "Google AI
    // Studio" or "vertex_ai_beta" is called.
    const provider =
      obs.provider === UNKNOWN_PROVIDER ? UNKNOWN_PROVIDER : normalizeProvider(obs.provider);
    // NUL separator, written as an escape: provider DISPLAY names contain
    // spaces ("Amazon Bedrock", "Google AI Studio"), so a space would let two
    // different (provider, model) pairs collide on one key.
    const key = `${provider}\u0000${obs.model ?? ''}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        provider,
        ...(obs.model === undefined ? {} : { model: obs.model }),
        attribution: obs.providerAttribution,
        totalCalls: 0,
        byCode: new Map(),
      };
      groups.set(key, group);
    }
    // The weakest attribution in the group wins: a group that mixes an observed
    // and an inferred provider name is only as trustworthy as the inference.
    if (ATTRIBUTION_RANK[obs.providerAttribution] < ATTRIBUTION_RANK[group.attribution]) {
      group.attribution = obs.providerAttribution;
    }
    group.totalCalls += obs.count;
    if (obs.errorCode === undefined) continue;
    const existing = group.byCode.get(obs.errorCode);
    if (existing !== undefined) {
      existing.count += obs.count;
      continue;
    }
    group.byCode.set(obs.errorCode, {
      code: obs.errorCode,
      count: obs.count,
      ...(obs.httpStatus === undefined ? {} : { httpStatus: obs.httpStatus }),
    });
  }

  const stats: CollectStats = {
    totalCalls: 0,
    healthErrors: 0,
    accountErrors: 0,
    modelErrors: 0,
    gatewayErrors: 0,
    unclassifiedErrors: 0,
    providerObserved: 0,
    providerInferred: 0,
    providerUnknown: 0,
  };
  const records: TelemetryRecord[] = [];
  const limitations = [...(opts.limitations ?? [])];
  const publishInferred = opts.publishInferredProviders === true;
  let unknownCalls = 0;
  let inferredCalls = 0;
  const withheldProviders = new Set<string>();

  for (const group of groups.values()) {
    stats.totalCalls += group.totalCalls;
    if (group.attribution === 'observed') stats.providerObserved += group.totalCalls;
    else if (group.attribution === 'inferred') stats.providerInferred += group.totalCalls;
    else stats.providerUnknown += group.totalCalls;

    // Classify BEFORE any suppression decision, so a dropped group's failures
    // still show up in the operator's counters instead of vanishing silently.
    const partitioned = partitionErrors(group.provider, [...group.byCode.values()]);
    stats.healthErrors += sum(partitioned.health);
    stats.accountErrors += sum(partitioned.account);
    stats.modelErrors += sum(partitioned.model);
    stats.gatewayErrors += sum(partitioned.gateway);
    stats.unclassifiedErrors += sum(partitioned.unclassified);

    // RULE 3: nothing to name, nothing to publish.
    if (group.attribution === 'unknown' || group.provider === UNKNOWN_PROVIDER) {
      unknownCalls += group.totalCalls;
      continue;
    }
    // RULE 4: an inference is not published as an observation by default.
    if (group.attribution === 'inferred' && !publishInferred) {
      inferredCalls += group.totalCalls;
      withheldProviders.add(group.provider);
      continue;
    }

    const errors = capCodes(partitioned.health);
    const unclassified = capCodes(partitioned.unclassified);
    const observedAt = new Date(opts.windowEndMs).toISOString();

    const record: Record<string, unknown> = {
      $type: ERROR_METRICS_NSID,
      serviceType: opts.serviceType ?? 'llm',
      'gen_ai.provider.name': group.provider,
      ...(group.model === undefined ? {} : { 'gen_ai.request.model': group.model }),
      windowStartUnixMicro: toUnixMicro(opts.windowStartMs),
      windowEndUnixMicro: toUnixMicro(opts.windowEndMs),
      errors,
      ...(unclassified.length > 0 ? { unclassified } : {}),
      totalErrors: sum(errors),
      // A gateway's denominator IS real production traffic, so an exact count
      // here discloses genuine scale. That is the deliberate trade: a rate a
      // consumer can divide beats one they have to bound. The bucket stays for
      // consumers reading records signed before requestCount existed.
      requestCount: group.totalCalls,
      requestVolumeBucket: bucketRequestVolume(group.totalCalls),
      'telemetry.distro.name': opts.distroName,
      ...(opts.distroVersion === undefined
        ? {}
        : { 'telemetry.distro.version': opts.distroVersion }),
      // Keeps "nothing was published" distinguishable from "nothing failed":
      // every scope, including the ones dropped above, is counted here.
      totalErrorsAllScopes:
        sum(partitioned.health) +
        sum(partitioned.account) +
        sum(partitioned.model) +
        sum(partitioned.gateway) +
        sum(partitioned.unclassified),
      observedAt,
      emittedAt: observedAt,
    };

    records.push({
      collection: ERROR_METRICS_NSID,
      rkey: deriveRkey(group.provider, group.model),
      record,
    });
  }

  if (unknownCalls > 0) {
    limitations.push(
      `${unknownCalls} call(s) carried no attributable provider and emitted no record; ` +
        `the source recorded no provider and none could be derived`,
    );
  }
  if (inferredCalls > 0) {
    limitations.push(
      `${inferredCalls} call(s) across ${withheldProviders.size} provider(s) had an INFERRED ` +
        `provider and emitted no record; errorMetrics cannot mark an inference as such, and ` +
        `publishInferredProviders is off`,
    );
  } else if (publishInferred && stats.providerInferred > 0) {
    limitations.push(
      `${stats.providerInferred} call(s) were published with an INFERRED provider name ` +
        `(publishInferredProviders is on); consumers cannot tell these from observed ones`,
    );
  }

  return { source: opts.source, records, stats, limitations };
}

function sum(codes: readonly { count: number }[]): number {
  return codes.reduce((n, c) => n + c.count, 0);
}

/** Highest counts first, capped at the lexicon's array limit. */
function capCodes(codes: readonly ErrorCodeCount[]): { code: string; count: number }[] {
  return [...codes]
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, MAX_CODE_ENTRIES)
    .map((c) => ({ code: c.code, count: c.count }));
}

/** Epoch ms -> the lexicon's MICROseconds (see `prober/aggregate.ts`). */
function toUnixMicro(ms: number): number {
  return Math.round(ms) * 1000;
}
