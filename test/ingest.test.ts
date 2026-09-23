import { describe, it, expect, beforeEach } from 'vitest';
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
import { newKeypair, multikeyFor } from './helpers.js';
import type { PdsKey } from '../src/repo/signing-key.js';

const SELF = 'https://pds.example';
const HOST = 'node.test.example';
const DID = `did:web:${HOST}`;
const COLL = 'com.example.custom.record';
const TOPIC = `https://${HOST}/atproto/feed.json`;

function res(body: string, headers: Record<string, string> = {}): GuardedResponse {
  const bytes = new TextEncoder().encode(body);
  const h = new Map(Object.entries({ 'content-type': 'application/json', ...headers }));
  return { status: 200, headers: h, body: bytes, url: TOPIC, peerAddress: '203.0.113.5' };
}

function feedJson(records: Array<{ rkey: string; n: number; collection?: string }>): string {
  return JSON.stringify({
    $type: 'app.pullpds.feed',
    did: DID,
    records: records.map((r) => ({
      collection: r.collection ?? COLL,
      rkey: r.rkey,
      record: { $type: COLL, count429: r.n },
    })),
  });
}

/** Build a did.json for the PDS key + a chosen endpoint/key override. */
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
  etags: Map<string, string>;
  seen: Set<string>;
  setDidDoc: (body: string) => void;
  setFeed: (r: GuardedResponse | (() => Promise<GuardedResponse>)) => void;
  denyReason: { value: string | null };
}

async function harness(overrides: Partial<IngestDeps> = {}, aggConfigOverrides = {}): Promise<Harness> {
  const kp = await newKeypair();
  const pdsKey = pdsKeyFromKeypair(kp);
  const seqStore = new SqliteSequencerStore();
  const seq = new Sequencer(seqStore);
  const firehose = new FirehoseService(seq);
  const managers = new Map<string, RepoManager>();
  const etags = new Map<string, string>();
  const seen = new Set<string>();
  const denyReason = { value: null as string | null };

  let didDocBody = didDoc(pdsKey.publicKeyMultibase);
  let feedResponder: GuardedResponse | (() => Promise<GuardedResponse>) = res(feedJson([{ rkey: 'current', n: 1 }]));

  // Fake resolver transport: returns the current did.json for the did.json URL.
  const resolverTransport = async (url: string): Promise<GuardedResponse> => {
    if (url.endsWith('/.well-known/did.json')) {
      return { status: 200, headers: new Map(), body: new TextEncoder().encode(didDocBody), url, peerAddress: '203.0.113.5' };
    }
    throw new Error(`unexpected resolver url ${url}`);
  };
  const feedTransport = async (): Promise<GuardedResponse> =>
    typeof feedResponder === 'function' ? feedResponder() : feedResponder;

  const etagStore: EtagStore = {
    get: (d) => etags.get(d) ?? null,
    set: (d, e) => void etags.set(d, e),
  };
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
    admit: () => denyReason.value,
    nowIso: () => '2026-07-21T12:00:00Z',
    ...overrides,
  };

  const pds = pdsConfigFromEnv({ selfEndpoint: SELF, allowedCollections: [COLL], ...aggConfigOverrides }, {} as NodeJS.ProcessEnv);
  const resolverConfig = { ...DEFAULT_RESOLVER_CONFIG, serviceEndpoint: SELF };
  const pipeline = new IngestPipeline(pds, resolverConfig, deps);

  return {
    pipeline, seq, pdsKey, managers, etags, seen, denyReason,
    setDidDoc: (b) => { didDocBody = b; },
    setFeed: (r) => { feedResponder = r; },
  };
}

describe('ingest pipeline - happy path', () => {
  it('resolves, binds, pulls, diffs, commits, and emits on the firehose', async () => {
    const h = await harness();
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('committed');
    if (out.status === 'committed') {
      expect(out.ops).toBe(1);
      expect(out.rev).toBeTruthy();
    }
    // firehose got identity/account/sync/commit
    const types = h.seq.readSince(0, 100).map((e) => e.type);
    expect(types).toEqual(['#identity', '#account', '#sync', '#commit']);
  });

  it('unchanged feed on second ping => no-change (empty-diff), no new commit', async () => {
    const h = await harness();
    await h.pipeline.ingest(TOPIC);
    const seqBefore = h.seq.currentSeq();
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('no-change');
    expect(h.seq.currentSeq()).toBe(seqBefore);
  });

  it('incremental update produces a #commit with an update op and correct since', async () => {
    const h = await harness();
    await h.pipeline.ingest(TOPIC);
    h.setFeed(res(feedJson([{ rkey: 'current', n: 999 }])));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('committed');
  });

  it('removing a record from the snapshot deletes it', async () => {
    const h = await harness();
    h.setFeed(res(feedJson([{ rkey: 'a', n: 1 }, { rkey: 'b', n: 2 }])));
    await h.pipeline.ingest(TOPIC);
    h.setFeed(res(feedJson([{ rkey: 'a', n: 1 }])));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('committed');
    if (out.status === 'committed') expect(out.ops).toBe(1); // one delete
  });
});

