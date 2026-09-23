/**
 * Collecting provider error telemetry from an LLM GATEWAY, behind one interface.
 *
 * The prober (`src/prober/`) generates its own traffic and reads the HTTP
 * outcome. A gateway collector does the opposite: it reads traffic that already
 * happened, out of a router that fronts many providers. That inverts three
 * things, and this interface exists to keep them explicit.
 *
 * 1. PROVIDER ATTRIBUTION IS NOT GIVEN, IT IS RECOVERED. A prober knows exactly
 *    which provider it called. A gateway may or may not have recorded it - the
 *    live LiteLLM deployment stores an empty `custom_llm_provider` on every
 *    failed call, which is why its activity endpoint reports the provider as the
 *    literal string "unknown". So every observation carries
 *    {@link ProviderAttribution} saying whether the provider was OBSERVED in the
 *    data or INFERRED from a model slug, and an inferred attribution is never
 *    presented as an observed one.
 *
 * 2. NOT EVERY FAILURE IS THE PROVIDER'S. A gateway sees model-level failures on
 *    a healthy service and failures of its own routing layer that never reached
 *    a provider at all. Both are classified out (`model` / `gateway` in
 *    `error-classify.ts`) rather than published as provider health.
 *
 * 3. THE DENOMINATOR IS REAL. A prober's request volume is "how many probes did
 *    I run"; a gateway's is genuine production traffic, which is exactly the
 *    competitively sensitive number USAGE-STATS-DESIGN.md keeps out of the
 *    errors tier. It is therefore ALWAYS bucketed via `bucketRequestVolume` and
 *    the exact count never leaves {@link CollectResult}.
 *
 * The network seam mirrors `ProbeTransport` in `src/prober/probe.ts` and
 * `XrpcTransport` in `src/prober/publish.ts`: one injected function, so no test
 * in the suite opens a socket and no fixture holds a real credential.
 */
import type { RequestVolumeBucket } from '../genai/volume.js';
import type { TelemetryRecord } from '../prober/publish.js';

/** One HTTP round trip to a gateway's management/analytics API. */
export interface GatewayHttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  /** JSON request body. Absent for a GET. */
  body?: Uint8Array;
  timeoutMs: number;
}

export interface GatewayHttpResponse {
  status: number;
  /** Lower-cased response headers. */
  headers: Map<string, string>;
  body: Uint8Array;
}

/**
 * The single seam between a collector and the network. Injected everywhere; the
 * production implementation is `guardedGatewayTransport` in `transport.ts`,
 * which routes through `src/net/guarded-fetch.ts`.
 */
export type GatewayTransport = (req: GatewayHttpRequest) => Promise<GatewayHttpResponse>;

/**
 * How the provider name on an observation was arrived at. This rides all the way
 * into {@link CollectResult} because "we saw it" and "we guessed it from a model
 * slug" are different claims, and a dataset that conflates them is worse than
 * one that admits the gap.
 */
export type ProviderAttribution =
  /** The source recorded the provider explicitly. */
  | 'observed'
  /** Derived from a model slug (e.g. `vertex_ai/gemini-3.5-flash` -> gcp.gemini). */
  | 'inferred'
  /** The source recorded nothing and nothing could be derived. */
  | 'unknown';

/** The provider name used when attribution failed entirely. */
export const UNKNOWN_PROVIDER = 'unknown';

/**
 * One (provider, model, outcome) tally read out of a gateway. Sources hand back
 * these; `aggregate.ts` turns them into records. `count` exists because sources
 * differ in granularity - OpenRouter's analytics API returns pre-aggregated
 * counts per (finish_reason, provider), LiteLLM returns one row per request -
 * and normalising to "always 1" would mean fabricating rows we never saw.
 */
export interface GatewayObservation {
  /** Normalised `gen_ai.provider.name`, or {@link UNKNOWN_PROVIDER}. */
  provider: string;
  providerAttribution: ProviderAttribution;
  /** `gen_ai.request.model`, when the source records a model dimension. */
  model?: string;
  /**
   * The provider error-code / error-type string. ABSENT means this tally counts
   * SUCCESSFUL calls, which are still needed - they are the denominator.
   */
  errorCode?: string;
  /** HTTP status, when known. The classifier's weak secondary signal. */
  httpStatus?: number;
  /** How many calls this tally represents. Always >= 1. */
  count: number;
}

/** Per-source counters. Local only; drives logging, never published. */
export interface CollectStats {
  /** Total calls observed in the window, errors included. The exact denominator. */
  totalCalls: number;
  healthErrors: number;
  /** Account-scoped, dropped before the record was built. */
  accountErrors: number;
  /** Model-level failures on a healthy service, dropped. */
  modelErrors: number;
  /** The gateway's own routing failures, dropped. */
  gatewayErrors: number;
  unclassifiedErrors: number;
  /** How many observed calls carried an OBSERVED provider name. */
  providerObserved: number;
  /** ... an INFERRED one. */
  providerInferred: number;
  /** ... none at all. Records for these are suppressed, see `aggregate.ts`. */
  providerUnknown: number;
}

/**
 * What a collector returns. `records` is ready to hand to a `Publisher`;
 * everything else is for the operator's logs.
 */
export interface CollectResult {
  /** Stable identifier for logs and tests, e.g. `openrouter`. */
  source: string;
  records: TelemetryRecord[];
  stats: CollectStats;
  /**
   * Human-readable limitations that apply to THIS run - a truncated result set,
   * an unauthorised endpoint, a provider that could not be attributed. Logged at
   * warn level by the caller. Empty means the run was clean.
   *
   * A collector that cannot produce a trustworthy signal reports it here and
   * emits no record, rather than emitting a misleading one.
   */
  limitations: string[];
}

export interface CollectOptions {
  /** Window start, epoch ms. */
  windowStartMs: number;
  /** Window end, epoch ms. */
  windowEndMs: number;
  /** Outbound HTTP. */
  transport: GatewayTransport;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/**
 * A gateway telemetry source. One implementation per gateway; the daemon holds
 * a list of them and knows nothing about any individual API.
 */
export interface GatewayCollector {
  readonly source: string;
  collect(opts: CollectOptions): Promise<CollectResult>;
}

/** Re-exported so callers do not need a second import for the bucket type. */
export type { RequestVolumeBucket };
