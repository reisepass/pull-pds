import { describe, it, expect } from 'vitest';
import { cborDecodeAll, cborDecode, cborEncode } from '@atproto/lex-cbor';
import type { LexValue } from '@atproto/lex-cbor';
import { readCarWithRoot, verifyRepo } from '@atproto/repo';
import { SqliteRepoStorage } from '../src/storage/sqlite-repo-store.js';
import { SqliteSequencerStore } from '../src/storage/sqlite-sequencer-store.js';
import { RepoManager } from '../src/repo/repo-manager.js';
import { LocalKeyCommitSigner } from '../src/repo/commit-signer.js';
import { Sequencer } from '../src/firehose/sequencer.js';
import { FirehoseService } from '../src/firehose/service.js';
import { newKeypair } from './helpers.js';

const DID = 'did:web:node.test.example';
const COLL = 'com.example.custom.record';
const NOW = '2026-07-21T12:00:00Z';

function feed(n: number, rkey = 'current') {
  return [{ collection: COLL, rkey, record: { $type: COLL, count429: n } }];
}

async function harness() {
  const kp = await newKeypair();
  const storage = new SqliteRepoStorage(DID);
  const mgr = new RepoManager(storage, new LocalKeyCommitSigner(kp));
  const seqStore = new SqliteSequencerStore();
  const seq = new Sequencer(seqStore);
  const fh = new FirehoseService(seq);
  return { kp, storage, mgr, seq, fh };
}

/** Decode a firehose payload (header ++ body) into {t, body}. */
function decodeFrame(payload: Uint8Array): { t?: string; op: number; body: unknown } {
  const parts = [...cborDecodeAll(payload)] as any[];
  const header = parts[0];
  const body = parts[1];
  return { t: header.t, op: header.op, body };
}

