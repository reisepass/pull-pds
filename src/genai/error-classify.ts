/**
 * Health-vs-account error classification for LLM-provider telemetry (OTEL-TASK
 * Req A). This is the semantic core of the dataset.
 *
 * INCLUDE (health): errors that are a property of the PROVIDER'S health, a
 * shared signal every consumer cares about - throttling/rate limiting, hard
 * backend failures (500/502/503/504), provider overload (e.g. Anthropic 529),
 * timeouts and upstream capacity failures.
 *
 * EXCLUDE (account): errors that are a property of YOUR account or request,
 * noise to everyone else and a leak of your account state - out of credits,
 * insufficient quota, billing/payment failures, invalid/expired/revoked API
 * keys, auth/authorization failures, account suspension, per-account spend caps,
 * malformed requests, context-length-exceeded, unsupported parameters, and
 * content-policy refusals (policy, not availability).
 *
 * THE TRAP: HTTP status ALONE cannot classify this. OpenAI returns 429 for BOTH
 * `rate_limit_exceeded` (provider throttling - INCLUDE) and `insufficient_quota`
 * (your account is out of money - EXCLUDE). Identical status, opposite meaning.
 * So classification keys on the provider's error CODE / error-type string first,
 * with HTTP status as a secondary signal only.
 *
 * NEVER SILENTLY DROP. A code the table does not recognise is classified
 * `unclassified`, not dropped - if a provider renames an error code it must
 * surface in the visible `unclassified[]` bucket, not quietly vanish from the
 * health signal.
 *
 * TWO MORE SCOPES, ADDED FOR GATEWAY SOURCES (`src/gateway/`). An active prober
 * only ever sees "I sent a request, here is the HTTP outcome", so health/account
 * covered it. A GATEWAY (OpenRouter, LiteLLM, OmniRoute) sits in front of many
 * providers and sees two further kinds of failure that are neither:
 *
 *   - `model` - the provider's SERVICE answered fine (HTTP 2xx) but the MODEL
 *     failed to produce usable output: a malformed tool call, a truncated or
 *     refused generation. Verified live on OpenRouter: 24/24 generations with
 *     `finish_reason: "error"` carried `native_finish_reason:
 *     "MALFORMED_FUNCTION_CALL"` and `provider_responses[0].status: 200`.
 *     Reporting those as provider downtime would be flatly wrong - the provider
 *     was up. ERROR-CLASSIFICATION.md already draws this line for content-policy
 *     refusals ("policy, not availability"); this is the same line.
 *   - `gateway` - the GATEWAY's own routing layer failed before any provider was
 *     reached: every deployment in cooldown, no candidate left in the fallback
 *     chain, a router-level budget cap. Verified live on LiteLLM: 306/386
 *     failures were `RouterRateLimitError` "No deployments available for
 *     selected model ... cooldown_list=[...]", which the provider never saw.
 *     Attributing that to the provider would manufacture an outage.
 *
 * Neither enters `errors[]`. Both are counted locally and folded into the
 * record's `totalErrorsAllScopes`, so "something failed here" still surfaces
 * without libelling a provider that was working.
 *
 * The mapping lives in DATA (the tables below), not scattered conditionals, so
 * adding a provider or code is a data change. Sources for every string are cited
 * in ERROR-CLASSIFICATION.md; all were verified against the providers' own API
 * docs / SDK error classes and LiteLLM's normalization, 2026-07.
 */

export type ErrorClass = 'health' | 'account' | 'model' | 'gateway' | 'unclassified';

/** A provider error code/type string mapped to its classification. */
type CodeTable = Record<string, ErrorClass>;

/**
 * Per-provider exact code/type strings. Keys are the provider's error `code` /
 * `type` string (or exception name for Bedrock), lowercased for lookup. HTTP
 * status is deliberately NOT the key (see the 429 trap above).
 *
 * Provider keys are the OTel gen_ai.provider.name values where they exist
 * (openai, anthropic, aws.bedrock, azure.ai.openai, gcp.gemini/gcp.vertex_ai),
 * plus `litellm` for LiteLLM's normalized exception-class names.
 */
