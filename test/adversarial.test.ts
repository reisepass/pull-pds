import { describe, it, expect } from 'vitest';
import { SqliteRepoStorage } from '../src/storage/sqlite-repo-store.js';
import { SqliteSequencerStore } from '../src/storage/sqlite-sequencer-store.js';
import { RepoManager } from '../src/repo/repo-manager.js';
import { Sequencer } from '../src/firehose/sequencer.js';
import { FirehoseService } from '../src/firehose/service.js';
import { pdsKeyFromKeypair } from '../src/repo/signing-key.js';
import { IngestPipeline } from '../src/pds-websub/ingest.js';
import type { IngestDeps, EtagStore, SeenStore } from '../src/pds-websub/ingest.js';
import { pdsConfigFromEnv } from '../src/pds-websub/config.js';
import { DEFAULT_RESOLVER_CONFIG } from '../src/config.js';
import type { GuardedResponse } from '../src/net/guarded-fetch.js';
import { parseFeed, FeedError } from '../src/pds-websub/feed.js';
import { newKeypair, multikeyFor } from './helpers.js';
import type { PdsKey } from '../src/repo/signing-key.js';

/**
 * Adversarial + conformance sweep. Each test either pins a defense that
 * already holds, or is a regression guard for a real defect. Nothing here is weakened to pass: a
 * test that catches a real bug fails until the bug is fixed.
 *
 * The ingest harness mirrors test/ingest.test.ts so the same IngestPipeline code
 * path is exercised with adversarial inputs.
 */

const SELF = 'https://agg.example';
const HOST = 'node.test.example';
const DID = `did:web:${HOST}`;
const COLL = 'com.example.custom.record';
const TOPIC = `https://${HOST}/atproto/feed.json`;

function res(body: string, headers: Record<string, string> = {}): GuardedResponse {
  const bytes = new TextEncoder().encode(body);
  const h = new Map(Object.entries({ 'content-type': 'application/json', ...headers }));
  return { status: 200, headers: h, body: bytes, url: TOPIC, peerAddress: '203.0.113.5' };
}

/** Raw feed body so a test can inject numbers JSON.stringify would refuse to keep intact. */
function rawFeed(recordsJson: string, did = DID): string {
  return `{"$type":"app.pullpds.feed","did":"${did}","records":${recordsJson}}`;
}

function didDoc(aggMultikey: string, opts: { endpoint?: string; id?: string; multikey?: string } = {}) {
  return JSON.stringify({
    id: opts.id ?? DID,
    alsoKnownAs: [`at://${HOST}`],
    verificationMethod: [
      { id: `${DID}#atproto`, type: 'Multikey', controller: DID, publicKeyMultibase: opts.multikey ?? aggMultikey },
    ],
    service: [
      { id: `${DID}#atproto_pds`, type: 'AtprotoPersonalDataServer', serviceEndpoint: opts.endpoint ?? SELF },
    ],
  });
}

interface Harness {
  pipeline: IngestPipeline;
  seq: Sequencer;
  pdsKey: PdsKey;
  managers: Map<string, RepoManager>;
  setDidDoc: (body: string) => void;
  setFeed: (r: GuardedResponse | (() => Promise<GuardedResponse>)) => void;
}

