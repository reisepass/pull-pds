import { describe, it, expect } from 'vitest';
import { readCarWithRoot, verifyRepo } from '@atproto/repo';
import { SqliteRepoStorage } from '../src/storage/sqlite-repo-store.js';
import { RepoManager } from '../src/repo/repo-manager.js';
import { LocalKeyCommitSigner } from '../src/repo/commit-signer.js';
import { newKeypair } from './helpers.js';
import type { DesiredRecord } from '../src/repo/diff.js';

const COLL = 'app.omniroute.errorReport';
const DID = 'did:web:scale.test.example';

function big(count: number, bump = 0): DesiredRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    collection: COLL,
    rkey: `k${String(i).padStart(4, '0')}`,
    record: { $type: COLL, n: i + bump },
  }));
}

async function mgr() {
  const kp = await newKeypair();
  return { m: new RepoManager(new SqliteRepoStorage(DID), new LocalKeyCommitSigner(kp)), kp };
}

describe('MST at scale', () => {
  it('500-record commit, mass churn, and full verify hold', async () => {
    const { m, kp } = await mgr();

    // Initial 500-record commit.
    await m.commitWrites((await m.diffAgainstFeed(big(500))).writes);
    let { root, blocks } = await readCarWithRoot(await m.fullCar());
    let v = await verifyRepo(blocks, root, DID, kp.did());
    expect(v.creates.length).toBe(500);

    // Delete half + update the survivors, all in one commit.
    const half = big(500).filter((_, i) => i % 2 === 0).map((r) => ({
      ...r,
      record: { ...r.record, n: (r.record as { n: number }).n + 1000 },
    }));
    const diff = await m.diffAgainstFeed(half);
    expect(diff.deletes).toBe(250);
    expect(diff.updates).toBe(250);
    await m.commitWrites(diff.writes);

    expect((await m.currentState()).size).toBe(250);
    ({ root, blocks } = await readCarWithRoot(await m.fullCar()));
    v = await verifyRepo(blocks, root, DID, kp.did());
    expect(v.creates.length).toBe(250);
  }, 30_000);

  it('swapping two records values (content aliasing) diffs to two updates, not zero', async () => {
    const { m } = await mgr();
    await m.commitWrites(
      (await m.diffAgainstFeed([
        { collection: COLL, rkey: 'a', record: { $type: COLL, n: 1 } },
        { collection: COLL, rkey: 'b', record: { $type: COLL, n: 2 } },
      ])).writes,
    );
    // Swap the values between a and b. Same multiset of CIDs, but each KEY's
    // content changed, so the diff must be two updates (not a no-op).
    const diff = await m.diffAgainstFeed([
      { collection: COLL, rkey: 'a', record: { $type: COLL, n: 2 } },
      { collection: COLL, rkey: 'b', record: { $type: COLL, n: 1 } },
    ]);
    expect(diff.updates).toBe(2);
    expect(diff.deletes).toBe(0);
    expect(diff.creates).toBe(0);
  });
});
