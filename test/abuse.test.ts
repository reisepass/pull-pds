import { describe, it, expect } from 'vitest';
import { SqliteRepoStorage } from '../src/storage/sqlite-repo-store.js';
import { SqliteSequencerStore } from '../src/storage/sqlite-sequencer-store.js';
import { RepoManager } from '../src/repo/repo-manager.js';
import { Sequencer } from '../src/firehose/sequencer.js';
import { FirehoseService } from '../src/firehose/service.js';
import { pdsKeyFromKeypair } from '../src/repo/signing-key.js';
import { IngestPipeline } from '../src/pds-websub/ingest.js';
import type { IngestDeps } from '../src/pds-websub/ingest.js';
import { pdsConfigFromEnv } from '../src/pds-websub/config.js';
import { DEFAULT_RESOLVER_CONFIG } from '../src/config.js';
import { MetaStore } from '../src/pds-websub/meta-store.js';
import type { GuardedResponse } from '../src/net/guarded-fetch.js';
import { cborDecodeAll } from '@atproto/lex-cbor';
import { newKeypair } from './helpers.js';

const SELF = 'https://pds.example';
const HOST = 'node.test.example';
const DID = `did:web:${HOST}`;
const COLL = 'app.omniroute.errorReport';
const TOPIC = `https://${HOST}/atproto/feed.json`;

function res(body: string, headers: Record<string, string> = {}): GuardedResponse {
  return {
    status: 200,
    headers: new Map(Object.entries({ 'content-type': 'application/json', ...headers })),
    body: new TextEncoder().encode(body),
    url: TOPIC,
    peerAddress: '203.0.113.5',
  };
}

function feed(records: Array<{ rkey: string; n: number }>): string {
  return JSON.stringify({
    $type: 'app.pullpds.feed',
    did: DID,
    records: records.map((r) => ({ collection: COLL, rkey: r.rkey, record: { $type: COLL, count429: r.n } })),
  });
}

async function harness(opts: { maxDeleteRatio?: number; maxFeedBytes?: number; maxRecords?: number } = {}) {
  const kp = await newKeypair();
  const pdsKey = pdsKeyFromKeypair(kp);
  const seq = new Sequencer(new SqliteSequencerStore());
  const firehose = new FirehoseService(seq);
  const managers = new Map<string, RepoManager>();
  const meta = new MetaStore();
  let feedBody = res(feed([{ rkey: 'a', n: 1 }]));

  const didDoc = JSON.stringify({
    id: DID,
    alsoKnownAs: [`at://${HOST}`],
    verificationMethod: [{ id: `${DID}#atproto`, type: 'Multikey', controller: DID, publicKeyMultibase: pdsKey.publicKeyMultibase }],
    service: [{ id: `${DID}#atproto_pds`, type: 'AtprotoPersonalDataServer', serviceEndpoint: SELF }],
  });

  const deps: IngestDeps = {
    resolverDeps: {
      resolver: async () => ['203.0.113.5'],
      transport: async (url) => ({ status: 200, headers: new Map(), body: new TextEncoder().encode(didDoc), url, peerAddress: '203.0.113.5' }),
    },
    feedTransport: async () => feedBody,
    repoFor: async (did) => {
      let m = managers.get(did);
      if (!m) { m = new RepoManager(new SqliteRepoStorage(did), pdsKey.signer); managers.set(did, m); }
      return m;
    },
    firehose,
    pdsKey,
    etagStore: meta,
    seenStore: meta,
    nowIso: () => '2026-07-21T12:00:00Z',
  };
  if (opts.maxDeleteRatio !== undefined) deps.maxDeleteRatio = opts.maxDeleteRatio;

  const pds = pdsConfigFromEnv(
    {
      selfEndpoint: SELF,
      allowedCollections: [COLL],
      ...(opts.maxFeedBytes !== undefined ? { maxFeedBytes: opts.maxFeedBytes } : {}),
      ...(opts.maxRecords !== undefined ? { maxRecordsPerRepo: opts.maxRecords } : {}),
    },
    {} as NodeJS.ProcessEnv,
  );
  const pipeline = new IngestPipeline(pds, { ...DEFAULT_RESOLVER_CONFIG, serviceEndpoint: SELF }, deps);
  return { pipeline, seq, managers, meta, firehose, setFeed: (b: GuardedResponse) => { feedBody = b; } };
}

describe('abuse: delete-ratio guard (F-D5)', () => {
  it('rejects a non-empty snapshot that would delete more than the allowed fraction', async () => {
    const h = await harness({ maxDeleteRatio: 0.5 });
    h.setFeed(res(feed([{ rkey: 'a', n: 1 }, { rkey: 'b', n: 2 }, { rkey: 'c', n: 3 }, { rkey: 'd', n: 4 }])));
    await h.pipeline.ingest(TOPIC);
    // Now a snapshot keeping only 1 of 4 => 3 deletes / 4 = 0.75 > 0.5 => rejected.
    h.setFeed(res(feed([{ rkey: 'a', n: 1 }])));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('delete-bound-exceeded');
    // Repo unchanged: still has 4 records.
    expect((await h.managers.get(DID)!.currentState()).size).toBe(4);
  });

  it('an explicitly empty feed still deletes everything (the guard only fires for non-empty snapshots)', async () => {
    const h = await harness({ maxDeleteRatio: 0.5 });
    h.setFeed(res(feed([{ rkey: 'a', n: 1 }, { rkey: 'b', n: 2 }])));
    await h.pipeline.ingest(TOPIC);
    h.setFeed(res(feed([])));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('committed');
    expect((await h.managers.get(DID)!.currentState()).size).toBe(0);
  });
});

describe('abuse: record cap', () => {
  it('rejects a feed with more records than maxRecordsPerRepo', async () => {
    const h = await harness({ maxRecords: 2 });
    h.setFeed(res(feed([{ rkey: 'a', n: 1 }, { rkey: 'b', n: 2 }, { rkey: 'c', n: 3 }])));
    const out = await h.pipeline.ingest(TOPIC);
    expect(out.status).toBe('rejected');
    if (out.status === 'rejected') expect(out.code).toBe('too-many-records');
  });
});

describe('abuse: deactivation', () => {
  it('marks the repo inactive and emits #account{active:false}', async () => {
    const h = await harness();
    await h.pipeline.ingest(TOPIC);
    h.meta.deactivate(DID);
    const seqNo = h.firehose.emitDeactivation(DID, '2026-07-21T12:00:00Z');
    expect(h.meta.isActive(DID)).toBe(false);
    const evt = h.seq.readSince(seqNo - 1, 1)[0]!;
    const [header, body] = [...cborDecodeAll(evt.payload)] as any[];
    expect(header.t).toBe('#account');
    expect(body.active).toBe(false);
  });
});