async function harness(overrides: Partial<IngestDeps> = {}, aggConfigOverrides = {}): Promise<Harness> {
  const kp = await newKeypair();
  const pdsKey = pdsKeyFromKeypair(kp);
  const seq = new Sequencer(new SqliteSequencerStore());
  const firehose = new FirehoseService(seq);
  const managers = new Map<string, RepoManager>();
  const etags = new Map<string, string>();
  const seen = new Set<string>();

  let didDocBody = didDoc(pdsKey.publicKeyMultibase);
  let feedResponder: GuardedResponse | (() => Promise<GuardedResponse>) = res(
    rawFeed(`[{"collection":"${COLL}","rkey":"current","record":{"$type":"${COLL}","n":1}}]`),
  );

  const resolverTransport = async (url: string): Promise<GuardedResponse> => {
    if (url.endsWith('/.well-known/did.json')) {
      return { status: 200, headers: new Map(), body: new TextEncoder().encode(didDocBody), url, peerAddress: '203.0.113.5' };
    }
    throw new Error(`unexpected resolver url ${url}`);
  };
  const feedTransport = async (): Promise<GuardedResponse> =>
    typeof feedResponder === 'function' ? feedResponder() : feedResponder;

  const etagStore: EtagStore = { get: (d) => etags.get(d) ?? null, set: (d, e) => void etags.set(d, e) };
  const seenStore: SeenStore = { has: (d) => seen.has(d), add: (d) => void seen.add(d) };

  const deps: IngestDeps = {
    resolverDeps: { resolver: async () => ['203.0.113.5'], transport: resolverTransport },
    feedTransport,
    repoFor: async (did) => {
      let m = managers.get(did);
      if (!m) {
        m = new RepoManager(new SqliteRepoStorage(did), pdsKey.signer);
        managers.set(did, m);
      }
      return m;
    },
    firehose,
    pdsKey,
    etagStore,
    seenStore,
    nowIso: () => '2026-07-21T12:00:00Z',
    ...overrides,
  };

  const agg = pdsConfigFromEnv({ selfEndpoint: SELF, allowedCollections: [COLL], ...aggConfigOverrides }, {} as NodeJS.ProcessEnv);
  const resolverConfig = { ...DEFAULT_RESOLVER_CONFIG, serviceEndpoint: SELF };
  const pipeline = new IngestPipeline(agg, resolverConfig, deps);

  return {
    pipeline, seq, pdsKey, managers,
    setDidDoc: (b) => { didDocBody = b; },
    setFeed: (r) => { feedResponder = r; },
  };
}

// ---------------------------------------------------------------------------
// F-12: a non-safe-integer / non-integer number in a feed record must be a
// clean, batch-atomic feed rejection, NOT the generic `internal` catch-all.
// ---------------------------------------------------------------------------