describe('ingest pipeline - binding attacks (repo must be untouched)', () => {
  async function expectRejectedUnchanged(
    h: Harness,
    code: string,
  ) {
    const seqBefore = h.seq.currentSeq();
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe(code);
    expect(h.seq.currentSeq()).toBe(seqBefore); // no firehose event
    expect(h.managers.get(DID)?.getRoot() ?? null).toBeNull(); // repo empty
  }

  it('#atproto_pds pointing at someone else => binding-endpoint', async () => {
    const h = await harness();
    h.setDidDoc(didDoc(h.pdsKey.publicKeyMultibase, { endpoint: 'https://evil.example' }));
    await expectRejectedUnchanged(h, 'binding-endpoint');
  });

  it('#atproto key is not the PDS key => binding-key', async () => {
    const h = await harness();
    const other = await newKeypair();
    h.setDidDoc(didDoc(h.pdsKey.publicKeyMultibase, { multikey: await multikeyFor(other) }));
    await expectRejectedUnchanged(h, 'binding-key');
  });

  it('did.json id does not match the host => rejected, repo untouched', async () => {
    const h = await harness();
    h.setDidDoc(didDoc(h.pdsKey.publicKeyMultibase, { id: 'did:web:someone.else.example' }));
    const seqBefore = h.seq.currentSeq();
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    expect(h.seq.currentSeq()).toBe(seqBefore);
  });
});

describe('ingest pipeline - feed abuse (batch atomic)', () => {
  it('off-allowlist collection buried in a valid batch => whole batch rejected', async () => {
    const h = await harness();
    h.setFeed(res(feedJson([
      { rkey: 'ok', n: 1 },
      { rkey: 'evil', n: 2, collection: 'app.bsky.feed.post' },
    ])));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('collection-not-allowed');
    expect(h.managers.get(DID)?.getRoot() ?? null).toBeNull();
  });

  it('duplicate (collection, rkey) => rejected', async () => {
    const h = await harness();
    h.setFeed(res(feedJson([{ rkey: 'dup', n: 1 }, { rkey: 'dup', n: 2 }])));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('duplicate-key');
  });

  it('path-traversal rkey (../../etc/passwd) => invalid-record, repo untouched (F-6)', async () => {
    const h = await harness();
    h.setFeed(res(feedJson([{ rkey: '../../etc/passwd', n: 1 }])));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('invalid-record');
    expect(h.managers.get(DID)?.getRoot() ?? null).toBeNull();
  });

  it('empty rkey => invalid-record', async () => {
    const h = await harness();
    h.setFeed(res(feedJson([{ rkey: '', n: 1 }])));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('invalid-record');
  });

  it('an invalid rkey buried in an otherwise-valid batch rejects the whole batch', async () => {
    const h = await harness();
    h.setFeed(res(feedJson([{ rkey: 'good', n: 1 }, { rkey: 'bad rkey with spaces', n: 2 }])));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('invalid-record');
    expect(h.managers.get(DID)?.getRoot() ?? null).toBeNull();
  });

  it('malformed JSON => rejected, repo untouched', async () => {
    const h = await harness();
    h.setFeed(res('{ not valid json'));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('invalid-json');
  });

  it('feed did mismatch => rejected', async () => {
    const h = await harness();
    h.setFeed(res(JSON.stringify({ $type: 'app.pullpds.feed', did: 'did:web:other.example', records: [] })));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('did-mismatch');
  });

  it('truncated feed (Content-Length mismatch) => feed-truncated, not a mass delete', async () => {
    const h = await harness();
    // First establish a repo with two records.
    h.setFeed(res(feedJson([{ rkey: 'a', n: 1 }, { rkey: 'b', n: 2 }])));
    await h.pipeline.ingest(TOPIC);
    // Now serve an empty feed but declare a much larger Content-Length (a
    // truncated fetch). It must be rejected, NOT treated as "delete a and b".
    h.setFeed(res(feedJson([]), { 'content-length': '99999' }));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('feed-truncated');
  });
});

describe('ingest pipeline - abuse controls', () => {
  it('denylisted DID => denied, repo untouched', async () => {
    const h = await harness();
    h.denyReason.value = 'DID is denylisted';
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('denied');
  });

  it('non-https topic => rejected before any fetch', async () => {
    const h = await harness();
    const out = await h.pipeline.ingest('http://node.test.example/atproto/feed.json');
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('topic-not-https');
  });
});
