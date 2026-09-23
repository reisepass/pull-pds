/**
 * LiteLLM as a telemetry source, via the proxy's admin API.
 *
 * Two gaps were known when this was specified. Both are closed here, and the
 * answers are not what the activity endpoint suggests.
 *
 * GAP (a) - "THE PROVIDER IS `unknown`". It is not a configuration problem and
 * it cannot be fixed in `litellm_config.yaml`. The deployed config DOES name
 * providers: `/model/info` reports `custom_llm_provider: "vertex_ai"` for the
 * Gemini models and `"openrouter"` for 180-odd routed models, and
 * `/user/daily/activity` correctly reports `breakdown.providers = {vertex_ai:
 * ...}` on days with only successful traffic. The literal string `"unknown"`
 * appears because LiteLLM writes an EMPTY `custom_llm_provider` on the SpendLogs
 * row for a FAILED call - verified live: every one of 385 failures over 37 days
 * had `custom_llm_provider: ""`, including failures of a model whose successful
 * calls that same week were attributed to `vertex_ai`. The activity endpoint
 * then buckets the empty string as `"unknown"`. So the gap is inherent to
 * LiteLLM's failure-logging path.
 *
 * It is, however, RECOVERABLE, because the failure row carries a second
 * provider field the activity endpoint does not read:
 * `metadata.error_information.llm_provider`, populated whenever the request
 * actually reached a provider (`"vertex_ai_beta"` on all 78 such failures). That
 * is an OBSERVED provider - the source recorded it - not an inference. Only when
 * it too is empty AND an upstream `error_code` proves the request did reach a
 * provider does {@link inferProviderFromModel} fall back to the model slug and
 * the `/model/info` map, and that result is marked INFERRED and, by default,
 * withheld from publication (see `aggregate.ts` RULE 4).
 *
 * GAP (b) - "NO ERROR CODES, ONLY FAILED/SUCCESSFUL COUNTS". The activity
 * endpoint has no codes, correct. `/metrics` is a 404 on this deployment
 * (Prometheus is an enterprise feature). But `/spend/logs/v2` carries the full
 * picture per request: `metadata.error_information` = `{error_code, error_class,
 * llm_provider, error_message, traceback}`, and the endpoint even accepts
 * `error_code` and `status_filter` as server-side query filters (verified:
 * `error_code=429` returns a non-zero total). Publishing the undifferentiated
 * `failed_requests` count would have been badly misleading - the live 37-day
 * breakdown is 306 `RouterRateLimitError`, 76 `NotFoundError` (404), 2
 * `MidStreamFallbackError` (429) and 1 auth `Exception`, i.e. 80% of "failures"
 * are LiteLLM's own router refusing to dispatch, and the provider never saw
 * them.
 *
 * WHERE A GATEWAY-INTERNAL FAILURE GOES. A row with no `llm_provider` AND no
 * `error_code` never reached a provider. It is emitted under the pseudo-provider
 * {@link LITELLM_INTERNAL} with attribution `unknown`, which does two things at
 * once: `error-classify.ts`'s `litellm` table resolves `RouterRateLimitError` to
 * the `gateway` scope so the operator's counters are right, and `aggregate.ts`
 * RULE 3 suppresses the record so no provider is ever named for a request it
 * did not receive.
 *
 * WHY THESE RECORDS HAVE NO MODEL. `/user/daily/activity` breaks down by
 * `providers` and by `models` as SEPARATE maps - it never joins them - so there
 * is no per-(provider, model) denominator. Failure rows do carry a model, but
 * pairing per-model error counts with a per-provider denominator would divide by
 * the wrong number and overstate every rate. Records are therefore emitted at
 * PROVIDER level; the model is read only to infer a provider and to describe
 * what failed in `limitations`.
 */
import { log } from '../log.js';
import { normalizeProvider } from '../genai/error-classify.js';
import { aggregateObservations } from './aggregate.js';
import type {
  CollectOptions,
  CollectResult,
  GatewayCollector,
  GatewayObservation,
  GatewayTransport,
  ProviderAttribution,
} from './types.js';

export const LITELLM_SOURCE = 'litellm';

/**
 * The pseudo-provider for failures of LiteLLM's own routing layer. Chosen so the
 * `litellm` table in `error-classify.ts` is the one consulted; never published,
 * because these observations carry attribution `unknown`.
 */
export const LITELLM_INTERNAL = 'litellm';

const DEFAULT_TIMEOUT_MS = 30_000;
const FAILURE_PAGE_SIZE = 100;
/**
 * Hard cap on failure pages per run. 100 x 100 = 10,000 failures, well past the
 * 385-in-37-days seen live, and it bounds the run against a gateway having a
 * catastrophic day. Hitting it is reported, never silent.
 */
