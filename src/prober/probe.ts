/**
 * The probe itself: the cheapest request that still exercises the real
 * inference path, plus the extraction of a classifiable error code from what
 * comes back.
 *
 * WHY A REAL COMPLETION AND NOT `GET /models`. A model-list or a `/health` route
 * is served by the front door and stays green while inference is broken; that is
 * exactly the outage worth reporting. So the probe is a 1-token completion:
 * genuinely the smallest unit of real work, single-digit fractions of a cent per
 * run, and it fails when the thing consumers care about fails.
 *
 * RESPONSE CONTENT IS NEVER READ ON SUCCESS AND NEVER RETAINED ON FAILURE. A 2xx
 * body is discarded unparsed - we want the status and the clock, not the token.
 * A non-2xx body is parsed only to pull a *code token* out of known structured
 * fields, and that token must match a conservative charset before it is kept
 * ({@link extractErrorCode}). Provider error `message` strings are deliberately
 * never touched: they can quote the request, and a record is signed and public.
 */
import { guardedFetch, GuardedFetchError } from '../net/guarded-fetch.js';
import type { EndpointConfig } from './config.js';

/** A transport failure with no HTTP response. Codes match `TRANSPORT_CODES`. */
export class ProbeTransportError extends Error {
  constructor(
    readonly code: 'timeout' | 'connection_error',
    message: string,
  ) {
    super(message);
    this.name = 'ProbeTransportError';
  }
}

export interface ProbeHttpRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: Uint8Array;
  timeoutMs: number;
  allowLocalhost: boolean;
}

export interface ProbeHttpResponse {
  status: number;
  body: Uint8Array;
}

/**
 * The single seam between the prober and the network. Injected everywhere, so
 * no test ever opens a socket, and so an operator behind an unusual egress path
 * can supply their own.
 */
export type ProbeTransport = (req: ProbeHttpRequest) => Promise<ProbeHttpResponse>;

export interface ProbeResult {
  /** True on a 2xx response. Everything else, including transport failure, is false. */
  ok: boolean;
  /** HTTP status, absent when the request never got a response. */
  httpStatus?: number;
  /**
   * The provider error code / type string, a transport code (`timeout`,
   * `connection_error`), or the bare HTTP status as a string when the body
   * carried no usable code. Absent on success. Fed to `classifyError`.
   */
  errorCode?: string;
  /** Wall-clock round trip in ms, measured across the transport call. */
  latencyMs: number;
}

/** Cap on the non-2xx body we will parse. Error envelopes are tiny. */
const MAX_ERROR_BODY_BYTES = 16 * 1024;

/**
 * Cap on the whole response the transport will accept. Comfortably above any
 * 1-token completion and well above any error envelope, but deliberately larger
 * than {@link MAX_ERROR_BODY_BYTES}: the guard *throws* on an oversize body, and
 * a thrown read would turn a perfectly healthy 200 into a fabricated
 * `connection_error`. Slack here costs nothing; a false health signal costs the
 * dataset.
 */
const MAX_RESPONSE_BYTES = 256 * 1024;

/**
 * A code token we are willing to put in a signed public record. Provider codes
 * are identifier-shaped (`rate_limit_exceeded`, `ThrottlingException`,
 * `RESOURCE_EXHAUSTED`); anything else is a message, a path, or an id, and is
 * dropped in favour of the HTTP status. The 64-char cap is the lexicon's
 * `errorCodeCount.code` maxLength.
 */
const CODE_TOKEN = /^[A-Za-z0-9._:-]{1,64}$/;

/** Run one probe. Never throws for a provider failure - that is the data. */
export async function probeEndpoint(
  ep: EndpointConfig,
  credential: string | undefined,
  transport: ProbeTransport,
  allowLocalhost = false,
  now: () => number = () => Date.now(),
): Promise<ProbeResult> {
  const req = buildProbeRequest(ep, credential, allowLocalhost);
  const started = now();
  let res: ProbeHttpResponse;
  try {
    res = await transport(req);
  } catch (err) {
    const latencyMs = Math.max(0, now() - started);
    const code = err instanceof ProbeTransportError ? err.code : 'connection_error';
    return { ok: false, errorCode: code, latencyMs };
  }
  const latencyMs = Math.max(0, now() - started);

  if (res.status >= 200 && res.status < 300) {
    // Body deliberately untouched.
    return { ok: true, httpStatus: res.status, latencyMs };
  }
  return {
    ok: false,
    httpStatus: res.status,
    errorCode: extractErrorCode(res.body) ?? String(res.status),
    latencyMs,
  };
}

