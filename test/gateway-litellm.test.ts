import { describe, it, expect } from 'vitest';
import {
  LiteLlmCollector,
  LITELLM_INTERNAL,
  LITELLM_SOURCE,
  classifyFailureRow,
  inferProviderFromModel,
} from '../src/gateway/litellm.js';
import { buildRecordValidator } from '../src/pds-websub/lexicon-validate.js';
import {
  activityDay,
  fakeTransport,
  routerRateLimitRow,
  upstreamFailureRow,
} from './gateway-fixtures.js';

const validate = buildRecordValidator();

const WINDOW_START = 1_800_000_000_000;
const WINDOW_END = WINDOW_START + 24 * 60 * 60 * 1000;

const MODEL_INFO = {
  data: [
    {
      model_name: 'gemini-3.1-flash-lite-preview',
      litellm_params: { model: 'gemini-3.1-flash-lite-preview', custom_llm_provider: 'vertex_ai' },
    },
    {
      model_name: 'openrouter/openai/gpt-5.2-pro',
      litellm_params: { model: 'openrouter/openai/gpt-5.2-pro', custom_llm_provider: 'openrouter' },
    },
  ],
};

function collector(publishInferredProviders = false): LiteLlmCollector {
  return new LiteLlmCollector({
    baseUrl: 'https://litellm.example.com',
    apiKey: 'not-a-real-key',
    distroName: 'peertelemetry-gateway',
    distroVersion: '0.1.0',
    publishInferredProviders,
  });
}

function routes(failures: unknown[], days: unknown[] = [], totalPages = 1) {
  return {
    '/model/info': MODEL_INFO,
    '/spend/logs/v2': { data: failures, total: failures.length, page: 1, total_pages: totalPages },
    '/user/daily/activity': { results: days, metadata: {} },
  };
}

const modelProviders = new Map([
  ['gemini-3.1-flash-lite-preview', 'vertex_ai'],
  ['openrouter/openai/gpt-5.2-pro', 'openrouter'],
]);

describe('classifyFailureRow - GAP (a), provider attribution', () => {
  it('reads the provider the activity endpoint misses, as OBSERVED', () => {
    // custom_llm_provider is "" (that is what makes the activity endpoint say
    // "unknown"), but error_information.llm_provider is populated.
    const obs = classifyFailureRow(upstreamFailureRow('404', 'NotFoundError') as never, modelProviders);
    expect(obs.provider).toBe('vertex_ai_beta');
    expect(obs.providerAttribution).toBe('observed');
  });

  it('marks a slug-derived provider INFERRED, never observed', () => {
    const row = {
      model_group: 'gemini-3.1-flash-lite-preview',
      custom_llm_provider: '',
      metadata: { error_information: { error_code: '500', error_class: 'InternalServerError', llm_provider: '' } },
    };
    const obs = classifyFailureRow(row as never, modelProviders);
    expect(obs.provider).toBe('vertex_ai');
    expect(obs.providerAttribution).toBe('inferred');
  });

  it('sends a request that never reached a provider to the gateway pseudo-provider', () => {
    const obs = classifyFailureRow(
      { model_group: '', custom_llm_provider: '', metadata: { error_information: { error_class: 'Exception', error_code: '', llm_provider: '' } } } as never,
      new Map(),
    );
    expect(obs.provider).toBe(LITELLM_INTERNAL);
    expect(obs.providerAttribution).toBe('unknown');
  });
});

describe('classifyFailureRow - GAP (b), error codes', () => {
  it('prefers the upstream error_code over the LiteLLM exception name', () => {
    // MidStreamFallbackError says nothing about the upstream cause; the 429 does.
    const obs = classifyFailureRow(
      upstreamFailureRow('429', 'MidStreamFallbackError') as never,
      modelProviders,
    );
    expect(obs.errorCode).toBe('429');
    expect(obs.httpStatus).toBe(429);
  });

  it('falls back to the exception class when there is no upstream code', () => {
    const obs = classifyFailureRow(routerRateLimitRow() as never, modelProviders);
    expect(obs.errorCode).toBe('routerratelimiterror');
    expect(obs.httpStatus).toBeUndefined();
  });
});