const MAX_FAILURE_PAGES = 100;

/** The activity endpoint's bucket name for an unattributed provider. */
const ACTIVITY_UNKNOWN_PROVIDER = 'unknown';

export interface LiteLlmCollectorOptions {
  /** Proxy base URL, e.g. `https://litellm.example.com`. */
  baseUrl: string;
  /** The admin key's value. Never logged. */
  apiKey: string;
  distroName: string;
  distroVersion?: string;
  publishInferredProviders?: boolean;
}

interface ErrorInformation {
  error_code?: string | null;
  error_class?: string | null;
  llm_provider?: string | null;
}

interface SpendLogRow {
  model?: string | null;
  model_group?: string | null;
  custom_llm_provider?: string | null;
  status?: string | null;
  metadata?: { error_information?: ErrorInformation | null } | null;
}

interface ActivityMetrics {
  successful_requests?: number | null;
  failed_requests?: number | null;
  api_requests?: number | null;
}

interface ActivityDay {
  breakdown?: { providers?: Record<string, { metrics?: ActivityMetrics }> | null } | null;
}

export class LiteLlmCollector implements GatewayCollector {
  readonly source = LITELLM_SOURCE;

  constructor(private readonly opts: LiteLlmCollectorOptions) {}

  async collect(collectOpts: CollectOptions): Promise<CollectResult> {
    const { windowStartMs, windowEndMs, transport } = collectOpts;
    const timeoutMs = collectOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const limitations: string[] = [];
    const observations: GatewayObservation[] = [];

    // The model -> provider map, for the INFERRED fallback only. Config-derived
    // rather than guessed from the slug's shape, so it is at least the same
    // mapping the proxy itself routes by. Failing to read it is not fatal.
    let modelProviders: Map<string, string>;
    try {
      modelProviders = await this.modelProviders(transport, timeoutMs);
    } catch {
      modelProviders = new Map();
      limitations.push(
        '/model/info could not be read; provider inference for failures with no recorded ' +
          'provider fell back to the model slug alone',
      );
    }

    // Failures first: they give the per-provider error counts AND the counts
    // that have to be subtracted from the denominator below.
    const failuresByProvider = new Map<string, number>();
    const classesSeen = new Map<string, number>();
    let failureRows = 0;
    let pages = 0;
    let hitPageCap = false;
    for (let page = 1; page <= MAX_FAILURE_PAGES; page++) {
      const body = await this.spendLogFailures(
        transport,
        timeoutMs,
        windowStartMs,
        windowEndMs,
        page,
      );
      pages = page;
      for (const row of body.rows) {
        const obs = classifyFailureRow(row, modelProviders);
        observations.push(obs);
        failureRows += 1;
        // Keyed on the CANONICAL name, because the denominator below comes from
        // a different endpoint that spells the same provider differently -
        // `/spend/logs/v2` says `vertex_ai_beta` where `/user/daily/activity`
        // says `vertex_ai`. Subtracting without folding both onto one name
        // would count every upstream failure twice.
        const key = normalizeProvider(obs.provider);
        failuresByProvider.set(key, (failuresByProvider.get(key) ?? 0) + 1);
        const cls = nonEmpty(row.metadata?.error_information?.error_class) ?? 'unknown-class';
        classesSeen.set(cls, (classesSeen.get(cls) ?? 0) + 1);
      }
      if (page >= body.totalPages) break;
      if (page === MAX_FAILURE_PAGES) hitPageCap = true;
    }
    if (hitPageCap) {
      limitations.push(
        `stopped after ${MAX_FAILURE_PAGES} pages of failures (${MAX_FAILURE_PAGES * FAILURE_PAGE_SIZE} rows); ` +
          `the window had more and the published counts are a lower bound`,
      );
    }

    // The denominator, per provider, from the pre-aggregated activity endpoint.
    // Its `unknown` bucket is deliberately skipped: those requests are the same
    // failures already counted above, and adding them would double-count.
    let unattributedActivity = 0;
    try {
      const days = await this.activity(transport, timeoutMs, windowStartMs, windowEndMs);
      const totals = new Map<string, number>();
      for (const day of days) {
        for (const [provider, entry] of Object.entries(day.breakdown?.providers ?? {})) {
          const calls = toCount(entry.metrics?.api_requests);
          if (provider === ACTIVITY_UNKNOWN_PROVIDER) {
            unattributedActivity += calls;
            continue;
          }
          const key = normalizeProvider(provider);
          totals.set(key, (totals.get(key) ?? 0) + calls);
        }
      }
      for (const [provider, calls] of totals) {
        // A failure already emitted for this provider is one of these calls,
        // not an extra one.
        const rest = calls - (failuresByProvider.get(provider) ?? 0);
        if (rest > 0) {
          observations.push({ provider, providerAttribution: 'observed', count: rest });
        }
      }
    } catch {
      limitations.push(
        '/user/daily/activity could not be read; there is no request-volume denominator for ' +
          'this window and every requestVolumeBucket is derived from failures alone, which ' +
          'overstates error rates',
      );
    }
    if (unattributedActivity > 0) {
      // Measured live: 1094 calls in this bucket against 385 failures over the
      // same window, so it is NOT only the failures. LiteLLM writes an empty
      // custom_llm_provider on every failed call AND on successful calls routed
      // through a deployment whose config sets none, and the two are
      // indistinguishable here. Excluding the whole bucket is the conservative
      // choice - it shrinks the denominator, which OVERSTATES the error rate
      // rather than flattering it - but it is a real distortion and is stated
      // as one.
      limitations.push(
        `${unattributedActivity} call(s) sat in the activity endpoint's "unknown" provider ` +
          `bucket and were excluded from the denominator, against ${failureRows} failure(s) ` +
          `read from /spend/logs/v2 and counted separately. The remainder is traffic whose ` +
          `provider LiteLLM did not record, so the denominator is a lower bound and every ` +
          `error rate derived from it is overstated`,
      );
    }

    if (classesSeen.size > 0) {
      const summary = [...classesSeen.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([cls, n]) => `${cls}=${n}`)
        .join(', ');
      limitations.push(`failure classes read from /spend/logs/v2 over ${pages} page(s): ${summary}`);
    }
    limitations.push(
      'records are provider-level and carry no model: /user/daily/activity breaks down by ' +
        'providers and by models as separate maps and never joins them, so no per-model ' +
        'denominator exists',
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
    log.info('litellm collect complete', {
      source: this.source,
      records: result.records.length,
      stats: result.stats,
      limitations: result.limitations.length,
    });
    return result;
  }

  private async get(
    transport: GatewayTransport,
    timeoutMs: number,
    path: string,
  ): Promise<unknown> {
    const res = await transport({
      url: `${this.opts.baseUrl.replace(/\/$/, '')}${path}`,
      method: 'GET',
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      timeoutMs,
    });
    if (res.status !== 200) {
      log.warn('litellm request failed', { source: this.source, path, status: res.status });
      throw new LiteLlmError(`GET ${path} returned HTTP ${res.status}`);
    }
    try {
      return JSON.parse(new TextDecoder().decode(res.body));
    } catch {
      throw new LiteLlmError(`GET ${path} returned unparseable JSON`);
    }
  }

  private async spendLogFailures(
    transport: GatewayTransport,
    timeoutMs: number,
    startMs: number,
    endMs: number,
    page: number,
  ): Promise<{ rows: SpendLogRow[]; totalPages: number }> {
    // The endpoint wants `YYYY-MM-DD HH:MM:SS`, not an ISO instant.
    const q = new URLSearchParams({
      start_date: toSpendLogTime(startMs),
      end_date: toSpendLogTime(endMs),
      page: String(page),
      page_size: String(FAILURE_PAGE_SIZE),
      status_filter: 'failure',
    });
    const body = (await this.get(transport, timeoutMs, `/spend/logs/v2?${q.toString()}`)) as
      | { data?: SpendLogRow[]; total_pages?: number }
      | undefined;
    if (body === undefined || !Array.isArray(body.data)) {
      throw new LiteLlmError('/spend/logs/v2 returned an unrecognised envelope');
    }
    return { rows: body.data, totalPages: toCount(body.total_pages) || 1 };
  }

  private async activity(
    transport: GatewayTransport,
    timeoutMs: number,
    startMs: number,
    endMs: number,
  ): Promise<ActivityDay[]> {
    const q = new URLSearchParams({
      start_date: toIsoDate(startMs),
      end_date: toIsoDate(endMs),
      page_size: '100',
    });
    const body = (await this.get(transport, timeoutMs, `/user/daily/activity?${q.toString()}`)) as
      | { results?: ActivityDay[] }
      | undefined;
    if (body === undefined || !Array.isArray(body.results)) {
      throw new LiteLlmError('/user/daily/activity returned an unrecognised envelope');
    }
    return body.results;
  }

  /** `model_name` -> `custom_llm_provider`, from the proxy's own routing config. */
  private async modelProviders(
    transport: GatewayTransport,
    timeoutMs: number,
  ): Promise<Map<string, string>> {
    const body = (await this.get(transport, timeoutMs, '/model/info')) as
      | { data?: { model_name?: string; litellm_params?: { custom_llm_provider?: string } }[] }
      | undefined;
    const map = new Map<string, string>();
    for (const entry of body?.data ?? []) {
      const name = nonEmpty(entry.model_name);
      const provider = nonEmpty(entry.litellm_params?.custom_llm_provider);
      if (name !== undefined && provider !== undefined) map.set(name, provider);
    }
    return map;
  }
}

export class LiteLlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiteLlmError';
  }
}

