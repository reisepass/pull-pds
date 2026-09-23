/**
 * OpenRouter as a telemetry source, via the analytics + generation APIs.
 *
 * METHOD. Three analytics queries and one enrichment fetch per errored
 * generation:
 *
 *   Q1  dimensions [provider, finish_reason], no filter
 *       The finish-reason distribution per provider. Its only job is the NULL
 *       bucket - see "THE NULL TRAP" below.
 *   Q2  dimensions [provider, model], no filter
 *       The DENOMINATOR: how many calls each (provider, model) pair actually
 *       served in the window. Bucketed before it reaches a record.
 *   Q3  dimensions [generation_id, provider], filter finish_reason eq error
 *       The errored generations to enrich. Bounded in practice - 24 errors
 *       against 76k successes in a sampled month on the live account.
 *   GET /api/v1/generation?id=<id> for each
 *       Yields provider_name, model, finish_reason, native_finish_reason,
 *       created_at, and provider_responses[] with a per-ATTEMPT
 *       {provider_name, status, latency}.
 *
 * THE ONE THING THIS FILE EXISTS TO GET RIGHT. `provider_responses[].status` is
 * routinely 200 while `finish_reason` is `"error"`. Verified on the live
 * account: all 24 errored generations in one sampled month were
 * `native_finish_reason: "MALFORMED_FUNCTION_CALL"` with
 * `provider_responses[0].status: 200`, and 16 of 19 in an older window were
 * `RECITATION`. Google's service answered every one of them correctly; the MODEL
 * emitted an unusable tool call or refused to recite. Publishing those as
 * provider errors would put "Google is down" into a signed, permanent, public
 * record on the strength of a malformed function call. So an errored generation
 * whose provider attempts were ALL 2xx is classified on its
 * `native_finish_reason`, which `error-classify.ts` maps to the `model` scope
 * and drops from `errors[]`. Only a genuine non-2xx attempt is classified as an
 * HTTP outcome.
 *
 * THE NULL TRAP. `finish_reason` has a NULL bucket - 470 calls in one sampled
 * month, 1783 in another - and it is NOT reachable by any filter operator.
 * Verified against the live API: over a window whose provider x finish_reason
 * breakdown showed 254 NULL rows, `not_in [stop, tool_calls, length, error,
 * content_filter]` returned ZERO rows, and `neq stop` returned counts that
 * excluded the NULLs exactly. `eq null` is rejected outright (400, "Invalid
 * input"). This is ordinary SQL three-valued logic: no comparison matches NULL.
 * The bucket is therefore only visible when `finish_reason` is a DIMENSION,
 * which is what Q1 is for. Those calls cannot be enumerated or classified, so
 * they are counted in the denominator, reported in `limitations`, and never
 * treated as either an error or a success.
 *
 * API CONSTRAINTS, all confirmed live:
 *   - MAX 2 dimensions per query (a 3-dimension query is a hard 400), which is
 *     why the denominator and the finish-reason distribution are separate
 *     queries and cannot be joined into one provider x model x finish_reason.
 *   - Fine-grained queries are capped at a 31-DAY time_range (400 otherwise).
 *   - `request_count` is returned as a STRING and must be parsed.
 *   - Response envelope is doubly nested: `{ data: { data: [...], metadata: {
 *     row_count, truncated } } }`.
 *
 * WHAT THIS SOURCE CANNOT SEE. A failed provider ATTEMPT on a generation that
 * ultimately succeeded - `provider_responses: [{status: 503}, {status: 200}]`
 * with `finish_reason: "stop"` - is real provider-health data and is invisible
 * here: there is no dimension or filter for a provider_response status, and
 * enumerating every generation to look is not viable against six-figure monthly
 * volume. Q3 sees only generations that ended in error. This under-reports
 * provider unavailability and is stated in `limitations` on every run.
 *
 * CREDENTIAL. Requires a MANAGEMENT key; an ordinary inference key gets 403 on
 * the analytics endpoint. Passed in by value from the caller, read from an env
 * var by NAME, and never logged.
 */
import { log } from '../log.js';
import type {
  CollectOptions,
  CollectResult,
  GatewayCollector,
  GatewayObservation,
  GatewayTransport,
} from './types.js';
import { aggregateObservations } from './aggregate.js';

export const OPENROUTER_SOURCE = 'openrouter';

