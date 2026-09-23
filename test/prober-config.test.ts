import { describe, it, expect } from 'vitest';
import {
  parseProberConfig,
  resolveCredential,
  deriveRkey,
  ProberConfigError,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_BLUESKY_SERVICE,
  type EndpointConfig,
} from '../src/prober/config.js';

/** The shortest config that is valid - the setup-friction benchmark. */
const MINIMAL = {
  publisherDid: 'did:web:node.example.com',
  publish: { kind: 'file', path: '/tmp/feed.json' },
  endpoints: [
    {
      provider: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
      apiKeyEnv: 'PROBER_TEST_KEY',
    },
  ],
};

describe('parseProberConfig - defaults', () => {
  it('accepts a minimal config and fills every other field in', () => {
    const cfg = parseProberConfig(MINIMAL);
    expect(cfg.publisherDid).toBe('did:web:node.example.com');
    expect(cfg.publish).toEqual({ kind: 'file', path: '/tmp/feed.json' });
    expect(cfg.allowLocalhost).toBe(false);
    expect(cfg.distroName).toBe('peertelemetry-prober');

    const ep = cfg.endpoints[0] as EndpointConfig;
    expect(ep.wire).toBe('openai');
    expect(ep.path).toBe('/chat/completions');
    expect(ep.attempts).toBe(1);
    expect(ep.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(ep.serviceType).toBe('llm');
    expect(ep.rkey).toBe('openai_gpt-4o-mini');
  });

  it('infers the anthropic wire protocol and its path from the provider name', () => {
    const cfg = parseProberConfig({
      ...MINIMAL,
      endpoints: [{ provider: 'anthropic', model: 'claude-haiku-4-5', baseUrl: 'https://api.anthropic.com' }],
    });
    const ep = cfg.endpoints[0] as EndpointConfig;
    expect(ep.wire).toBe('anthropic');
    expect(ep.path).toBe('/v1/messages');
  });

  it('defaults to the dry-run publisher when no publish target is given', () => {
    const { publish, ...noPublish } = MINIMAL;
    expect(publish).toBeDefined(); // the field we are removing existed
    expect(parseProberConfig(noPublish).publish).toEqual({ kind: 'dryrun' });
  });

  it('defaults the bluesky target to the bsky.social entryway', () => {
    const cfg = parseProberConfig({
      ...MINIMAL,
      publish: { kind: 'bluesky', identifier: 'node.example.social', passwordEnv: 'BSKY_APP_PASSWORD' },
    });
    expect(cfg.publish).toEqual({
      kind: 'bluesky',
      service: DEFAULT_BLUESKY_SERVICE,
      identifier: 'node.example.social',
      passwordEnv: 'BSKY_APP_PASSWORD',
    });
  });

  it('accepts a self-hosted PDS as the bluesky service, trailing slash stripped', () => {
    const cfg = parseProberConfig({
      ...MINIMAL,
      publish: {
        kind: 'bluesky',
        service: 'https://pds.example.org/',
        identifier: 'did:plc:abc123',
        passwordEnv: 'PW',
      },
    });
    expect(cfg.publish).toMatchObject({ service: 'https://pds.example.org' });
  });

  it('strips a trailing slash from baseUrl so the path is not doubled', () => {
    const cfg = parseProberConfig({
      ...MINIMAL,
      endpoints: [{ provider: 'openai', model: 'm', baseUrl: 'https://api.openai.com/v1/' }],
    });
    expect((cfg.endpoints[0] as EndpointConfig).baseUrl).toBe('https://api.openai.com/v1');
  });
});

describe('parseProberConfig - rejections name the field', () => {
  const bad = (patch: Record<string, unknown>): (() => unknown) => () =>
    parseProberConfig({ ...MINIMAL, ...patch });

  it('requires a DID-shaped publisherDid', () => {
    expect(bad({ publisherDid: 'node.example.com' })).toThrow(/publisherDid must be a DID/);
    expect(bad({ publisherDid: undefined })).toThrow(/publisherDid is required/);
  });

  it('requires a non-empty endpoints array', () => {
    expect(bad({ endpoints: [] })).toThrow(/endpoints must be a non-empty array/);
    expect(bad({ endpoints: 'openai' })).toThrow(/endpoints must be a non-empty array/);
  });

  it('rejects a non-https baseUrl (the outbound guard is HTTPS-only)', () => {
    expect(bad({ endpoints: [{ provider: 'p', baseUrl: 'http://api.example.com' }] })).toThrow(
      /must be https/,
    );
  });

  it('rejects an unknown publish kind and an unknown wire protocol', () => {
    expect(bad({ publish: { kind: 'carrier-pigeon' } })).toThrow(/not one of: file, dryrun, bluesky/);
    expect(bad({ endpoints: [{ provider: 'p', baseUrl: 'https://x.example', wire: 'grpc' }] })).toThrow(
      /wire must be/,
    );
  });

  it('rejects an app password written into the bluesky target', () => {
    // The config file is a file people commit, and an app password is a
    // full-repo write credential. A literal must never be the working shortcut.
    for (const field of ['password', 'appPassword', 'app_password', 'token', 'accessJwt']) {
      expect(
        bad({ publish: { kind: 'bluesky', identifier: 'a.example', passwordEnv: 'PW', [field]: 'hunter2' } }),
      ).toThrow(/never live in the config file/);
    }
  });

  it('requires an identifier and a passwordEnv on the bluesky target', () => {
    expect(bad({ publish: { kind: 'bluesky', passwordEnv: 'PW' } })).toThrow(
      /publish.identifier is required/,
    );
    expect(bad({ publish: { kind: 'bluesky', identifier: 'a.example' } })).toThrow(
      /publish.passwordEnv is required/,
    );
  });

  it('rejects a non-https bluesky service', () => {
    expect(
      bad({ publish: { kind: 'bluesky', service: 'http://pds.example.org', identifier: 'a.example', passwordEnv: 'PW' } }),
    ).toThrow(/must be https/);
    expect(
      bad({ publish: { kind: 'bluesky', service: 'not a url', identifier: 'a.example', passwordEnv: 'PW' } }),
    ).toThrow(/is not a URL/);
  });

  it('rejects duplicate rkeys rather than silently overwriting one record with the other', () => {
    expect(
      bad({
        endpoints: [
          { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://a.example' },
          { provider: 'openai', model: 'gpt-4o', baseUrl: 'https://b.example' },
        ],
      }),
    ).toThrow(/duplicate rkey/);
  });

  it('caps attempts so a prober cannot be turned into a load generator', () => {
    expect(bad({ attempts: 50 })).toThrow(/attempts must be an integer 1-10/);
    expect(bad({ attempts: 0 })).toThrow(/attempts must be an integer 1-10/);
  });

  it('rejects a sub-100ms timeout', () => {
    expect(bad({ timeoutMs: 5 })).toThrow(/timeoutMs must be >= 100/);
  });
});

describe('parseProberConfig - credentials never live in the config file', () => {
  it('rejects an inlined literal key under any of its usual names', () => {
    for (const field of ['apiKey', 'api_key', 'key', 'token', 'authorization']) {
      expect(() =>
        parseProberConfig({
          ...MINIMAL,
          endpoints: [
            { provider: 'openai', baseUrl: 'https://api.openai.com/v1', [field]: 'placeholder-not-a-real-key' },
          ],
        }),
      ).toThrow(/credentials never live in the config file/);
    }
  });

  it('rejects an endpoint that names both an env var and a file', () => {
    expect(() =>
      parseProberConfig({
        ...MINIMAL,
        endpoints: [
          {
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKeyEnv: 'A',
            apiKeyFile: '/etc/b',
          },
        ],
      }),
    ).toThrow(/not both/);
  });
});

describe('deriveRkey', () => {
  it('uses the provider alone when there is no model dimension', () => {
    expect(deriveRkey('openai')).toBe('openai');
  });

  it('folds characters an atproto record key forbids', () => {
    // A slashed model id (meta-llama/Llama-3-8b) is not a legal record key.
    expect(deriveRkey('together', 'meta-llama/Llama-3-8b')).toBe('together_meta-llama-Llama-3-8b');
  });

  it('produces a config-parseable rkey for a slashed model id', () => {
    const cfg = parseProberConfig({
      ...MINIMAL,
      endpoints: [
        { provider: 'together', model: 'meta-llama/Llama-3-8b', baseUrl: 'https://api.together.xyz/v1' },
      ],
    });
    expect((cfg.endpoints[0] as EndpointConfig).rkey).toBe('together_meta-llama-Llama-3-8b');
  });
});

describe('resolveCredential', () => {
  const ep = (patch: Partial<EndpointConfig>): EndpointConfig => ({
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    path: '/chat/completions',
    wire: 'openai',
    rkey: 'openai',
    attempts: 1,
    timeoutMs: 1000,
    serviceType: 'llm',
    ...patch,
  });

  it('reads from the named env var', () => {
    // A syntactically plausible but obviously fake value; never a real key.
    expect(resolveCredential(ep({ apiKeyEnv: 'MY_KEY' }), { MY_KEY: 'fake-key-value' })).toBe(
      'fake-key-value',
    );
  });

  it('reads and trims a key file through the injected reader', () => {
    expect(
      resolveCredential(ep({ apiKeyFile: '/etc/keys/x' }), {}, () => '  fake-file-key\n'),
    ).toBe('fake-file-key');
  });

  it('returns undefined when the endpoint declares no credential', () => {
    expect(resolveCredential(ep({}), {})).toBeUndefined();
  });

  it('throws naming the env var, never a value, when the credential is missing', () => {
    try {
      resolveCredential(ep({ apiKeyEnv: 'MISSING_KEY' }), {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ProberConfigError);
      expect((err as Error).message).toContain('MISSING_KEY');
    }
  });

  it('rejects an empty env var rather than sending an empty Authorization header', () => {
    expect(() => resolveCredential(ep({ apiKeyEnv: 'BLANK' }), { BLANK: '   ' })).toThrow(
      /unset or empty/,
    );
  });
});
