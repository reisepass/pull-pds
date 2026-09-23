import { describe, it, expect } from 'vitest';
import { cborDecodeAll } from '@atproto/lex-cbor';
import { SqliteRepoStorage } from '../src/storage/sqlite-repo-store.js';
import { SqliteSequencerStore } from '../src/storage/sqlite-sequencer-store.js';
import { RepoManager } from '../src/repo/repo-manager.js';
import { Sequencer } from '../src/firehose/sequencer.js';
import { FirehoseService } from '../src/firehose/service.js';
import { LocalKeyCommitSigner } from '../src/repo/commit-signer.js';
import { newKeypair } from './helpers.js';

/**
 * The FirehoseService assigns a frame's `seq` by peeking `currentSeq()+1`, then
 * appending. That peek-then-append is only safe if nothing runs between the peek
 * and the append. It is synchronous end-to-end (no await inside append()), but
 * emitCommit awaits between its several appends (identity/account/sync/commit).
 * This test hammers many DIDs' emitCommit concurrently and asserts: no skew
 * error thrown, every seq unique and gap-free, and every frame body's embedded
 * seq equals the store-assigned seq.
 */

const COLL = 'app.omniroute.errorReport';

describe('firehose seq assignment under concurrency', () => {
  it('40 DIDs emitting concurrently produce a gap-free, unique, self-consistent seq stream', async () => {
    const seqStore = new SqliteSequencerStore();
    const seq = new Sequencer(seqStore);
    const fh = new FirehoseService(seq);

    // Build 40 independent repos, each with one commit ready to emit.
    const jobs = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => {
        const kp = await newKeypair();
        const did = `did:web:node${i}.test.example`;
        const mgr = new RepoManager(new SqliteRepoStorage(did), new LocalKeyCommitSigner(kp));
        const d = await mgr.diffAgainstFeed([{ collection: COLL, rkey: 'current', record: { $type: COLL, n: i } }]);
        const result = await mgr.commitWrites(d.writes);
        return { mgr, result };
      }),
    );

    // Fire every emitCommit concurrently (first ingest -> 4 frames each = 160).
    await Promise.all(
      jobs.map((j) => fh.emitCommit(j.mgr, j.result, { firstIngest: true, nowIso: '2026-07-21T12:00:00Z' })),
    );

    const events = seq.readSince(0, 10_000);
    expect(events.length).toBe(160); // 40 DIDs x {identity, account, sync, commit}

    // seqs are exactly 1..160, no gaps, no dups.
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual(Array.from({ length: 160 }, (_, i) => i + 1));

    // Every frame body's embedded seq matches its store seq (no skew slipped
    // through). #commit and #sync/#identity/#account all carry `seq`.
    for (const e of events) {
      const [, body] = [...cborDecodeAll(e.payload)] as any[];
      expect(body.seq).toBe(e.seq);
    }
  }, 30_000);
});
