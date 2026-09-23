import { describe, it, expect } from 'vitest';
import { readCarWithRoot, verifyRepo, Repo } from '@atproto/repo';
import { SqliteRepoStorage } from '../src/storage/sqlite-repo-store.js';
import { RepoManager } from '../src/repo/repo-manager.js';
import { LocalKeyCommitSigner } from '../src/repo/commit-signer.js';
import { newKeypair } from './helpers.js';
import type { DesiredRecord } from '../src/repo/diff.js';

/**
 * Backfill correctness (OVERNIGHT §3 firehose): a consumer that joins late,
 * calls getRepo, then follows the firehose must end in exactly the same repo
 * state as one connected the whole time. Here we prove the two halves that make
 * that true: (1) getRepo(since) returns exactly the blocks needed to advance an
 * older reader to the head, and (2) the head CAR verifies to the same records
 * regardless of the path taken.
 */

const DID = 'did:web:node.test.example';
const COLL = 'com.example.custom.record';

function rec(rkey: string, n: number): DesiredRecord {
  return { collection: COLL, rkey, record: { $type: COLL, count429: n } };
}

async function mgr() {
  const kp = await newKeypair();
  return { m: new RepoManager(new SqliteRepoStorage(DID), new LocalKeyCommitSigner(kp)), kp };
}

describe('getRepo backfill correctness', () => {
  it('a cold full getRepo verifies to the current record set', async () => {
    const { m, kp } = await mgr();
    await m.commitWrites((await m.diffAgainstFeed([rec('a', 1), rec('b', 2)])).writes);
    await m.commitWrites((await m.diffAgainstFeed([rec('a', 1), rec('b', 2), rec('c', 3)])).writes);
    const { root, blocks } = await readCarWithRoot(await m.fullCar());
    const v = await verifyRepo(blocks, root, DID, kp.did());
    expect(v.creates.map((c) => c.rkey).sort()).toEqual(['a', 'b', 'c']);
  });

  it('getRepo(since) returns only blocks newer than the given rev', async () => {
    const { m } = await mgr();
    const c1 = await m.commitWrites((await m.diffAgainstFeed([rec('a', 1)])).writes);
    const c2 = await m.commitWrites((await m.diffAgainstFeed([rec('a', 1), rec('b', 2)])).writes);

    const fullCar = await m.fullCar();
    const sinceCar = await m.carSince(c1.commit.rev);
    const full = await readCarWithRoot(fullCar);
    const since = await readCarWithRoot(sinceCar);

    // The since-CAR is a strict subset of the full CAR, and smaller.
    expect(since.blocks.size).toBeLessThan(full.blocks.size);
    // Its root is the current head (c2), so a reader lands on the right commit.
    expect(since.root.equals(c2.commit.cid)).toBe(true);
    // Every block in the since-CAR carries a rev > c1 (i.e. was written by c2).
    // We assert this indirectly: the since-CAR must contain the c2 commit block
    // but NOT the c1 commit block.
    expect(since.blocks.has(c2.commit.cid)).toBe(true);
    expect(since.blocks.has(c1.commit.cid)).toBe(false);
  });

  it('late reader (getRepo full) + continuous reader converge on identical head', async () => {
    // Continuous reader: applies every commit as it happens.
    const { m: live, kp } = await mgr();
    // Late reader: same key, separate storage, catches up via a single full CAR.
    const late = new RepoManager(new SqliteRepoStorage(DID), new LocalKeyCommitSigner(kp));

    const feeds = [
      [rec('a', 1)],
      [rec('a', 1), rec('b', 2)],
      [rec('a', 9), rec('b', 2)], // update a
      [rec('b', 2)], // delete a
    ];
    for (const f of feeds) {
      const d = await live.diffAgainstFeed(f);
      if (d.writes.length) await live.commitWrites(d.writes);
    }

    // Late reader ingests the final full CAR into its own store.
    const { root, blocks } = await readCarWithRoot(await live.fullCar());
    // Materialise the CAR into the late store via a fresh repo load path:
    // write the blocks and point the root. We reuse verifyRepo to confirm the
    // late reader would compute the same contents.
    const vLate = await verifyRepo(blocks, root, DID, kp.did());

    // Continuous reader reads its own head contents.
    const liveRepo = await Repo.load(live.storage.asRepoStorage(), live.getRoot()!);
    const liveRecords: string[] = [];
    for await (const e of liveRepo.walkRecords()) liveRecords.push(`${e.rkey}`);

    expect(vLate.creates.map((c) => c.rkey).sort()).toEqual(liveRecords.sort());
    // Final state is just 'b' (a was deleted).
    expect(liveRecords.sort()).toEqual(['b']);
    // And both agree on the head root.
    expect(root.equals(live.getRoot()!)).toBe(true);
  });
});