/**
 * One `/spend/logs/v2` failure row -> one observation.
 *
 * Provider, in descending order of trust:
 *   1. `metadata.error_information.llm_provider` - OBSERVED. Present exactly
 *      when the request reached a provider.
 *   2. the row's `custom_llm_provider` - OBSERVED. Empty on every failure seen
 *      live, but it is the documented field and costs nothing to honour.
 *   3. the model slug / `/model/info` map - INFERRED, and withheld by default.
 *   4. nothing reached a provider -> {@link LITELLM_INTERNAL} with attribution
 *      `unknown`, which classifies under the `litellm` table and publishes no
 *      record.
 *
 * Code: `error_code` when present, because that is the UPSTREAM status (`"404"`,
 * `"429"`) and classifies against the real provider's table; otherwise
 * `error_class`, LiteLLM's normalized exception name, which the `litellm` table
 * maps. `error_class` alone would be wrong for `MidStreamFallbackError`, whose
 * name says nothing about the upstream cause - the `error_code` on it was a real
 * 429 from `vertex_ai_beta`.
 */
export function classifyFailureRow(
  row: SpendLogRow,
  modelProviders: ReadonlyMap<string, string>,
): GatewayObservation {
  const info = row.metadata?.error_information ?? {};
  const code = nonEmpty(info.error_code);
  const cls = nonEmpty(info.error_class);
  const model = nonEmpty(row.model_group) ?? nonEmpty(row.model);

  let provider = nonEmpty(info.llm_provider) ?? nonEmpty(row.custom_llm_provider);
  let attribution: ProviderAttribution = 'observed';
  if (provider === undefined && code !== undefined) {
    // INFERENCE IS GATED ON EVIDENCE THAT A PROVIDER WAS REACHED. An upstream
    // `error_code` means something upstream answered, so the model's configured
    // provider is a reasonable guess at which one. With no code and no provider
    // the request never left the gateway - `RouterRateLimitError` is exactly
    // that case, and it still carries a `model_group`, so inferring from the
    // model would attribute the gateway's own refusal to dispatch to a provider
    // that never received the request. That is the misattribution this whole
    // module is built to avoid, so the model slug is not consulted here.
    const inferred = inferProviderFromModel(model, modelProviders);
    if (inferred !== undefined) {
      provider = inferred;
      attribution = 'inferred';
    }
  }
  if (provider === undefined) {
    provider = LITELLM_INTERNAL;
    attribution = 'unknown';
  }

  const errorCode = code ?? cls ?? 'unknown';
  const httpStatus = code !== undefined && /^\d{3}$/.test(code) ? Number(code) : undefined;
  return {
    provider,
    providerAttribution: attribution,
    errorCode: errorCode.toLowerCase(),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    count: 1,
  };
}

