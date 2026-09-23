import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FilePublisher,
  DryRunPublisher,
  BlueskyPublisher,
  createPublisher,
  PublisherUnavailableError,
  PublishError,
  type Publisher,
  type TelemetryRecord,
  type XrpcTransport,
  type XrpcResponse,
} from '../src/prober/publish.js';
import { parseProberConfig, type ProberConfig } from '../src/prober/config.js';
import { runOnce } from '../src/prober/run.js';
import type { ProbeTransport, ProbeHttpRequest } from '../src/prober/probe.js';
import { ProbeTransportError } from '../src/prober/probe.js';
import { ERROR_METRICS_NSID } from '../src/collections.js';

const DID = 'did:web:node.example.com';

function record(rkey: string): TelemetryRecord {
  return {
    collection: ERROR_METRICS_NSID,
    rkey,
    record: { $type: ERROR_METRICS_NSID, totalErrors: 0 },
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prober-publish-'));
});
afterEach(() => {
  // The OS reclaims the temp dir; nothing here removes files.
});

describe('FilePublisher', () => {
  it('writes an app.pullpds.feed snapshot the pull-PDS can ingest', async () => {
    const path = join(dir, 'feed.json');
    const res = await new FilePublisher(path, { publisherDid: DID }).publish([record('openai')]);

    const feed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(feed.$type).toBe('app.pullpds.feed');
    expect(feed.did).toBe(DID);
    expect(feed.records).toHaveLength(1);
    expect(res).toEqual({ published: 1, destination: path });
  });

  it('creates the parent directory so first-run setup is one command', async () => {
    const path = join(dir, 'nested', 'deeper', 'feed.json');
    await new FilePublisher(path, { publisherDid: DID }).publish([record('openai')]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toHaveProperty('$type', 'app.pullpds.feed');
  });

  it('writes the whole run as ONE snapshot (a partial feed would delete endpoints)', async () => {
    const path = join(dir, 'feed.json');
    await new FilePublisher(path, { publisherDid: DID }).publish([record('openai'), record('anthropic')]);
    const feed = JSON.parse(readFileSync(path, 'utf8')) as { records: { rkey: string }[] };
    expect(feed.records.map((r) => r.rkey)).toEqual(['openai', 'anthropic']);
  });

  it('leaves no temp file behind and overwrites atomically across overlapping runs', async () => {
    const path = join(dir, 'feed.json');
    const pub = new FilePublisher(path, { publisherDid: DID });
    // Two runs racing: the file must always parse as a complete feed, and the
    // last writer wins (each run is a full snapshot of the same endpoints).
    await Promise.all([pub.publish([record('openai')]), pub.publish([record('anthropic')])]);
    const feed = JSON.parse(readFileSync(path, 'utf8')) as { records: { rkey: string }[] };
    expect(feed.records).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('overwrites a pre-existing feed rather than appending to it', async () => {
    const path = join(dir, 'feed.json');
    writeFileSync(path, '{"stale": true}');
    await new FilePublisher(path, { publisherDid: DID }).publish([record('openai')]);
    const feed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(feed).not.toHaveProperty('stale');
  });
});

describe('DryRunPublisher', () => {
  it('writes nothing and reports zero published', async () => {
    const res = await new DryRunPublisher().publish([record('openai')]);
    expect(res.published).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('createPublisher', () => {
  it('builds the file and dry-run publishers from a config target', () => {
    expect(createPublisher({ kind: 'file', path: join(dir, 'f.json') }, { publisherDid: DID }).kind).toBe('file');
    expect(createPublisher({ kind: 'dryrun' }, { publisherDid: DID }).kind).toBe('dryrun');
  });

  it('builds the bluesky publisher when its password env var is set', () => {
    const pub = createPublisher(BSKY_TARGET, { publisherDid: DID, env: { [PW_ENV]: 'fake-app-password' } });
    expect(pub.kind).toBe('bluesky');
    expect(pub).toBeInstanceOf(BlueskyPublisher);
  });

  it('refuses the bluesky target before probing when the password env var is unset', () => {
    // Detected at construction, which is before runOnce spends money on probes.
    expect(() => createPublisher(BSKY_TARGET, { publisherDid: DID, env: {} })).toThrow(
      PublisherUnavailableError,
    );
    expect(() => createPublisher(BSKY_TARGET, { publisherDid: DID, env: { [PW_ENV]: '   ' } })).toThrow(
      /BSKY_APP_PASSWORD/,
    );
  });
});

// --------------------------------------------------------------------------
// BlueskyPublisher
//
// Every one of these runs against a fake transport. Nothing here opens a
// socket, and the only "password" in the file is the obviously fake literal
// below - a real credential lives in the environment and never in a fixture.
// --------------------------------------------------------------------------

const PW_ENV = 'BSKY_APP_PASSWORD';
const FAKE_PASSWORD = 'fake-app-password-not-real';
const BSKY_TARGET = {
  kind: 'bluesky',
  service: 'https://bsky.social',
  identifier: 'node.example.social',
  passwordEnv: PW_ENV,
} as const;
const FAKE_CID = 'bafyreie7udzgpn6ryshclahm7izc44sthh5qwdn6suwx4rtmqgc5uctpbm';

function jsonRes(status: number, json: unknown, headers: Record<string, string> = {}): XrpcResponse {
  return {
    status,
    headers: new Map(Object.entries(headers)),
    body: new TextEncoder().encode(JSON.stringify(json)),
  };
}

interface FakeCall {
  nsid: string;
  body: Record<string, unknown> | undefined;
  auth: string | undefined;
}

type Handler = (call: FakeCall, nth: number) => XrpcResponse;

/**
 * A scripted PDS. Defaults are the happy path observed live (200 on
 * createSession, 200 + `validationStatus: "unknown"` on putRecord); a test
 * overrides only the NSID it is interested in.
 */
function fakePds(overrides: Record<string, Handler> = {}): {
  transport: XrpcTransport;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const counts = new Map<string, number>();
  const defaults: Record<string, Handler> = {
    'com.atproto.server.createSession': () =>
      jsonRes(200, { did: DID, handle: BSKY_TARGET.identifier, accessJwt: 'access-1', refreshJwt: 'refresh-1' }),
    'com.atproto.server.refreshSession': () =>
      jsonRes(200, { did: DID, accessJwt: 'access-2', refreshJwt: 'refresh-2' }),
    'com.atproto.repo.putRecord': (c) =>
      jsonRes(200, {
        uri: `at://${DID}/${String(c.body?.collection)}/${String(c.body?.rkey)}`,
        cid: FAKE_CID,
        validationStatus: 'unknown',
      }),
  };
  const transport: XrpcTransport = async (req) => {
    const nsid = req.url.split('/xrpc/')[1] as string;
    const call: FakeCall = {
      nsid,
      body: req.body === undefined ? undefined : JSON.parse(new TextDecoder().decode(req.body)),
      auth: req.headers.authorization,
    };
    calls.push(call);
    const n = (counts.get(nsid) ?? 0) + 1;
    counts.set(nsid, n);
    const handler = overrides[nsid] ?? defaults[nsid];
    if (!handler) throw new Error(`fake PDS got an unexpected NSID: ${nsid}`);
    return handler(call, n);
  };
  return { transport, calls };
}

function bskyPublisher(transport: XrpcTransport): Publisher {
  return createPublisher(BSKY_TARGET, {
    publisherDid: DID,
    env: { [PW_ENV]: FAKE_PASSWORD },
    transport,
  });
}

describe('BlueskyPublisher', () => {
  it('opens ONE session and writes one putRecord per record', async () => {
    const { transport, calls } = fakePds();
    const res = await bskyPublisher(transport).publish([record('openai'), record('anthropic')]);

    expect(res.published).toBe(2);
    expect(res.destination).toContain(DID);
    expect(calls.filter((c) => c.nsid === 'com.atproto.server.createSession')).toHaveLength(1);
    const puts = calls.filter((c) => c.nsid === 'com.atproto.repo.putRecord');
    expect(puts.map((c) => c.body?.rkey)).toEqual(['openai', 'anthropic']);
    expect(puts[0]?.body?.repo).toBe(DID);
    expect(puts[0]?.body?.collection).toBe(ERROR_METRICS_NSID);
    expect(puts[0]?.auth).toBe('Bearer access-1');
  });

  it('never asks the PDS to validate - that request is a hard 400 for a custom lexicon', async () => {
    // Verified live: `validate: true` returns
    // `400 InvalidRequest - Unknown lexicon type: org.peertelemetry.errorMetrics`.
    // Omitting the flag is what makes the write succeed, so assert it stays absent.
    const { transport, calls } = fakePds();
    await bskyPublisher(transport).publish([record('openai')]);
    const put = calls.find((c) => c.nsid === 'com.atproto.repo.putRecord');
    expect(put?.body).not.toHaveProperty('validate');
  });

  it('sends the password only to createSession, and never as a bearer token', async () => {
    const { transport, calls } = fakePds();
    await bskyPublisher(transport).publish([record('openai')]);

    const session = calls.find((c) => c.nsid === 'com.atproto.server.createSession');
    expect(session?.body?.password).toBe(FAKE_PASSWORD);
    expect(session?.auth).toBeUndefined();
    // Nowhere else, in any form.
    const everythingElse = calls.filter((c) => c.nsid !== 'com.atproto.server.createSession');
    expect(JSON.stringify(everythingElse)).not.toContain(FAKE_PASSWORD);
  });

  it('refreshes and retries when the PDS answers 400 ExpiredToken (NOT 401)', async () => {
    // This is the shape a real bsky.social PDS returns for a stale access token.
    // A publisher that only watched for 401 would never recover.
    let firstPut = true;
    const { transport, calls } = fakePds({
      'com.atproto.repo.putRecord': (c) => {
        if (firstPut) {
          firstPut = false;
          return jsonRes(400, { error: 'ExpiredToken', message: 'Token has expired' });
        }
        return jsonRes(200, { uri: `at://${DID}/x/${String(c.body?.rkey)}`, cid: FAKE_CID });
      },
    });
    const res = await bskyPublisher(transport).publish([record('openai')]);

    expect(res.published).toBe(1);
    expect(calls.filter((c) => c.nsid === 'com.atproto.server.refreshSession')).toHaveLength(1);
    const puts = calls.filter((c) => c.nsid === 'com.atproto.repo.putRecord');
    expect(puts[0]?.auth).toBe('Bearer access-1');
    expect(puts[1]?.auth).toBe('Bearer access-2'); // the refreshed token
  });

  it('refreshes and retries on a plain 401 too', async () => {
    let first = true;
    const { transport, calls } = fakePds({
      'com.atproto.repo.putRecord': () => {
        if (first) {
          first = false;
          return jsonRes(401, { error: 'AuthenticationRequired', message: 'nope' });
        }
        return jsonRes(200, { uri: `at://${DID}/x/y`, cid: FAKE_CID });
      },
    });
    expect((await bskyPublisher(transport).publish([record('openai')])).published).toBe(1);
    expect(calls.filter((c) => c.nsid === 'com.atproto.server.refreshSession')).toHaveLength(1);
  });

  it('falls back to a fresh createSession when the refresh token is spent', async () => {
    let first = true;
    const { transport, calls } = fakePds({
      'com.atproto.repo.putRecord': () => {
        if (first) {
          first = false;
          return jsonRes(400, { error: 'ExpiredToken', message: 'Token has expired' });
        }
        return jsonRes(200, { uri: `at://${DID}/x/y`, cid: FAKE_CID });
      },
      'com.atproto.server.refreshSession': () =>
        jsonRes(400, { error: 'ExpiredToken', message: 'Refresh token has expired' }),
    });
    const res = await bskyPublisher(transport).publish([record('openai')]);

    expect(res.published).toBe(1);
    // Twice: the initial login, then the re-login after the refresh was refused.
    expect(calls.filter((c) => c.nsid === 'com.atproto.server.createSession')).toHaveLength(2);
  });

  it('retries an auth failure exactly ONCE - a rejected credential must not loop', async () => {
    const { transport, calls } = fakePds({
      'com.atproto.repo.putRecord': () => jsonRes(400, { error: 'InvalidToken', message: 'no' }),
    });
    await expect(bskyPublisher(transport).publish([record('openai')])).rejects.toThrow(PublishError);
    expect(calls.filter((c) => c.nsid === 'com.atproto.repo.putRecord')).toHaveLength(2);
  });

  it('refuses to write when the session DID is not the configured publisherDid', async () => {
    // Otherwise every record lands, permanently and immutably, in a repo the
    // config does not claim.
    const { transport, calls } = fakePds({
      'com.atproto.server.createSession': () =>
        jsonRes(200, { did: 'did:plc:somebodyelse', accessJwt: 'a', refreshJwt: 'r' }),
    });
    await expect(bskyPublisher(transport).publish([record('openai')])).rejects.toThrow(
      /does not match/,
    );
    expect(calls.filter((c) => c.nsid === 'com.atproto.repo.putRecord')).toHaveLength(0);
  });

  it('publishes the records it can when one of them is rejected', async () => {
    const { transport } = fakePds({
      'com.atproto.repo.putRecord': (c) =>
        c.body?.rkey === 'anthropic'
          ? jsonRes(400, { error: 'InvalidRequest', message: 'bad record' })
          : jsonRes(200, { uri: `at://${DID}/x/y`, cid: FAKE_CID }),
    });
    const res = await bskyPublisher(transport).publish([
      record('openai'),
      record('anthropic'),
      record('groq'),
    ]);
    expect(res.published).toBe(2);
  });

  it('fails the run when the destination accepted nothing at all', async () => {
    const { transport } = fakePds({
      'com.atproto.repo.putRecord': () => jsonRes(500, { error: 'InternalServerError' }),
    });
    await expect(bskyPublisher(transport).publish([record('openai')])).rejects.toThrow(PublishError);
  });

  it('names the env var but never the password when the login is refused', async () => {
    const { transport } = fakePds({
      'com.atproto.server.createSession': () =>
        jsonRes(401, { error: 'AuthenticationRequired', message: 'Invalid identifier or password' }),
    });
    await expect(bskyPublisher(transport).publish([record('openai')])).rejects.toThrow(
      /BSKY_APP_PASSWORD/,
    );
    await expect(bskyPublisher(transport).publish([record('openai')])).rejects.not.toThrow(
      new RegExp(FAKE_PASSWORD),
    );
  });

  it('rejects a session reply that is missing its tokens, without echoing the body', async () => {
    const { transport } = fakePds({
      'com.atproto.server.createSession': () => jsonRes(200, { did: DID }),
    });
    await expect(bskyPublisher(transport).publish([record('openai')])).rejects.toThrow(
      /missing did\/accessJwt\/refreshJwt/,
    );
  });

  it('tolerates a non-JSON error page from something in front of the PDS', async () => {
    const { transport } = fakePds({
      'com.atproto.server.createSession': () => ({
        status: 502,
        headers: new Map(),
        body: new TextEncoder().encode('<html>Bad Gateway</html>'),
      }),
    });
    await expect(bskyPublisher(transport).publish([record('openai')])).rejects.toThrow(PublishError);
  });
});

/**
 * A recording publisher standing in for any future destination - the proof that
 * the daemon talks only to the interface, so a new publisher drops in without
 * touching probe/aggregate/run.
 */
class RecordingPublisher implements Publisher {
  readonly kind = 'recording';
  readonly batches: TelemetryRecord[][] = [];
  async publish(records: readonly TelemetryRecord[]): Promise<{ published: number; destination: string }> {
    this.batches.push([...records]);
    return { published: records.length, destination: 'memory' };
  }
}

function cfg(patch: Record<string, unknown> = {}): ProberConfig {
  return parseProberConfig({
    publisherDid: DID,
    endpoints: [
      { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'K' },
    ],
    ...patch,
  });
}

const okTransport: ProbeTransport = async () => ({ status: 200, body: new Uint8Array() });
const failTransport =
  (status: number, body: unknown): ProbeTransport =>
  async () => ({ status, body: new TextEncoder().encode(JSON.stringify(body)) });

describe('runOnce - the daemon only ever sees the Publisher interface', () => {
  it('publishes one batch containing every endpoint, and exits 0', async () => {
    const publisher = new RecordingPublisher();
    const summary = await runOnce(cfg(), { transport: okTransport, publisher, env: { K: 'fake-key' } });
    expect(summary.exitCode).toBe(0);
    expect(summary.publisher).toBe('recording');
    expect(publisher.batches).toHaveLength(1);
    expect(publisher.batches[0]).toHaveLength(1);
    expect(summary.published).toBe(1);
  });

  it('treats a provider outage as data: the record carries it and the run exits 0', async () => {
    const publisher = new RecordingPublisher();
    const summary = await runOnce(cfg(), {
      transport: failTransport(503, { error: { type: 'server_error' } }),
      publisher,
      env: { K: 'fake-key' },
    });
    expect(summary.exitCode).toBe(0);
    const rec = publisher.batches[0]?.[0]?.record as Record<string, unknown>;
    expect(rec.errors).toEqual([{ code: 'server_error', count: 1 }]);
    expect(rec.totalErrors).toBe(1);
  });

  it('treats a missing credential as an operator problem: no record, exit 1', async () => {
    const publisher = new RecordingPublisher();
    const summary = await runOnce(cfg(), { transport: okTransport, publisher, env: {} });
    expect(summary.exitCode).toBe(1);
    expect(summary.skipped[0]?.reason).toContain('K');
    // Critically, no record is emitted: publishing "0 errors" for a provider we
    // never contacted would be a fabricated clean bill of health.
    expect(publisher.batches).toHaveLength(0);
  });

  it('never lets a credential reach the published record', async () => {
    const publisher = new RecordingPublisher();
    const seen: ProbeHttpRequest[] = [];
    const spy: ProbeTransport = async (req) => {
      seen.push(req);
      return { status: 200, body: new Uint8Array() };
    };
    await runOnce(cfg(), { transport: spy, publisher, env: { K: 'fake-secret-value' } });
    // The key goes on the wire (it must) ...
    expect(seen[0]?.headers.authorization).toBe('Bearer fake-secret-value');
    // ... and nowhere near the record.
    expect(JSON.stringify(publisher.batches)).not.toContain('fake-secret-value');
  });

  it('drops an endpoint whose record fails lexicon validation instead of publishing it', async () => {
    const publisher = new RecordingPublisher();
    const summary = await runOnce(cfg(), {
      transport: okTransport,
      publisher,
      env: { K: 'fake-key' },
      validateRecord: () => 'pretend the schema rejected this',
    });
    expect(summary.exitCode).toBe(1);
    expect(publisher.batches).toHaveLength(0);
    expect(summary.skipped[0]?.reason).toContain('lexicon validation');
  });

  it('runs every endpoint even when one of them times out', async () => {
    const publisher = new RecordingPublisher();
    let call = 0;
    const flaky: ProbeTransport = async () => {
      call++;
      if (call === 1) throw new ProbeTransportError('timeout', 'timed out');
      return { status: 200, body: new Uint8Array() };
    };
    const summary = await runOnce(
      cfg({
        endpoints: [
          { provider: 'openai', model: 'a', baseUrl: 'https://one.example/v1' },
          { provider: 'anthropic', model: 'b', baseUrl: 'https://two.example' },
        ],
      }),
      { transport: flaky, publisher, env: {} },
    );
    expect(summary.exitCode).toBe(0);
    expect(publisher.batches[0]).toHaveLength(2);
    const first = publisher.batches[0]?.[0]?.record as Record<string, unknown>;
    expect(first.errors).toEqual([{ code: 'timeout', count: 1 }]);
  });

  it('writes a real feed file end to end through the file publisher', async () => {
    const path = join(dir, 'feed.json');
    const summary = await runOnce(cfg({ publish: { kind: 'file', path } }), {
      transport: okTransport,
      env: { K: 'fake-key' },
    });
    expect(summary.exitCode).toBe(0);
    const feed = JSON.parse(readFileSync(path, 'utf8')) as {
      did: string;
      records: { collection: string; rkey: string }[];
    };
    expect(feed.did).toBe(DID);
    expect(feed.records[0]?.collection).toBe(ERROR_METRICS_NSID);
    expect(feed.records[0]?.rkey).toBe('openai_gpt-4o-mini');
  });

  it('drives the bluesky publisher end to end without a socket or a leaked key', async () => {
    const { transport, calls } = fakePds();
    // The config still carries the bluesky target (so it must parse); the
    // publisher is injected only to hand it the fake transport.
    const summary = await runOnce(cfg({ publish: { ...BSKY_TARGET } }), {
      transport: okTransport,
      publisher: bskyPublisher(transport),
      env: { K: 'fake-provider-key' },
    });

    expect(summary.exitCode).toBe(0);
    expect(summary.publisher).toBe('bluesky');
    expect(summary.published).toBe(1);

    const put = calls.find((c) => c.nsid === 'com.atproto.repo.putRecord');
    expect(put?.body?.rkey).toBe('openai_gpt-4o-mini');
    const written = put?.body?.record as Record<string, unknown>;
    expect(written.$type).toBe(ERROR_METRICS_NSID);
    // Neither the provider key nor the app password reaches the repo.
    expect(JSON.stringify(written)).not.toContain('fake-provider-key');
    expect(JSON.stringify(written)).not.toContain(FAKE_PASSWORD);
  });
});
