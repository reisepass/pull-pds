/**
 * Fake gateway transports and response fixtures.
 *
 * The fixtures are SYNTHETIC but shaped from responses recorded against the live
 * OpenRouter, LiteLLM and OmniRoute deployments on 2026-08-03. Every account id,
 * workspace id, api-key hash, request id, generation id, session id and IP from
 * those recordings has been replaced with an obviously-fake placeholder, and no
 * credential appears anywhere in this tree. Nothing here opens a socket.
 */
import type { GatewayHttpRequest, GatewayHttpResponse, GatewayTransport } from '../src/gateway/types.js';

/** A route table keyed by a substring of the request URL. */
export type Routes = Record<string, unknown | ((req: GatewayHttpRequest) => unknown)>;

export interface FakeTransport {
  transport: GatewayTransport;
  /** Every request the collector made, in order. */
  calls: GatewayHttpRequest[];
}

/**
 * Build a transport that answers from `routes` (first URL substring match wins)
 * and 404s anything else. `statuses` overrides the status for a matched route.
 */
export function fakeTransport(routes: Routes, statuses: Record<string, number> = {}): FakeTransport {
  const calls: GatewayHttpRequest[] = [];
  const transport: GatewayTransport = async (req) => {
    calls.push(req);
    for (const [needle, body] of Object.entries(routes)) {
      if (!req.url.includes(needle)) continue;
      const resolved = typeof body === 'function' ? body(req) : body;
      return json(statuses[needle] ?? 200, resolved);
    }
    return json(404, { error: 'no fixture for this url' });
  };
  return { transport, calls };
}

export function json(status: number, body: unknown): GatewayHttpResponse {
  return {
    status,
    headers: new Map([['content-type', 'application/json']]),
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

/** The analytics API's doubly-nested envelope. */
export function analyticsEnvelope(rows: unknown[], truncated = false): unknown {
  return {
    data: {
      data: rows,
      metadata: { query_time_ms: 11, row_count: rows.length, truncated },
      cachedAt: 1_785_000_000_000,
    },
  };
}

/**
 * The verified live shape: an errored generation whose provider answered 200.
 * All 24 errors in the sampled month looked exactly like this.
 */
export function malformedFunctionCallGeneration(model = 'google/gemini-3.1-pro-preview'): unknown {
  return {
    data: {
      id: 'gen-0000000000-FAKEfakeFAKEfake0001',
      provider_name: 'Google',
      model,
      finish_reason: 'error',
      native_finish_reason: 'MALFORMED_FUNCTION_CALL',
      created_at: '2026-06-29T17:58:58.739Z',
      streamed: true,
      cancelled: false,
      provider_responses: [
        { provider_name: 'Google', status: 200, latency: 2907, endpoint_id: 'ep-fake-0001' },
      ],
    },
  };
}

/** A generation whose FIRST provider attempt genuinely failed with a 5xx. */
export function providerOutageGeneration(status = 503): unknown {
  return {
    data: {
      id: 'gen-0000000000-FAKEfakeFAKEfake0002',
      provider_name: 'Anthropic',
      model: 'anthropic/claude-4.6-sonnet',
      finish_reason: 'error',
      native_finish_reason: null,
      created_at: '2026-06-29T18:02:11.000Z',
      provider_responses: [
        { provider_name: 'Anthropic', status, latency: 812, endpoint_id: 'ep-fake-0002' },
      ],
    },
  };
}

/** LiteLLM's router refusing to dispatch: no provider ever saw the request. */
export function routerRateLimitRow(): unknown {
  return {
    request_id: 'req-fake-0001',
    model: 'gemini-3.1-flash-lite-preview',
    model_group: 'gemini-3.1-flash-lite-preview',
    custom_llm_provider: '',
    status: 'failure',
    startTime: '2026-08-03T06:30:32.519+00:00',
    metadata: {
      error_information: {
        error_code: '',
        error_class: 'RouterRateLimitError',
        llm_provider: '',
        error_message: 'No deployments available for selected model, Try again in 5 seconds.',
      },
    },
  };
}

/** A failure that DID reach a provider: `llm_provider` is populated. */
export function upstreamFailureRow(errorCode: string, errorClass: string): unknown {
  return {
    request_id: 'req-fake-0002',
    model: 'gemini-3.1-flash-lite-preview',
    model_group: 'gemini-3.1-flash-lite-preview',
    custom_llm_provider: '',
    status: 'failure',
    startTime: '2026-08-03T06:31:02.100+00:00',
    metadata: {
      error_information: {
        error_code: errorCode,
        error_class: errorClass,
        llm_provider: 'vertex_ai_beta',
        error_message: 'upstream said no',
      },
    },
  };
}

/** One day of `/user/daily/activity`, trimmed to what the collector reads. */
export function activityDay(providers: Record<string, number>): unknown {
  return {
    date: '2026-08-03',
    breakdown: {
      providers: Object.fromEntries(
        Object.entries(providers).map(([p, n]) => [
          p,
          { metrics: { successful_requests: n, failed_requests: 0, api_requests: n } },
        ]),
      ),
    },
  };
}