const DEFAULT_BASE_URL = 'https://openrouter.ai';
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The analytics API's own row cap. Q3 asks for this many errored generations;
 * if it comes back full the window was busier than one page and the run says so
 * rather than silently reporting a partial error count.
 */
const QUERY_LIMIT = 500;

/** The API rejects a fine-grained query whose range exceeds this. */
const MAX_WINDOW_DAYS = 31;
const MAX_WINDOW_MS = MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Terminal finish_reason values OpenRouter documents. Used ONLY to describe the
 * NULL bucket in a limitation string - deliberately NOT used as a `not_in`
 * filter, which does not match NULL (see THE NULL TRAP).
 */
const KNOWN_FINISH_REASONS = ['stop', 'tool_calls', 'length', 'error', 'content_filter'];

export interface OpenRouterCollectorOptions {
  /** The MANAGEMENT key's value. Never logged. */
  apiKey: string;
  /** Override for tests or a proxy. */
  baseUrl?: string;
  /** OTel `telemetry.distro.name` for emitted records. */
  distroName: string;
  distroVersion?: string;
  /** See {@link GatewayAggregateOptions.publishInferredProviders}. Off by default. */
  publishInferredProviders?: boolean;
}

interface AnalyticsRow {
  provider?: string | null;
  model?: string | null;
  finish_reason?: string | null;
  generation_id?: string | null;
  request_count?: string | number | null;
}

interface AnalyticsResult {
  rows: AnalyticsRow[];
  truncated: boolean;
}

/** The subset of `/api/v1/generation` this collector reads. */
interface GenerationDetail {
  provider_name?: string | null;
  model?: string | null;
  finish_reason?: string | null;
  native_finish_reason?: string | null;
  provider_responses?: { provider_name?: string | null; status?: number | null }[] | null;
}

export class OpenRouterCollector implements GatewayCollector {
  readonly source = OPENROUTER_SOURCE;

  constructor(private readonly opts: OpenRouterCollectorOptions) {}