const PROVIDER_TABLES: Record<string, CodeTable> = {
  openai: {
    // health
    rate_limit_exceeded: 'health', // 429 throttle
    server_error: 'health', // 500
    // account (the 429 that is NOT health)
    insufficient_quota: 'account', // 429 out of money
    invalid_api_key: 'account', // 401
    invalid_request_error: 'account', // 400 user error
    context_length_exceeded: 'account', // 400
    content_policy_violation: 'account', // 400 policy
    content_filter: 'account',
    invalid_organization: 'account',
    account_deactivated: 'account',
  },
  anthropic: {
    // health (error.type strings from the Anthropic API errors doc)
    overloaded_error: 'health', // 529 capacity
    rate_limit_error: 'health', // 429 throttle
    api_error: 'health', // 500
    timeout_error: 'health', // 504
    // account
    authentication_error: 'account', // 401
    permission_error: 'account', // 403
    billing_error: 'account', // 402
    invalid_request_error: 'account', // 400
    not_found_error: 'account', // 404
    request_too_large: 'account', // 413
  },
  'aws.bedrock': {
    // health (exception NAMEs; note two health cases share 429)
    throttlingexception: 'health', // 429 throttle
    modelnotreadyexception: 'health', // 429 cold-start/capacity
    modeltimeoutexception: 'health', // 408 timeout
    modelerrorexception: 'health', // 424 model processing error
    internalserverexception: 'health', // 500
    serviceunavailableexception: 'health', // 503
    // account (note ServiceQuotaExceeded is 400, NOT 429)
    servicequotaexceededexception: 'account', // 400 quota
    accessdeniedexception: 'account', // 403 auth
    validationexception: 'account', // 400 malformed
    resourcenotfoundexception: 'account', // 404
  },
  'azure.ai.openai': {
    // Azure reuses the OpenAI error schema; add Azure-specific strings.
    deploymentnotfound: 'account', // 404 config
    responsibleaipolicyviolation: 'account', // content filter
    content_filter: 'account',
    content_policy_violation: 'account',
    invalid_api_key: 'account',
    insufficient_quota: 'account',
    rate_limit_exceeded: 'health',
  },
  'gcp.gemini': {
    // canonical google.rpc.Code status strings
    unavailable: 'health', // 503 overloaded/down
    internal: 'health', // 500
    deadline_exceeded: 'health', // 504 timeout
    cancelled: 'health', // 499 transient
    permission_denied: 'account', // 403 auth
    invalid_argument: 'account', // 400 malformed
    failed_precondition: 'account', // 400 billing/region
    not_found: 'account', // 404
    unauthenticated: 'account', // 401
    // RESOURCE_EXHAUSTED conflates rate-limit (health) and quota (account); the
    // status string alone cannot disambiguate, so it is left to HTTP/message
    // fallback and, failing that, unclassified. Deliberately NOT listed here.
  },
  litellm: {
    // LiteLLM normalized exception-class names (it subclasses the OpenAI SDK
    // classes). NOTE: LiteLLM's RateLimitError does NOT split OpenAI's
    // insufficient_quota out of 429, so a bare RateLimitError is ambiguous;
    // prefer the underlying provider code when available. Listed as health as
    // the common case, but the publisher SHOULD pass the provider code.
    ratelimiterror: 'health',
    internalservererror: 'health',
    serviceunavailableerror: 'health',
    badgatewayerror: 'health',
    timeout: 'health',
    apiconnectionerror: 'health',
    authenticationerror: 'account',
    permissiondeniederror: 'account',
    badrequesterror: 'account',
    contextwindowexceedederror: 'account',
    contentpolicyviolationerror: 'account',
    rejectedrequesterror: 'account',
    notfounderror: 'account',
    unprocessableentityerror: 'account',
    budgetexceedederror: 'account', // LiteLLM-internal budget cap
    // GATEWAY-INTERNAL. `RouterRateLimitError` is NOT a provider throttle: its
    // message is "No deployments available for selected model, Try again in N
    // seconds ... cooldown_list=[...]" - LiteLLM's own router refusing to
    // dispatch because every deployment it knows about is in local cooldown.
    // The provider never received the request and must not be charged for it.
    // It is listed here rather than left unclassified precisely because the
    // NAME contains "RateLimit" and would otherwise invite a health reading.
    routerratelimiterror: 'gateway',
    // Every candidate in the fallback chain was exhausted. Same reasoning.
    nodeploymentsavailable: 'gateway',
    // A mid-stream failure that triggered LiteLLM's fallback. The name says
    // nothing about the upstream cause, so it is deliberately NOT mapped:
    // publishers pass `error_information.error_code` (the real upstream status)
    // and let that classify. Observed live carrying a 429 from vertex_ai_beta.
  },
};