/**
 * Build the minimal request for an endpoint's wire protocol. One user turn, one
 * output token, deterministic, no streaming.
 */
export function buildProbeRequest(
  ep: EndpointConfig,
  credential: string | undefined,
  allowLocalhost = false,
): ProbeHttpRequest {
  const url = `${ep.baseUrl}${ep.path}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let payload: Record<string, unknown>;

  if (ep.wire === 'anthropic') {
    if (credential !== undefined) headers['x-api-key'] = credential;
    headers['anthropic-version'] = '2023-06-01';
    payload = {
      model: ep.model ?? '',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    };
  } else {
    if (credential !== undefined) headers['authorization'] = `Bearer ${credential}`;
    payload = {
      model: ep.model ?? '',
      max_tokens: 1,
      temperature: 0,
      stream: false,
      messages: [{ role: 'user', content: 'ping' }],
    };
  }

  return {
    url,
    method: 'POST',
    headers,
    body: new TextEncoder().encode(JSON.stringify(payload)),
    timeoutMs: ep.timeoutMs,
    allowLocalhost,
  };
}

/**
 * Pull a classifiable code token out of a provider error envelope. Covers the
 * shapes the classification table keys on:
 *   - OpenAI / Azure / LiteLLM: `{ error: { type, code } }`
 *   - Anthropic:                `{ error: { type } }`
 *   - Google:                   `{ error: { status } }`
 *   - Bedrock:                  `{ __type }` or `{ message, code }`
 *
 * `message` is never consulted. Returns undefined when nothing identifier-shaped
 * is present, and the caller falls back to the HTTP status string, which the
 * classifier already understands.
 */
export function extractErrorCode(body: Uint8Array): string | undefined {
  if (body.byteLength === 0 || body.byteLength > MAX_ERROR_BODY_BYTES) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined; // an HTML error page or a proxy blob; the status is enough
  }
  if (typeof json !== 'object' || json === null) return undefined;
  const top = json as Record<string, unknown>;
  const err =
    typeof top.error === 'object' && top.error !== null
      ? (top.error as Record<string, unknown>)
      : {};

  // Order matters: the provider's own type/code string first, the AWS exception
  // name next, and Google's canonical status last.
  const candidates = [err.type, err.code, top.type, top.code, top.__type, err.status, top.status];
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    // Bedrock's `__type` is sometimes namespaced: "com.amazon...#ThrottlingException".
    const token = c.includes('#') ? (c.split('#').pop() as string) : c;
    if (CODE_TOKEN.test(token)) return token;
  }
  return undefined;
}

/**
 * The production transport: the repo's single guarded outbound path, reused
 * rather than a bare `fetch`. That buys HTTPS-only, one-shot DNS resolution with
 * the socket pinned to the validated address, a same-host redirect rule, a hard
 * body cap, and a whole-request timeout - all already tested.
 *
 * The cost is that plain-`http://` endpoints cannot be probed at all. That is
 * accepted: an API key in a header over cleartext is not a thing to make easy.
 * A local `https://localhost:8000` model server works with `allowLocalhost`.
 */
export const guardedTransport: ProbeTransport = async (req) => {
  try {
    const res = await guardedFetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      timeoutMs: req.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      maxRedirects: 2,
      ...(req.allowLocalhost
        ? { allowHosts: new Set([new URL(req.url).hostname]) }
        : {}),
    });
    return { status: res.status, body: res.body };
  } catch (err) {
    if (err instanceof GuardedFetchError) {
      throw new ProbeTransportError(
        err.code === 'timeout' ? 'timeout' : 'connection_error',
        // The guard's message names the host and the reason, never a header.
        err.message,
      );
    }
    throw new ProbeTransportError('connection_error', (err as Error).message);
  }
};
