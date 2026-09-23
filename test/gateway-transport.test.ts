import { describe, it, expect } from 'vitest';
import { guardedGatewayTransport } from '../src/gateway/transport.js';
import type { Dialer, GuardedFetchOptions, GuardedResponse } from '../src/net/guarded-fetch.js';

/** Records what guardedFetch would have dialled, without opening a socket. */
function spyDialer(): { dialer: Dialer; seen: { url: string; opts: GuardedFetchOptions; pinned: string }[] } {
  const seen: { url: string; opts: GuardedFetchOptions; pinned: string }[] = [];
  const dialer: Dialer = async (parsed, pinnedAddress, opts): Promise<GuardedResponse> => {
    seen.push({ url: parsed.toString(), opts, pinned: pinnedAddress });
    return {
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      body: new TextEncoder().encode('{"ok":true}'),
      url: parsed.toString(),
      peerAddress: pinnedAddress,
    };
  };
  return { dialer, seen };
}

const resolver = async (): Promise<string[]> => ['93.184.216.34'];

describe('guardedGatewayTransport', () => {
  it('forwards method, headers, body and timeout, and returns the capped response', async () => {
    const { dialer, seen } = spyDialer();
    const transport = guardedGatewayTransport({ resolver, dialer });
    const body = new TextEncoder().encode('{"metrics":["request_count"]}');

    const res = await transport({
      url: 'https://gateway.example.com/api/v1/analytics/query',
      method: 'POST',
      headers: { authorization: 'Bearer not-a-real-key', 'content-type': 'application/json' },
      body,
      timeoutMs: 12_345,
    });

    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe('{"ok":true}');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.opts.method).toBe('POST');
    expect(seen[0]!.opts.timeoutMs).toBe(12_345);
    expect(seen[0]!.opts.body).toBe(body);
    expect(seen[0]!.opts.headers?.authorization).toBe('Bearer not-a-real-key');
    expect(seen[0]!.pinned).toBe('93.184.216.34');
  });

  it('omits the body entirely for a GET', async () => {
    const { dialer, seen } = spyDialer();
    await guardedGatewayTransport({ resolver, dialer })({
      url: 'https://gateway.example.com/model/info',
      method: 'GET',
      headers: {},
      timeoutMs: 1_000,
    });
    expect(seen[0]!.opts.body).toBeUndefined();
  });

  it('bounds the response and the redirect chain', async () => {
    const { dialer, seen } = spyDialer();
    await guardedGatewayTransport({ resolver, dialer })({
      url: 'https://gateway.example.com/x',
      method: 'GET',
      headers: {},
      timeoutMs: 1_000,
    });
    expect(seen[0]!.opts.maxBytes).toBe(8 * 1024 * 1024);
    expect(seen[0]!.opts.maxRedirects).toBe(2);
  });

  it('refuses a non-HTTPS gateway URL', async () => {
    const { dialer } = spyDialer();
    await expect(
      guardedGatewayTransport({ resolver, dialer })({
        url: 'http://gateway.example.com/x',
        method: 'GET',
        headers: {},
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/non-HTTPS/);
  });

  it('refuses a gateway that resolves to a private address unless allow-listed', async () => {
    const { dialer } = spyDialer();
    const privateResolver = async (): Promise<string[]> => ['169.254.169.254'];
    const req = {
      url: 'https://gateway.internal/x',
      method: 'GET' as const,
      headers: {},
      timeoutMs: 1_000,
    };
    await expect(
      guardedGatewayTransport({ resolver: privateResolver, dialer })(req),
    ).rejects.toThrow(/blocked address/);
    // A self-hosted gateway can be opted in, explicitly and per host.
    await expect(
      guardedGatewayTransport({
        resolver: privateResolver,
        dialer,
        allowHosts: new Set(['gateway.internal']),
      })(req),
    ).resolves.toMatchObject({ status: 200 });
  });
});