/**
 * MODEL-LEVEL failure codes: the provider's service answered (HTTP 2xx) but the
 * model did not produce usable output. Provider-independent, because these are
 * finish-reason strings rather than error codes - the same string means the same
 * thing whichever provider served it.
 *
 * Consulted only when the caller has already established there was no HTTP-level
 * failure (see `classifyError`'s ordering), so a provider that returns 503 AND a
 * finish reason still classifies on the 503.
 *
 * `MALFORMED_FUNCTION_CALL` is the verified case: on the live OpenRouter account
 * every `finish_reason: "error"` generation in the sampled window carried it with
 * `provider_responses[].status: 200`. `SAFETY` / `RECITATION` / `BLOCKLIST` /
 * `PROHIBITED_CONTENT` / `SPII` are Gemini's other terminal FinishReason values;
 * they are content-policy outcomes, which ERROR-CLASSIFICATION.md already treats
 * as "policy, not availability".
 */
const MODEL_LEVEL_CODES: CodeTable = {
  malformed_function_call: 'model',
  safety: 'model',
  recitation: 'model',
  blocklist: 'model',
  prohibited_content: 'model',
  spii: 'model',
  image_safety: 'model',
  unexpected_tool_call: 'model',
  no_content: 'model',
  other: 'model', // Gemini's catch-all terminal FinishReason
};

/**
 * TRANSPORT-level failure codes, which belong to no single provider: the
 * request never produced an HTTP response at all, so there is no provider error
 * code to key on. Consulted only AFTER the per-provider table, so a provider
 * that happens to define one of these strings (Anthropic's `timeout_error` is a
 * different string, but a future provider might collide) always wins.
 *
 * Both are health per ERROR-CLASSIFICATION.md: "timeouts and upstream capacity
 * failures" are explicitly INCLUDE, and LiteLLM's `Timeout` /
 * `APIConnectionError` normalized classes are both H. A caller reaching the
 * provider's endpoint and getting nothing back is the same shared availability
 * signal as a 503.
 *
 * DELIBERATELY only two codes. A finer split (dns_failure, tls_error, ...)
 * would be false precision: from one vantage point a DNS or TLS failure is
 * indistinguishable from the *observer's* own network being broken, and this
 * table has no way to tell those apart. Everything that is not a timeout
 * collapses into `connection_error`, which is what LiteLLM does too. Consumers
 * should read a single publisher's transport errors as "this observer could not
 * reach the provider", and only correlated reports across publishers as
 * "the provider is unreachable".
 */
const TRANSPORT_CODES: CodeTable = {
  timeout: 'health',
  connection_error: 'health',
};

/** Aliases so a caller can pass gen_ai.provider.name variants or common names. */
const PROVIDER_ALIASES: Record<string, string> = {
  'azure.ai.inference': 'azure.ai.openai',
  azure: 'azure.ai.openai',
  azureopenai: 'azure.ai.openai',
  bedrock: 'aws.bedrock',
  'amazon.bedrock': 'aws.bedrock',
  // OpenRouter's display name, with a SPACE. Without this a live collect files
  // records under the provider name "amazon bedrock", which is neither the OTel
  // name nor anything the Bedrock table can classify.
  'amazon bedrock': 'aws.bedrock',
  google: 'gcp.gemini',
  gemini: 'gcp.gemini',
  'gcp.vertex_ai': 'gcp.gemini',
  'gcp.gen_ai': 'gcp.gemini',
  vertex_ai: 'gcp.gemini',
  vertexai: 'gcp.gemini',
  // LiteLLM reports the Vertex Gemini route as `vertex_ai_beta` in
  // `error_information.llm_provider` (observed live). Same provider.
  vertex_ai_beta: 'gcp.gemini',
  'google ai studio': 'gcp.gemini', // OpenRouter's display name for the AI Studio route
  'google vertex': 'gcp.gemini', // OpenRouter's display name for the Vertex route
};

/**
 * HTTP-status secondary fallback, used ONLY when the code string is unknown for
 * the provider. 5xx and 408/429 lean health; the ambiguous 429 (which could be a
 * quota problem) and 4xx auth/billing lean account. This is a weak signal by
 * design: it is why the code string is primary.
 */
function classifyByStatus(httpStatus: number | undefined): ErrorClass {
  if (httpStatus === undefined) return 'unclassified';
  if (httpStatus >= 500) return 'health'; // 500/502/503/504
  if (httpStatus === 408) return 'health'; // request timeout
  if (httpStatus === 529) return 'health'; // non-standard overload
  // 429 is deliberately NOT auto-health here: it may be insufficient_quota.
  // 401/402/403/404/413/422 and a bare 429/400 are left unclassified so an
  // unrecognised code never silently counts as either bucket on status alone.
  return 'unclassified';
}