describe('FirehoseService', () => {
  it('first ingest emits #identity, #account, #sync, #commit in order', async () => {
    const { mgr, seq, fh } = await harness();
    const d = await mgr.diffAgainstFeed(feed(1));
    const result = await mgr.commitWrites(d.writes);
    await fh.emitCommit(mgr, result, { firstIngest: true, nowIso: NOW, handle: 'node.test.example' });

    const events = seq.readSince(0, 100);
    expect(events.map((e) => e.type)).toEqual(['#identity', '#account', '#sync', '#commit']);
    // seqs are monotonic 1..4
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it('#commit frame body carries seq, ops, since and a valid diff CAR', async () => {
    const { mgr, seq, fh } = await harness();
    const r1 = await mgr.commitWrites((await mgr.diffAgainstFeed(feed(1))).writes);
    await fh.emitCommit(mgr, r1, { firstIngest: true, nowIso: NOW });
    const r2 = await mgr.commitWrites((await mgr.diffAgainstFeed(feed(2))).writes);
    const { commitSeq } = await fh.emitCommit(mgr, r2, { firstIngest: false, nowIso: NOW });

    const events = seq.readSince(0, 100);
    const commitEvt = events.find((e) => e.seq === commitSeq)!;
    const { t, body } = decodeFrame(commitEvt.payload) as any;
    expect(t).toBe('#commit');
    expect(body.seq).toBe(commitSeq);
    expect(body.repo).toBe(DID);
    expect(body.since).toBe(r1.commit.rev);
    expect(body.ops.length).toBe(1);
    expect(body.ops[0].action).toBe('update');
    expect(body.ops[0].path).toBe(`${COLL}/current`);
    // blocks is a CAR whose root is the new commit.
    const { root } = await readCarWithRoot(body.blocks);
    expect(root.equals(r2.commit.cid)).toBe(true);
  });

  it('#sync CAR reconstructs the full repo, verifiable against the pds key', async () => {
    const { kp, mgr, seq, fh } = await harness();
    const r = await mgr.commitWrites((await mgr.diffAgainstFeed(feed(7))).writes);
    await fh.emitCommit(mgr, r, { firstIngest: true, nowIso: NOW });
    const syncEvt = seq.readSince(0, 100).find((e) => e.type === '#sync')!;
    const { body } = decodeFrame(syncEvt.payload) as any;
    const { root, blocks } = await readCarWithRoot(body.blocks);
    const verified = await verifyRepo(blocks, root, DID, kp.did());
    expect(verified.creates.length).toBe(1);
    expect(verified.creates[0]?.collection).toBe(COLL);
    expect(verified.creates[0]?.rkey).toBe('current');
  });

  it('INTEROP: #commit frame matches the atproto wire format a relay expects', async () => {
    const { mgr, seq, fh } = await harness();
    const r = await mgr.commitWrites((await mgr.diffAgainstFeed(feed(1))).writes);
    await fh.emitCommit(mgr, r, { firstIngest: true, nowIso: NOW });
    const evt = seq.readSince(0, 100).find((e) => e.type === '#commit')!;

    // Header is exactly { op:1, t:"#commit" }.
    const parts = [...cborDecodeAll(evt.payload)] as any[];
    expect(parts[0]).toEqual({ op: 1, t: '#commit' });

    // Body carries every Sync-1.1 field a consumer reads.
    const body = parts[1];
    for (const k of ['seq', 'repo', 'commit', 'rev', 'since', 'blocks', 'ops', 'prevData', 'time', 'blobs', 'rebase', 'tooBig']) {
      expect(body, `missing field ${k}`).toHaveProperty(k);
    }

    // The blocks CAR root equals body.commit, and the commit block validates
    // against @atproto/repo's own commit schema (def.commit) - i.e. a real
    // consumer library parses our frame unchanged.
    const { MemoryBlockstore, def } = await import('@atproto/repo');
    const { root, blocks } = await readCarWithRoot(body.blocks);
    expect(root.equals(body.commit)).toBe(true);
    const store = new MemoryBlockstore(blocks);
    const commit = await store.readObj(body.commit, def.commit);
    expect(commit.version).toBe(3);
    expect(commit.did).toBe(DID);
  });

  it('deactivation emits #account{active:false}', async () => {
    const { seq, fh } = await harness();
    fh.emitDeactivation(DID, NOW);
    const evt = seq.readSince(0, 100)[0]!;
    const { t, body } = decodeFrame(evt.payload) as any;
    expect(t).toBe('#account');
    expect(body.active).toBe(false);
    expect(body.status).toBe('deactivated');
  });
});

describe('Filtered subscription', () => {
  const OTHER_COLL = 'app.example.other';

  /** Append a #commit-shaped frame whose ops path is `<collection>/x` via the Sequencer (so live listeners fire). */
  function rawCommitFrame(seq: Sequencer, did: string, collection: string): number {
    const header = cborEncode({ op: 1, t: '#commit' } as LexValue);
    const body = cborEncode({ seq: 0, repo: did, ops: [{ action: 'create', path: `${collection}/x`, cid: null }], time: NOW } as LexValue);
    const payload = new Uint8Array(header.length + body.length);
    payload.set(header, 0);
    payload.set(body, header.length);
    return seq.append({ did, type: '#commit', payload });
  }

  it('readSinceFiltered returns only frames mentioning the collection', async () => {
    const seqStore = new SqliteSequencerStore();
    const seq = new Sequencer(seqStore);
    rawCommitFrame(seq, DID, COLL);
    rawCommitFrame(seq, DID, OTHER_COLL);
    rawCommitFrame(seq, DID, COLL);
    const filtered = seqStore.readSinceFiltered!(0, 100, [COLL]);
    expect(filtered).toHaveLength(2);
    for (const e of filtered) {
      const { body } = decodeFrame(e.payload) as any;
      expect(body.ops[0].path.startsWith(`${COLL}/`)).toBe(true);
    }
  });

  it('a filtered stream yields only in-collection frames, live and backfilled', async () => {
    const seqStore = new SqliteSequencerStore();
    const seq = new Sequencer(seqStore);
    // Backfill: one in-collection, one out-of-collection.
    rawCommitFrame(seq, DID, OTHER_COLL);
    rawCommitFrame(seq, DID, COLL);

    const ac = new AbortController();
    const got: string[] = [];
    const consume = (async () => {
      for await (const e of seq.stream(0, ac.signal, 500, { wantedCollections: [COLL] })) {
        const { body } = decodeFrame(e.payload) as any;
        got.push(body.ops[0].path as string);
        if (got.length >= 2) ac.abort();
      }
    })();
    // Live append after the stream starts.
    await new Promise((r) => setTimeout(r, 20));
    rawCommitFrame(seq, DID, OTHER_COLL); // must be filtered out
    rawCommitFrame(seq, DID, COLL);       // must arrive
    await consume;
    expect(got).toEqual([`${COLL}/x`, `${COLL}/x`]);
  });
});