  async collect(collectOpts: CollectOptions): Promise<CollectResult> {
    const { windowStartMs, windowEndMs, transport } = collectOpts;
    const timeoutMs = collectOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const limitations: string[] = [];

    // The 31-day cap is the API's, not ours, and a rejected query would look
    // like "no errors" to anything that only checks for a thrown error. Refuse
    // the window up front and emit nothing rather than a false clean bill.
    if (windowEndMs - windowStartMs > MAX_WINDOW_MS) {
      return empty(this.opts, [
        `window spans ${Math.round((windowEndMs - windowStartMs) / 86_400_000)} days; the ` +
          `analytics API caps fine-grained queries at ${MAX_WINDOW_DAYS} days, so no data was ` +
          `collected`,
      ]);
    }

    const timeRange = {
      start: new Date(windowStartMs).toISOString(),
      end: new Date(windowEndMs).toISOString(),
    };
    const query = (body: Record<string, unknown>): Promise<AnalyticsResult> =>
      this.analyticsQuery(transport, timeoutMs, body);

    // Q1 - the finish-reason distribution, for the NULL bucket only.
    const q1 = await query({
      metrics: ['request_count'],
      dimensions: ['provider', 'finish_reason'],
      time_range: timeRange,
      limit: QUERY_LIMIT,
    });
    let nullFinishReasonCalls = 0;
    for (const row of q1.rows) {
      // NULL is the point. An absent or explicitly-null finish_reason is a call
      // that terminated without recording how, and there is no way to ask the
      // API which calls those were.
      if (row.finish_reason === null || row.finish_reason === undefined) {
        nullFinishReasonCalls += toCount(row.request_count);
      }
    }
    if (nullFinishReasonCalls > 0) {
      limitations.push(
        `${nullFinishReasonCalls} call(s) had a NULL finish_reason and could not be classified ` +
          `as success or failure; they are counted in the denominator only. The analytics API ` +
          `cannot filter for them (no operator matches NULL - "eq null" is rejected and ` +
          `"not_in [${KNOWN_FINISH_REASONS.join(', ')}]" returns nothing), so they cannot be ` +
          `enumerated or enriched`,
      );
    }

    // Q2 - the denominator per (provider, model).
    const q2 = await query({
      metrics: ['request_count'],
      dimensions: ['provider', 'model'],
      time_range: timeRange,
      limit: QUERY_LIMIT,
    });
    if (q2.truncated) {
      limitations.push(
        'the (provider, model) volume query was truncated by the API; the denominator is a ' +
          'lower bound and the resulting error rates are overstated',
      );
    }

    // Q3 - the errored generations.
    const q3 = await query({
      metrics: ['request_count'],
      dimensions: ['generation_id', 'provider'],
      filters: [{ field: 'finish_reason', operator: 'eq', value: 'error' }],
      time_range: timeRange,
      limit: QUERY_LIMIT,
    });
    if (q3.truncated || q3.rows.length >= QUERY_LIMIT) {
      limitations.push(
        `the errored-generation query returned the full ${QUERY_LIMIT}-row page; some errors in ` +
          `this window were not read and the published counts are a lower bound`,
      );
    }

    // Enrich. One fetch per errored generation - this is where the model, the
    // native finish reason and the per-attempt provider statuses come from, and
    // therefore where the model-vs-provider distinction is actually made.
    const errorObs: GatewayObservation[] = [];
    const errorGenerationsByPair = new Map<string, number>();
    let unreadable = 0;
    for (const row of q3.rows) {
      const id = typeof row.generation_id === 'string' ? row.generation_id : undefined;
      if (id === undefined) continue;
      const detail = await this.generation(transport, timeoutMs, id);
      if (detail === undefined) {
        unreadable += 1;
        continue;
      }
      const obs = classifyGeneration(detail, row.provider ?? undefined);
      if (obs === undefined) {
        unreadable += 1;
        continue;
      }
      errorObs.push(obs);
      // NUL separator for the same reason as `aggregate.ts`: OpenRouter's
      // provider names contain spaces.
      const pair = `${obs.provider}\u0000${obs.model ?? ''}`;
      errorGenerationsByPair.set(pair, (errorGenerationsByPair.get(pair) ?? 0) + 1);
    }
    if (unreadable > 0) {
      limitations.push(
        `${unreadable} errored generation(s) could not be enriched and were dropped; their ` +
          `provider and error code are unknown`,
      );
    }

    // The denominator, minus the errors we already counted for that pair, so
    // one generation is one observation and the group total stays equal to the
    // request_count the API reported.
    const observations: GatewayObservation[] = [];
    for (const row of q2.rows) {
      const provider = typeof row.provider === 'string' ? row.provider : undefined;
      if (provider === undefined) continue;
      const model = typeof row.model === 'string' && row.model.length > 0 ? row.model : undefined;
      const total = toCount(row.request_count);
      const errored = errorGenerationsByPair.get(`${provider}\u0000${model ?? ''}`) ?? 0;
      const rest = total - errored;
      if (rest > 0) {
        observations.push({
          provider,
          providerAttribution: 'observed',
          ...(model === undefined ? {} : { model }),
          count: rest,
        });
      }
    }
    observations.push(...errorObs);

    limitations.push(
      'provider attempts that failed on a generation which ultimately SUCCEEDED are not visible: ' +
        'the analytics API exposes no dimension or filter for provider_responses[].status, so ' +
        'only generations that terminated in error are read. Provider unavailability is ' +
        'under-reported',
    );

    const result = aggregateObservations(observations, {
      source: this.source,
      windowStartMs,
      windowEndMs,
      distroName: this.opts.distroName,
      ...(this.opts.distroVersion === undefined
        ? {}
        : { distroVersion: this.opts.distroVersion }),
      ...(this.opts.publishInferredProviders === undefined
        ? {}
        : { publishInferredProviders: this.opts.publishInferredProviders }),
      limitations,
    });
    log.info('openrouter collect complete', {
      source: this.source,
      records: result.records.length,
      stats: result.stats,
      limitations: result.limitations.length,
    });
    return result;
  }

