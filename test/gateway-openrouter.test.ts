import { describe, it, expect } from 'vitest';
import {
  OpenRouterCollector,
  classifyGeneration,
  OPENROUTER_SOURCE,
} from '../src/gateway/openrouter.js';
import { buildRecordValidator } from '../src/pds-websub/lexicon-validate.js';
import {
  analyticsEnvelope,
  fakeTransport,
  malformedFunctionCallGeneration,
  providerOutageGeneration,
  type Routes,
} from './gateway-fixtures.js';

const validate = buildRecordValidator();

const WINDOW_START = 1_800_000_000_000;
const WINDOW_END = WINDOW_START + 24 * 60 * 60 * 1000;

function collector(): OpenRouterCollector {
  return new OpenRouterCollector({
    apiKey: 'not-a-real-key',
    distroName: 'peertelemetry-gateway',
    distroVersion: '0.1.0',
  });
}

/**
 * Route the collector's three analytics queries by their `dimensions`, since
 * they all POST to the same URL.
 */
function analyticsRouter(
  byDimensions: Record<string, unknown[]>,
  truncated: Record<string, boolean> = {},
): Routes[string] {
  return (req) => {
    const body = JSON.parse(new TextDecoder().decode(req.body ?? new Uint8Array())) as {
      dimensions: string[];
    };
    const key = body.dimensions.join(',');
    return analyticsEnvelope(byDimensions[key] ?? [], truncated[key] === true);
  };
}

describe('classifyGeneration - the model-vs-provider distinction', () => {
  it('classifies a 200-status errored generation on its native finish reason', () => {
    const detail = (malformedFunctionCallGeneration() as { data: unknown }).data;
    const obs = classifyGeneration(detail as never);
    expect(obs).toBeDefined();
    expect(obs!.errorCode).toBe('malformed_function_call');
    expect(obs!.provider).toBe('Google');
    // No httpStatus: handing the classifier a 200 would invite reading a real
    // model-level failure as "not an error".
    expect(obs!.httpStatus).toBeUndefined();
  });

  it('classifies a genuinely failed attempt on its HTTP status instead', () => {
    const detail = (providerOutageGeneration(503) as { data: unknown }).data;
    const obs = classifyGeneration(detail as never);
    expect(obs!.errorCode).toBe('503');
    expect(obs!.httpStatus).toBe(503);
    expect(obs!.provider).toBe('Anthropic');
  });

  it('prefers the first failing attempt when a retry succeeded', () => {
    // Observed live: provider_responses [400, 200] with native RECITATION.
    const obs = classifyGeneration({
      provider_name: 'Google',
      model: 'google/gemini-3-flash-preview',
      finish_reason: 'error',
      native_finish_reason: 'RECITATION',
      provider_responses: [
        { provider_name: 'Google', status: 400 },
        { provider_name: 'Google', status: 200 },
      ],
    });
    expect(obs!.errorCode).toBe('400');
    expect(obs!.httpStatus).toBe(400);
  });

  it('falls back to the analytics row provider when the detail has none', () => {
    const obs = classifyGeneration(
      { model: 'x/y', finish_reason: 'error', native_finish_reason: 'SAFETY' },
      'Google',
    );
    expect(obs!.provider).toBe('Google');
    expect(obs!.errorCode).toBe('safety');
  });

  it('returns nothing when no provider can be established anywhere', () => {
    expect(classifyGeneration({ finish_reason: 'error' })).toBeUndefined();
  });
});