describe('inferProviderFromModel', () => {
  it('uses the proxy\'s own routing config first', () => {
    expect(inferProviderFromModel('gemini-3.1-flash-lite-preview', modelProviders)).toBe('vertex_ai');
  });

  it('accepts a slug prefix only when the config knows it as a provider', () => {
    expect(inferProviderFromModel('openrouter/qwen/qwen3.6-plus', modelProviders)).toBe('openrouter');
    // `qwen` is a model family, not a provider, and must not be guessed at.
    expect(inferProviderFromModel('qwen/qwen3.6-plus', modelProviders)).toBeUndefined();
  });

  it('returns nothing for an unknown model', () => {
    expect(inferProviderFromModel(undefined, modelProviders)).toBeUndefined();
    expect(inferProviderFromModel('who/knows', new Map())).toBeUndefined();
  });
});

describe('LiteLlmCollector - the router\'s own failures are not the provider\'s', () => {
  it('classifies RouterRateLimitError as gateway scope and publishes no record for it', async () => {
    // The live 37-day shape: 306 router refusals, no provider involved.
    const failures = Array.from({ length: 306 }, () => routerRateLimitRow());
    const { transport } = fakeTransport(routes(failures, [activityDay({ vertex_ai: 500 })]));

    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });

    expect(result.source).toBe(LITELLM_SOURCE);
    expect(result.stats.gatewayErrors).toBe(306);
    expect(result.stats.healthErrors).toBe(0);
    // The only record is the healthy vertex_ai denominator; nothing names a
    // provider for a request it never received.
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.record['gen_ai.provider.name']).toBe('gcp.gemini');
    expect(record.record.errors).toEqual([]);
    expect(JSON.stringify(record.record)).not.toContain('routerratelimiterror');
    expect(validate(record.collection, record.record)).toBeNull();
  });

  it('publishes an upstream failure against the provider that served it', async () => {
    const failures = [upstreamFailureRow('503', 'ServiceUnavailableError')];
    const { transport } = fakeTransport(routes(failures, [activityDay({ vertex_ai: 100 })]));
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    const record = result.records.find((r) => r.record['gen_ai.provider.name'] === 'gcp.gemini');
    expect(record).toBeDefined();
    expect(record!.record.errors).toEqual([{ code: '503', count: 1 }]);
    expect(result.stats.healthErrors).toBe(1);
    expect(validate(record!.collection, record!.record)).toBeNull();
  });

  it('never publishes an undifferentiated failed_requests count', async () => {
    const failures = [
      ...Array.from({ length: 3 }, () => routerRateLimitRow()),
      upstreamFailureRow('404', 'NotFoundError'),
    ];
    const { transport } = fakeTransport(routes(failures, [activityDay({ vertex_ai: 50 })]));
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    // 4 failures, but they are three different things and none is a 5xx.
    expect(result.stats.gatewayErrors).toBe(3);
    expect(result.stats.healthErrors).toBe(0);
    const record = result.records.find((r) => r.record['gen_ai.provider.name'] === 'gcp.gemini')!;
    expect(record.record.errors).toEqual([]);
    // A bare 404 is left VISIBLE rather than dropped or called downtime.
    expect(record.record.unclassified).toEqual([{ code: '404', count: 1 }]);
  });
});