  private async analyticsQuery(
    transport: GatewayTransport,
    timeoutMs: number,
    body: Record<string, unknown>,
  ): Promise<AnalyticsResult> {
    const res = await transport({
      url: `${this.opts.baseUrl ?? DEFAULT_BASE_URL}/api/v1/analytics/query`,
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.opts.apiKey}`,
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify(body)),
      timeoutMs,
    });
    if (res.status !== 200) {
      // The body can echo the query but never the key; log the status only.
      log.warn('openrouter analytics query failed', { source: this.source, status: res.status });
      throw new OpenRouterError(`analytics query returned HTTP ${res.status}`);
    }
    const parsed = parseJson(res.body) as
      | { data?: { data?: AnalyticsRow[]; metadata?: { truncated?: boolean } } }
      | undefined;
    // The envelope is `{data: {data: [...], metadata: {...}}}`; a shape change
    // must not read as an empty result set, which would look like "no errors".
    const inner = parsed?.data;
    if (inner === undefined || !Array.isArray(inner.data)) {
      throw new OpenRouterError('analytics query returned an unrecognised envelope');
    }
    return { rows: inner.data, truncated: inner.metadata?.truncated === true };
  }

  /** `undefined` when the generation could not be read; the caller counts it. */
  private async generation(
    transport: GatewayTransport,
    timeoutMs: number,
    id: string,
  ): Promise<GenerationDetail | undefined> {
    const res = await transport({
      url: `${this.opts.baseUrl ?? DEFAULT_BASE_URL}/api/v1/generation?id=${encodeURIComponent(id)}`,
      method: 'GET',
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      timeoutMs,
    });
    if (res.status !== 200) return undefined;
    const parsed = parseJson(res.body) as { data?: GenerationDetail } | undefined;
    return parsed?.data;
  }
}

export class OpenRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

/**
 * One errored generation -> one observation. THE decision this module exists to
 * make (see the module header).
 *
 * A non-2xx provider attempt is an HTTP outcome and is classified as one, keyed
 * on the FIRST failing attempt and attributed to the provider that served it.
 * When every attempt was 2xx the provider's service was healthy and the failure
 * belongs to the model, so it is keyed on `native_finish_reason` - which
 * `error-classify.ts` resolves to the `model` scope and drops from `errors[]`.
 *
 * `finish_reason` is used as the last-resort code only when a generation somehow
 * carries neither a native reason nor any provider response; that lands in the
 * visible `unclassified` bucket rather than being dropped.
 */
export function classifyGeneration(
  detail: GenerationDetail,
  fallbackProvider?: string,
): GatewayObservation | undefined {
  const model = typeof detail.model === 'string' && detail.model.length > 0
    ? detail.model
    : undefined;
  const attempts = Array.isArray(detail.provider_responses) ? detail.provider_responses : [];
  const failed = attempts.find((a) => typeof a.status === 'number' && a.status >= 400);

  if (failed !== undefined) {
    const provider = nonEmpty(failed.provider_name) ?? nonEmpty(detail.provider_name) ?? nonEmpty(fallbackProvider);
    if (provider === undefined) return undefined;
    const status = failed.status as number;
    return {
      provider,
      providerAttribution: 'observed',
      ...(model === undefined ? {} : { model }),
      errorCode: String(status),
      httpStatus: status,
      count: 1,
    };
  }

  const provider = nonEmpty(detail.provider_name) ?? nonEmpty(fallbackProvider);
  if (provider === undefined) return undefined;
  const code =
    nonEmpty(detail.native_finish_reason) ?? nonEmpty(detail.finish_reason) ?? 'error';
  return {
    provider,
    providerAttribution: 'observed',
    ...(model === undefined ? {} : { model }),
    // Lower-cased because the classifier's tables are keyed lower-case and
    // OpenRouter reports these SHOUTING (`MALFORMED_FUNCTION_CALL`).
    errorCode: code.toLowerCase(),
    // Deliberately NO httpStatus: every attempt was 2xx, and handing the
    // classifier a 200 would invite a "not an error" reading of a real
    // model-level failure.
    count: 1,
  };
}

function nonEmpty(v: string | null | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

/** `request_count` comes back as a string; a bad value counts as zero, loudly. */
function toCount(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

function empty(opts: OpenRouterCollectorOptions, limitations: string[]): CollectResult {
  log.warn('openrouter collect produced no data', { source: OPENROUTER_SOURCE, limitations });
  return {
    source: OPENROUTER_SOURCE,
    records: [],
    stats: {
      totalCalls: 0,
      healthErrors: 0,
      accountErrors: 0,
      modelErrors: 0,
      gatewayErrors: 0,
      unclassifiedErrors: 0,
      providerObserved: 0,
      providerInferred: 0,
      providerUnknown: 0,
    },
    limitations,
  };
}