describe('OpenRouterCollector - a malformed function call is not an outage', () => {
  it('publishes zero health errors for a window of 200-status model failures', async () => {
    const errorRows = Array.from({ length: 24 }, (_, i) => ({
      generation_id: `gen-fake-${i}`,
      provider: 'Google',
      request_count: '1',
    }));
    const { transport } = fakeTransport({
      '/api/v1/analytics/query': analyticsRouter({
        'provider,finish_reason': [
          { provider: 'Google', finish_reason: 'stop', request_count: '59738' },
          { provider: 'Google', finish_reason: 'error', request_count: '24' },
        ],
        'provider,model': [
          {
            provider: 'Google',
            model: 'google/gemini-3.1-pro-preview',
            request_count: '59762',
          },
        ],
        'generation_id,provider': errorRows,
      }),
      '/api/v1/generation': malformedFunctionCallGeneration(),
    });

    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });

    expect(result.source).toBe(OPENROUTER_SOURCE);
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(validate(record.collection, record.record)).toBeNull();
    expect(record.record['gen_ai.provider.name']).toBe('gcp.gemini');
    expect(record.record['gen_ai.request.model']).toBe('google/gemini-3.1-pro-preview');
    // THE assertion this whole source exists for.
    expect(record.record.errors).toEqual([]);
    expect(record.record.totalErrors).toBe(0);
    expect(record.record.totalErrorsAllScopes).toBe(24);
    expect(result.stats.modelErrors).toBe(24);
    expect(result.stats.healthErrors).toBe(0);
    expect(JSON.stringify(record.record)).not.toContain('malformed');
  });

  it('does publish a health error when the provider really did fail', async () => {
    const { transport } = fakeTransport({
      '/api/v1/analytics/query': analyticsRouter({
        'provider,finish_reason': [
          { provider: 'Anthropic', finish_reason: 'error', request_count: '1' },
        ],
        'provider,model': [
          { provider: 'Anthropic', model: 'anthropic/claude-4.6-sonnet', request_count: '100' },
        ],
        'generation_id,provider': [
          { generation_id: 'gen-fake-a', provider: 'Anthropic', request_count: '1' },
        ],
      }),
      '/api/v1/generation': providerOutageGeneration(503),
    });

    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    const record = result.records[0]!;
    expect(record.record['gen_ai.provider.name']).toBe('anthropic');
    expect(record.record.errors).toEqual([{ code: '503', count: 1 }]);
    expect(result.stats.healthErrors).toBe(1);
    expect(validate(record.collection, record.record)).toBeNull();
  });
});

describe('OpenRouterCollector - the NULL finish_reason bucket', () => {
  it('counts NULL calls in the denominator and reports that they are unclassifiable', async () => {
    const { transport } = fakeTransport({
      '/api/v1/analytics/query': analyticsRouter({
        'provider,finish_reason': [
          { provider: 'Google', finish_reason: 'stop', request_count: '100' },
          { provider: 'Google', finish_reason: null, request_count: '470' },
        ],
        'provider,model': [
          { provider: 'Google', model: 'google/gemini-3.1-pro-preview', request_count: '570' },
        ],
        'generation_id,provider': [],
      }),
    });

    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(result.stats.totalCalls).toBe(570);
    const text = result.limitations.join(' | ');
    expect(text).toContain('470 call(s) had a NULL finish_reason');
    // The exact reason `not_in` is not used as the workaround.
    expect(text).toContain('no operator matches NULL');
  });

  it('never issues a not_in filter over finish_reason', async () => {
    const { transport, calls } = fakeTransport({
      '/api/v1/analytics/query': analyticsRouter({
        'provider,finish_reason': [],
        'provider,model': [],
        'generation_id,provider': [],
      }),
    });
    await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    const bodies = calls
      .filter((c) => c.body !== undefined)
      .map((c) => new TextDecoder().decode(c.body!));
    expect(bodies.some((b) => b.includes('not_in'))).toBe(false);
    expect(bodies).toHaveLength(3);
  });
});