/**
 * Derive a provider from a model identifier. The `/model/info` map is consulted
 * first (it is the proxy's own routing config, so it is the same answer LiteLLM
 * would give), then the `provider/model` slug prefix LiteLLM uses throughout
 * (`vertex_ai/gemini-3.5-flash`, `openrouter/openai/gpt-5.2-pro`).
 *
 * Every result is an INFERENCE, never an observation, and the caller marks it as
 * such - a model configured against one provider today can be repointed at
 * another tomorrow without any record of the change on the failure row.
 */
export function inferProviderFromModel(
  model: string | undefined,
  modelProviders: ReadonlyMap<string, string>,
): string | undefined {
  if (model === undefined) return undefined;
  const configured = modelProviders.get(model);
  if (configured !== undefined) return configured;
  const slash = model.indexOf('/');
  if (slash > 0) {
    const prefix = model.slice(0, slash);
    // Only treat the prefix as a provider if the config knows it as one;
    // `openai/gpt-4o` and `qwen/qwen3-plus` have the same shape but the second
    // prefix is a model family, not a provider.
    for (const p of modelProviders.values()) {
      if (p === prefix) return prefix;
    }
  }
  return undefined;
}

function nonEmpty(v: string | null | undefined): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function toCount(v: number | string | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** `/spend/logs/v2` wants `YYYY-MM-DD HH:MM:SS`, not an ISO instant. */
function toSpendLogTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
