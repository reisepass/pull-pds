import { describe, it, expect } from 'vitest';
import { parseProberConfig, type EndpointConfig } from '../src/prober/config.js';
import {
  probeEndpoint,
  buildProbeRequest,
  extractErrorCode,
  ProbeTransportError,
  type ProbeTransport,
  type ProbeHttpRequest,
} from '../src/prober/probe.js';

/**
 * Every test here drives a FAKE transport. Nothing in this file opens a socket;
 * `guardedTransport` (the only code that would) is never invoked.
 */
function fakeTransport(
  respond: (req: ProbeHttpRequest) => { status: number; body?: unknown } | Error,
): { transport: ProbeTransport; seen: ProbeHttpRequest[] } {
  const seen: ProbeHttpRequest[] = [];
  const transport: ProbeTransport = async (req) => {
    seen.push(req);
    const out = respond(req);
    if (out instanceof Error) throw out;
    return {
      status: out.status,
      body: new TextEncoder().encode(out.body === undefined ? '' : JSON.stringify(out.body)),
    };
  };
  return { transport, seen };
}

function endpoint(patch: Partial<EndpointConfig> = {}): EndpointConfig {
  const cfg = parseProberConfig({
    publisherDid: 'did:web:node.example.com',
    endpoints: [
      { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
    ],
  });
  return { ...(cfg.endpoints[0] as EndpointConfig), ...patch };
}

describe('buildProbeRequest - the cheapest request that still hits inference', () => {
  it('asks for exactly one output token on the openai wire', () => {
    const req = buildProbeRequest(endpoint(), 'fake-key');
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(new TextDecoder().decode(req.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(false);
    expect(body.model).toBe('gpt-4o-mini');
    expect(req.headers.authorization).toBe('Bearer fake-key');
  });

  it('uses x-api-key and a pinned version header on the anthropic wire', () => {
    const ep = endpoint({ wire: 'anthropic', path: '/v1/messages', baseUrl: 'https://api.anthropic.com' });
    const req = buildProbeRequest(ep, 'fake-key');
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers['x-api-key']).toBe('fake-key');
    expect(req.headers['anthropic-version']).toBe('2023-06-01');
    expect(req.headers.authorization).toBeUndefined();
  });

  it('sends no auth header at all for a keyless endpoint', () => {
    const req = buildProbeRequest(endpoint(), undefined);
    expect(req.headers.authorization).toBeUndefined();
    expect(req.headers['x-api-key']).toBeUndefined();
  });
});

describe('probeEndpoint - success', () => {
  it('reports ok and a latency, and retains nothing from the response body', async () => {
    const transport: ProbeTransport = async () => ({
      status: 200,
      body: new TextEncoder().encode(
        JSON.stringify({ choices: [{ message: { content: 'SECRET-COMPLETION-TEXT' } }] }),
      ),
    });
    let t = 1_000;
    const res = await probeEndpoint(endpoint(), 'fake-key', transport, false, () => (t += 40));
    expect(res.ok).toBe(true);
    expect(res.httpStatus).toBe(200);
    expect(res.errorCode).toBeUndefined();
    expect(res.latencyMs).toBe(40);
    expect(JSON.stringify(res)).not.toContain('SECRET-COMPLETION-TEXT');
  });
});

describe('probeEndpoint - provider errors become classifiable codes', () => {
  it('pulls error.type out of an OpenAI-shaped 429 envelope', async () => {
    const { transport } = fakeTransport(() => ({
      status: 429,
      body: { error: { message: 'Rate limit reached for gpt-4o-mini in org org-XYZ', type: 'rate_limit_exceeded' } },
    }));
    const res = await probeEndpoint(endpoint(), 'fake-key', transport);
    expect(res.ok).toBe(false);
    expect(res.httpStatus).toBe(429);
    expect(res.errorCode).toBe('rate_limit_exceeded');
    // The message named an org id; none of it survives.
    expect(JSON.stringify(res)).not.toContain('org-XYZ');
  });

  it('falls back to the bare status string when the body has no usable code', async () => {
    const { transport } = fakeTransport(() => ({ status: 503, body: { detail: 'upstream down' } }));
    const res = await probeEndpoint(endpoint(), 'fake-key', transport);
    expect(res.errorCode).toBe('503');
  });

  it('falls back to the status when the body is an HTML error page', async () => {
    const transport: ProbeTransport = async () => ({
      status: 502,
      body: new TextEncoder().encode('<html><body>502 Bad Gateway</body></html>'),
    });
    const res = await probeEndpoint(endpoint(), 'fake-key', transport);
    expect(res.errorCode).toBe('502');
  });
});

describe('probeEndpoint - transport failures', () => {
  it('maps a timeout to the transport code the classifier knows', async () => {
    const { transport } = fakeTransport(() => new ProbeTransportError('timeout', 'timed out after 10000ms'));
    const res = await probeEndpoint(endpoint(), 'fake-key', transport);
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('timeout');
    expect(res.httpStatus).toBeUndefined();
  });

  it('maps any other throw to connection_error rather than losing the failure', async () => {
    const { transport } = fakeTransport(() => new Error('socket hang up'));
    const res = await probeEndpoint(endpoint(), 'fake-key', transport);
    expect(res.errorCode).toBe('connection_error');
  });
});

describe('extractErrorCode - only identifier-shaped tokens survive', () => {
  const enc = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

  it('reads the shapes each provider family actually returns', () => {
    expect(extractErrorCode(enc({ error: { type: 'overloaded_error' } }))).toBe('overloaded_error');
    expect(extractErrorCode(enc({ error: { code: 'insufficient_quota' } }))).toBe('insufficient_quota');
    expect(extractErrorCode(enc({ error: { status: 'UNAVAILABLE' } }))).toBe('UNAVAILABLE');
    expect(extractErrorCode(enc({ __type: 'ThrottlingException' }))).toBe('ThrottlingException');
  });

  it('strips the AWS namespace prefix off a __type', () => {
    expect(extractErrorCode(enc({ __type: 'com.amazon.coral.service#ThrottlingException' }))).toBe(
      'ThrottlingException',
    );
  });

  it('never returns a prose message, however tempting the field is', () => {
    const body = enc({ error: { message: 'Your prompt about acquiring Foo Corp was rejected' } });
    expect(extractErrorCode(body)).toBeUndefined();
  });

  it('rejects a code-shaped field that is actually prose or over the lexicon length cap', () => {
    expect(extractErrorCode(enc({ error: { type: 'this is a sentence, not a code' } }))).toBeUndefined();
    expect(extractErrorCode(enc({ error: { type: 'x'.repeat(65) } }))).toBeUndefined();
  });

  it('returns undefined for empty, non-JSON, and non-object bodies', () => {
    expect(extractErrorCode(new Uint8Array())).toBeUndefined();
    expect(extractErrorCode(new TextEncoder().encode('not json'))).toBeUndefined();
    expect(extractErrorCode(enc(['a']))).toBeUndefined();
  });
});