describe('OpenRouterCollector - API constraints', () => {
  it('never asks for more than two dimensions', async () => {
    const { transport, calls } = fakeTransport({
      '/api/v1/analytics/query': analyticsRouter({
        'provider,finish_reason': [],
        'provider,model': [],
        'generation_id,provider': [],
      }),
    });
    await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    for (const call of calls) {
      if (call.body === undefined) continue;
      const body = JSON.parse(new TextDecoder().decode(call.body)) as { dimensions: string[] };
      expect(body.dimensions.length).toBeLessThanOrEqual(2);
    }
  });

  it('refuses a window past the 31-day cap instead of reporting a clean bill', async () => {
    const { transport, calls } = fakeTransport({});
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_START + 40 * 24 * 60 * 60 * 1000,
      transport,
    });
    expect(calls).toHaveLength(0);
    expect(result.records).toHaveLength(0);
    expect(result.limitations.join(' ')).toContain('31 days');
  });

  it('parses the string-typed request_count and the doubly-nested envelope', async () => {
    const { transport } = fakeTransport({
      '/api/v1/analytics/query': analyticsRouter({
        'provider,finish_reason': [],
        'provider,model': [{ provider: 'OpenAI', model: 'openai/gpt-4o', request_count: '1539' }],
        'generation_id,provider': [],
      }),
    });
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(result.stats.totalCalls).toBe(1539);
    expect(result.records[0]!.record.requestVolumeBucket).toBe('1K-9.9K');
  });

  it('throws rather than reporting zero when the envelope is unrecognised', async () => {
    const { transport } = fakeTransport({ '/api/v1/analytics/query': { unexpected: true } });
    await expect(
      collector().collect({
        windowStartMs: WINDOW_START,
        windowEndMs: WINDOW_END,
        transport,
      }),
    ).rejects.toThrow(/unrecognised envelope/);
  });

  it('throws on a non-200 analytics response rather than publishing nothing quietly', async () => {
    const { transport } = fakeTransport(
      { '/api/v1/analytics/query': { error: 'forbidden' } },
      { '/api/v1/analytics/query': 403 },
    );
    await expect(
      collector().collect({
        windowStartMs: WINDOW_START,
        windowEndMs: WINDOW_END,
        transport,
      }),
    ).rejects.toThrow(/HTTP 403/);
  });

  it('flags a full error page as a lower bound', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({
      generation_id: `gen-fake-${i}`,
      provider: 'Google',
      request_count: '1',
    }));
    const { transport } = fakeTransport({
      '/api/v1/analytics/query': analyticsRouter({
        'provider,finish_reason': [],
        'provider,model': [
          { provider: 'Google', model: 'google/gemini-3.1-pro-preview', request_count: '9000' },
        ],
        'generation_id,provider': rows,
      }),
      '/api/v1/generation': malformedFunctionCallGeneration(),
    });
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(result.limitations.join(' ')).toContain('lower bound');
  });

  it('counts a generation that could not be enriched instead of silently skipping it', async () => {
    const { transport } = fakeTransport({
      '/api/v1/analytics/query': analyticsRouter({
        'provider,finish_reason': [],
        'provider,model': [
          { provider: 'Google', model: 'google/gemini-3.1-pro-preview', request_count: '10' },
        ],
        'generation_id,provider': [
          { generation_id: 'gen-fake-gone', provider: 'Google', request_count: '1' },
        ],
      }),
      // no /api/v1/generation route -> 404
    });
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(result.limitations.join(' ')).toContain('could not be enriched');
  });

  it('always states that retried-away provider failures are invisible', async () => {
    const { transport } = fakeTransport({
      '/api/v1/analytics/query': analyticsRouter({
        'provider,finish_reason': [],
        'provider,model': [],
        'generation_id,provider': [],
      }),
    });
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(result.limitations.join(' ')).toContain('ultimately SUCCEEDED');
  });

  it('never puts the credential anywhere but the Authorization header', async () => {
    const { transport, calls } = fakeTransport({
      '/api/v1/analytics/query': analyticsRouter({
        'provider,finish_reason': [],
        'provider,model': [],
        'generation_id,provider': [],
      }),
    });
    await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    for (const call of calls) {
      expect(call.url).not.toContain('not-a-real-key');
      if (call.body !== undefined) {
        expect(new TextDecoder().decode(call.body)).not.toContain('not-a-real-key');
      }
      expect(call.headers.authorization).toBe('Bearer not-a-real-key');
    }
  });
});
