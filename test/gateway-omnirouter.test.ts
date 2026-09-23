import { describe, it, expect } from 'vitest';
import {
  OmniRouteCollector,
  OMNIROUTER_SOURCE,
  normalizeBaseUrl,
} from '../src/gateway/omnirouter.js';
import { fakeTransport } from './gateway-fixtures.js';

const WINDOW_START = 1_800_000_000_000;
const WINDOW_END = WINDOW_START + 24 * 60 * 60 * 1000;

const collector = (): OmniRouteCollector =>
  new OmniRouteCollector({ baseUrl: 'https://omniroute.example.com' });

describe('normalizeBaseUrl', () => {
  it('upgrades a bare hostname to https', () => {
    // The live value is configured without a scheme, which is a hard `new URL`
    // failure if it reaches one unguarded.
    expect(normalizeBaseUrl('omniroute.example.com')).toBe('https://omniroute.example.com');
  });

  it('leaves an explicit scheme alone and trims a trailing slash', () => {
    expect(normalizeBaseUrl('https://omniroute.example.com/')).toBe('https://omniroute.example.com');
    expect(normalizeBaseUrl('http://localhost:20128')).toBe('http://localhost:20128');
  });
});

describe('OmniRouteCollector - a documented negative', () => {
  it('emits no records even when the instance is healthy', async () => {
    const { transport } = fakeTransport({
      '/api/health/ping': { status: 'ok', timestamp: '2026-08-03T18:07:20.920Z', latencyMs: 0 },
    });
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(result.source).toBe(OMNIROUTER_SOURCE);
    expect(result.records).toHaveLength(0);
    expect(result.stats.totalCalls).toBe(0);
    expect(result.limitations.join(' ')).toContain('emits no records');
    expect(result.limitations.join(' ')).toContain('manage-scoped credential');
  });

  it('touches nothing but the public health ping', async () => {
    const { transport, calls } = fakeTransport({ '/api/health/ping': { status: 'ok' } });
    await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://omniroute.example.com/api/health/ping');
    // No credential is configured or sent; the route is public.
    expect(calls[0]!.headers).toEqual({});
  });

  it('distinguishes "closed to us" from "down"', async () => {
    const { transport } = fakeTransport({ '/api/health/ping': { err: 'nope' } }, { '/api/health/ping': 502 });
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(result.limitations.join(' ')).toContain('HTTP 502');
  });

  it('reports an unreachable instance without throwing', async () => {
    const transport = async (): Promise<never> => {
      throw new Error('getaddrinfo ENOTFOUND');
    };
    const result = await collector().collect({
      windowStartMs: WINDOW_START,
      windowEndMs: WINDOW_END,
      transport,
    });
    expect(result.records).toHaveLength(0);
    expect(result.limitations.join(' ')).toContain('unreachable');
  });
});