/**
 * Fold a provider name or alias onto its canonical `gen_ai.provider.name`.
 *
 * Exported (rather than kept private to the classifier) because gateway sources
 * need the SAME mapping for a second purpose: a gateway reports the provider as
 * a human display string - OpenRouter says `"Google AI Studio"`, LiteLLM says
 * `"vertex_ai_beta"` - and that string has to land in the record's
 * `gen_ai.provider.name` field, not just drive a table lookup. Sharing one
 * function means a record can never be filed under a name the classifier would
 * not recognise.
 */
export function normalizeProvider(provider: string): string {
  const p = provider.trim().toLowerCase();
  return PROVIDER_ALIASES[p] ?? p;
}

/**
 * Classify one provider error into 'health' | 'account' | 'unclassified'.
 *
 * @param provider  the provider name (gen_ai.provider.name value or an alias)
 * @param code      the provider's error code / error-type string (or exception
 *                  name). Case-insensitive. This is the PRIMARY signal.
 * @param httpStatus optional HTTP status, a SECONDARY fallback only used when the
 *                  code is unknown for the provider.
 */
export function classifyError(
  provider: string,
  code: string,
  httpStatus?: number,
): ErrorClass {
  const table = PROVIDER_TABLES[normalizeProvider(provider)];
  const key = code.trim().toLowerCase();
  const hit = table?.[key];
  if (hit) return hit;
  // No HTTP response at all (timeout / connection failure). Provider-independent,
  // and checked after the provider table so a provider-specific meaning wins.
  const transport = TRANSPORT_CODES[key];
  if (transport) return transport;
  // The model finished badly on a healthy service. Checked after the provider
  // table (a provider-specific meaning wins) and after transport (a request that
  // never landed has no finish reason), so this only catches codes that really
  // are finish-reason strings.
  const modelLevel = MODEL_LEVEL_CODES[key];
  if (modelLevel) return modelLevel;
  // The code itself may be a bare HTTP status string ("500", "503", "529") -
  // the lexicon permits status-shaped codes. Classify those by the status
  // (5xx/408/529 health; a bare "429" stays ambiguous -> unclassified, which is
  // the whole point: 429 alone cannot be told apart from insufficient_quota).
  if (/^\d{3}$/.test(key)) return classifyByStatus(Number(key));
  // Unknown code for this provider: try the weak HTTP-status fallback, else
  // unclassified. NEVER silently drop.
  return classifyByStatus(httpStatus);
}

export interface ErrorCodeCount {
  code: string;
  count: number;
  /** Optional HTTP status to aid classification when the code is ambiguous. */
  httpStatus?: number;
}

export interface PartitionedErrors {
  /** Provider-health codes: the shared availability signal. INCLUDE in records. */
  health: ErrorCodeCount[];
  /** Account-scoped codes: filtered out BEFORE signing. Never enter a record. */
  account: ErrorCodeCount[];
  /**
   * Model-level failures on a healthy service (2xx + a bad finish reason).
   * Dropped from `errors[]` - the provider was up, and saying otherwise would
   * report a model refusal as provider downtime.
   */
  model: ErrorCodeCount[];
  /**
   * The gateway's own routing layer failed before any provider was reached.
   * Dropped from `errors[]` - the provider never saw the request.
   */
  gateway: ErrorCodeCount[];
  /** Codes the table did not recognise: kept VISIBLE, never dropped. */
  unclassified: ErrorCodeCount[];
}

/**
 * Partition a window's error codes into the five buckets. The publisher uses
 * this to build a signed record: `health` goes into `errors[]`, `unclassified`
 * into the visible `unclassified[]` bucket, and `account` / `model` / `gateway`
 * are DROPPED before the record is built - account because those codes must
 * never enter a signed record at all (a privacy property as well as a
 * data-quality one), model and gateway because neither is a statement about the
 * provider's availability. All five counts are still returned to the caller, so
 * a dropped failure is visible locally and can be folded into
 * `totalErrorsAllScopes` rather than vanishing.
 */
export function partitionErrors(
  provider: string,
  codes: readonly ErrorCodeCount[],
): PartitionedErrors {
  const out: PartitionedErrors = {
    health: [],
    account: [],
    model: [],
    gateway: [],
    unclassified: [],
  };
  for (const c of codes) {
    out[classifyError(provider, c.code, c.httpStatus)].push({ code: c.code, count: c.count });
  }
  return out;
}