describe('LiteLlmCollector - denominator and disclosure', () => {
  it('does not double-count a failure that is already in the activity total', async () => {
    const failures = [upstreamFailureRow('503', 'ServiceUnavailableError')];
    const { transport } = fakeTransport(routes(failures, [activityDay({ vertex_ai: 10 })]));
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(result.stats.totalCalls).toBe(10);
  });

  it('excludes the activity endpoint\'s "unknown" bucket and explains why', async () => {
    const day = {
      date: '2026-08-03',
      breakdown: {
        providers: {
          vertex_ai: { metrics: { api_requests: 20, successful_requests: 20, failed_requests: 0 } },
          unknown: { metrics: { api_requests: 9, successful_requests: 0, failed_requests: 9 } },
        },
      },
    };
    const { transport } = fakeTransport(routes([], [day]));
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(result.stats.totalCalls).toBe(20);
    const text = result.limitations.join(' ');
    expect(text).toContain('"unknown" provider');
    // The bucket is not only failures - live it was 1094 against 385 failures -
    // so the message must state the comparison, not assert an equality.
    expect(text).toContain('9 call(s) sat in');
    expect(text).toContain('against 0 failure(s)');
    expect(text).toContain('overstated');
  });

  it('withholds an inferred-provider record by default and publishes it on opt-in', async () => {
    const row = {
      model_group: 'gemini-3.1-flash-lite-preview',
      custom_llm_provider: '',
      metadata: { error_information: { error_code: '503', error_class: 'ServiceUnavailableError', llm_provider: '' } },
    };
    const off = await collector(false).collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport: fakeTransport(routes([row])).transport,
    });
    expect(off.records).toHaveLength(0);
    expect(off.stats.providerInferred).toBe(1);
    expect(off.limitations.join(' ')).toContain('INFERRED');

    const on = await collector(true).collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport: fakeTransport(routes([row])).transport,
    });
    expect(on.records).toHaveLength(1);
    expect(on.records[0]!.record['gen_ai.provider.name']).toBe('gcp.gemini');
  });

  it('states that records carry no model, and emits none', async () => {
    const { transport } = fakeTransport(
      routes([upstreamFailureRow('503', 'ServiceUnavailableError')], [activityDay({ vertex_ai: 100 })]),
    );
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(result.limitations.join(' ')).toContain('no per-model denominator');
    for (const r of result.records) expect(r.record).not.toHaveProperty('gen_ai.request.model');
  });

  it('names the failure classes it saw so nothing is invisible to the operator', async () => {
    const { transport } = fakeTransport(
      routes([routerRateLimitRow(), upstreamFailureRow('404', 'NotFoundError')]),
    );
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    const text = result.limitations.join(' ');
    expect(text).toContain('RouterRateLimitError=1');
    expect(text).toContain('NotFoundError=1');
  });

  it('degrades to a stated limitation when the activity endpoint is unreadable', async () => {
    const { transport } = fakeTransport(
      { '/model/info': MODEL_INFO, '/spend/logs/v2': { data: [], total_pages: 1 } },
      {},
    );
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(result.limitations.join(' ')).toContain('no request-volume denominator');
  });

  it('sends the credential only as a bearer header, on every request', async () => {
    const { transport, calls } = fakeTransport(routes([routerRateLimitRow()], [activityDay({ vertex_ai: 5 })]));
    await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).not.toContain('not-a-real-key');
      expect(call.headers.authorization).toBe('Bearer not-a-real-key');
      expect(call.method).toBe('GET');
    }
  });

  it('formats the spend-log window the way the endpoint demands', async () => {
    const { transport, calls } = fakeTransport(routes([]));
    await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    const spendCall = calls.find((c) => c.url.includes('/spend/logs/v2'))!;
    const start = new URL(spendCall.url).searchParams.get('start_date')!;
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(new URL(spendCall.url).searchParams.get('status_filter')).toBe('failure');
  });

  it('pages through every failure page', async () => {
    let page = 0;
    const { transport } = fakeTransport({
      '/model/info': MODEL_INFO,
      '/spend/logs/v2': () => {
        page += 1;
        return { data: [routerRateLimitRow()], total_pages: 3 };
      },
      '/user/daily/activity': { results: [] },
    });
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(page).toBe(3);
    expect(result.stats.gatewayErrors).toBe(3);
  });
});