describe('F-12: unencodable numbers in a feed record', () => {
  const feedOpts = { expectedDid: DID, allowedCollections: [COLL], maxRecords: 100 };

  it('an integer beyond 2^53 is rejected by parseFeed, batch-atomically', () => {
    // 9007199254740993 is not exactly representable; the DAG-CBOR encoder throws
    // "Non-integer numbers are not supported by the AT Data Model" deep in the
    // diff. parseFeed must reject it up front with a clear code.
    const body = new TextEncoder().encode(
      rawFeed(`[{"collection":"${COLL}","rkey":"a","record":{"$type":"${COLL}","n":9007199254740993}}]`),
    );
    let code = 'NO-THROW';
    try {
      parseFeed(body, feedOpts);
    } catch (e) {
      code = e instanceof FeedError ? e.code : `OTHER:${(e as Error).message}`;
    }
    expect(code).toBe('record-not-encodable');
  });

  it('a fractional number is rejected by parseFeed', () => {
    const body = new TextEncoder().encode(
      rawFeed(`[{"collection":"${COLL}","rkey":"a","record":{"$type":"${COLL}","n":1.5}}]`),
    );
    let code = 'NO-THROW';
    try {
      parseFeed(body, feedOpts);
    } catch (e) {
      code = e instanceof FeedError ? e.code : `OTHER:${(e as Error).message}`;
    }
    expect(code).toBe('record-not-encodable');
  });

  it('a huge exponential number is rejected by parseFeed', () => {
    const body = new TextEncoder().encode(
      rawFeed(`[{"collection":"${COLL}","rkey":"a","record":{"$type":"${COLL}","n":1e21}}]`),
    );
    let code = 'NO-THROW';
    try {
      parseFeed(body, feedOpts);
    } catch (e) {
      code = e instanceof FeedError ? e.code : `OTHER:${(e as Error).message}`;
    }
    expect(code).toBe('record-not-encodable');
  });

  it('the safe-integer boundary values are still accepted', () => {
    const body = new TextEncoder().encode(
      rawFeed(`[{"collection":"${COLL}","rkey":"a","record":{"$type":"${COLL}","hi":9007199254740991,"lo":-9007199254740991,"zero":0}}]`),
    );
    const parsed = parseFeed(body, feedOpts);
    expect(parsed.records).toHaveLength(1);
  });

  it('a nested unsafe integer (inside an array/object) is still caught', () => {
    const body = new TextEncoder().encode(
      rawFeed(`[{"collection":"${COLL}","rkey":"a","record":{"$type":"${COLL}","errors":[{"code":"429","count":9007199254740993}]}}]`),
    );
    let code = 'NO-THROW';
    try {
      parseFeed(body, feedOpts);
    } catch (e) {
      code = e instanceof FeedError ? e.code : `OTHER:${(e as Error).message}`;
    }
    expect(code).toBe('record-not-encodable');
  });

  it('through the full ingest pipeline: rejected with a feed code, NOT internal, repo untouched', async () => {
    const h = await harness();
    h.setFeed(res(rawFeed(`[{"collection":"${COLL}","rkey":"a","record":{"$type":"${COLL}","n":9007199254740993}}]`)));
    const seqBefore = h.seq.currentSeq();
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') {
      expect(out.code).toBe('record-not-encodable');
      expect(out.code).not.toBe('internal');
    }
    expect(h.seq.currentSeq()).toBe(seqBefore);
    expect(h.managers.get(DID)?.getRoot() ?? null).toBeNull();
  });

  it('an unsafe integer buried in an otherwise-valid batch rejects the whole batch', async () => {
    const h = await harness();
    h.setFeed(res(rawFeed(
      `[{"collection":"${COLL}","rkey":"good","record":{"$type":"${COLL}","n":1}},` +
      `{"collection":"${COLL}","rkey":"bad","record":{"$type":"${COLL}","n":9007199254740993}}]`,
    )));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('record-not-encodable');
    expect(h.managers.get(DID)?.getRoot() ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Binding checks that already hold - pin them so a refactor cannot regress.
// ---------------------------------------------------------------------------

describe('identity binding (pinned defenses)', () => {
  async function expectRejectedUnchanged(h: Harness, code: string) {
    const seqBefore = h.seq.currentSeq();
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe(code);
    expect(h.seq.currentSeq()).toBe(seqBefore);
    expect(h.managers.get(DID)?.getRoot() ?? null).toBeNull();
  }

  it('a feed whose did claims a different identity than its origin => did-mismatch', async () => {
    const h = await harness();
    h.setFeed(res(rawFeed(`[{"collection":"${COLL}","rkey":"a","record":{"$type":"${COLL}","n":1}}]`, 'did:web:victim.example')));
    await expectRejectedUnchanged(h, 'did-mismatch');
  });

  it('a did.json whose #atproto_pds points elsewhere => binding-endpoint', async () => {
    const h = await harness();
    h.setDidDoc(didDoc(h.pdsKey.publicKeyMultibase, { endpoint: 'https://evil.example' }));
    await expectRejectedUnchanged(h, 'binding-endpoint');
  });

  it('a did.json advertising a different #atproto key => binding-key', async () => {
    const h = await harness();
    const other = await newKeypair();
    h.setDidDoc(didDoc(h.pdsKey.publicKeyMultibase, { multikey: await multikeyFor(other) }));
    await expectRejectedUnchanged(h, 'binding-key');
  });

  it('a non-https topic is rejected before any fetch', async () => {
    const h = await harness();
    const out = await h.pipeline.ingest('http://node.test.example/atproto/feed.json');
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('topic-not-https');
  });

  it('an oplog-shaped feed (ops, no records array) fails closed, never a mass delete', () => {
    // The descriptor can advertise ingestMode:oplog, but the parser only
    // implements snapshot. An oplog body must be rejected, NOT read as an empty
    // snapshot that deletes the whole repo.
    let code = 'NO-THROW';
    try {
      parseFeed(
        new TextEncoder().encode(`{"$type":"app.pullpds.feed","did":"${DID}","cursor":"3l","ops":[{"action":"put","collection":"${COLL}","rkey":"a","record":{}}]}`),
        { expectedDid: DID, allowedCollections: [COLL], maxRecords: 100 },
      );
    } catch (e) {
      code = e instanceof FeedError ? e.code : `OTHER:${(e as Error).message}`;
    }
    expect(code).toBe('not-a-feed');
  });
});

// ---------------------------------------------------------------------------
// Ingest resource limits - the boundary, not just past it.
// ---------------------------------------------------------------------------

describe('ingest resource limits (pinned)', () => {
  const feedOpts = (cap: number) => ({ expectedDid: DID, allowedCollections: [COLL], maxRecords: cap });
  const manyRecords = (n: number) =>
    JSON.stringify({
      $type: 'app.pullpds.feed',
      did: DID,
      records: Array.from({ length: n }, (_, i) => ({ collection: COLL, rkey: `r${i}`, record: { $type: COLL, n: i } })),
    });

  it('a feed exactly at maxRecords is accepted; one over is rejected', () => {
    expect(parseFeed(new TextEncoder().encode(manyRecords(10)), feedOpts(10)).records).toHaveLength(10);
    let code = 'NO-THROW';
    try {
      parseFeed(new TextEncoder().encode(manyRecords(11)), feedOpts(10));
    } catch (e) {
      code = e instanceof FeedError ? e.code : `OTHER:${(e as Error).message}`;
    }
    expect(code).toBe('too-many-records');
  });

  it('a record nested exactly at the depth cap is rejected; one under is accepted (F-11 boundary)', () => {
    const nest = (d: number) => {
      let o: Record<string, unknown> = { n: 1 };
      for (let i = 0; i < d; i++) o = { c: o };
      return o;
    };
    const body = (d: number) =>
      new TextEncoder().encode(
        JSON.stringify({ $type: 'app.pullpds.feed', did: DID, records: [{ collection: COLL, rkey: 'a', record: { $type: COLL, ...nest(d) } }] }),
      );
    // MAX_RECORD_DEPTH is 32: depth 31 accepted, depth 32 rejected.
    expect(parseFeed(body(31), feedOpts(100)).records).toHaveLength(1);
    let code = 'NO-THROW';
    try {
      parseFeed(body(32), feedOpts(100));
    } catch (e) {
      code = e instanceof FeedError ? e.code : `OTHER:${(e as Error).message}`;
    }
    expect(code).toBe('record-too-deep');
  });

  it('a feed over the byte cap is rejected as feed-truncated at the transport, repo untouched', async () => {
    // Simulate the guarded transport returning a body whose declared
    // Content-Length disagrees with the received length (a cap-truncated fetch).
    // The pipeline must reject it, never treat it as "delete everything".
    const h = await harness();
    // First seed a repo with two records.
    h.setFeed(res(rawFeed(`[{"collection":"${COLL}","rkey":"a","record":{"$type":"${COLL}","n":1}},{"collection":"${COLL}","rkey":"b","record":{"$type":"${COLL}","n":2}}]`)));
    await h.pipeline.ingest(TOPIC);
    const rootBefore = h.managers.get(DID)?.getRoot()?.toString();
    // Now a "truncated" empty body claiming a large Content-Length.
    h.setFeed(res(rawFeed('[]'), { 'content-length': '99999' }));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('feed-truncated');
    // Repo unchanged: neither record was deleted.
    expect(h.managers.get(DID)?.getRoot()?.toString()).toBe(rootBefore);
  });

  it('a large-but-legal feed (1000 records) commits without error', async () => {
    const h = await harness({}, { maxRecordsPerRepo: 10000 });
    h.setFeed(res(manyRecords(1000)));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('committed');
    if (out.status === 'committed') expect(out.ops).toBe(1000);
  }, 20_000);
});
