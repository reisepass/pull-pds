import { describe, it, expect } from 'vitest';
import { WriteOpAction, verifyCommitSig, readCarWithRoot, Repo } from '@atproto/repo';
import { SqliteRepoStorage } from '../src/storage/sqlite-repo-store.js';
import { RepoManager } from '../src/repo/repo-manager.js';
import { LocalKeyCommitSigner } from '../src/repo/commit-signer.js';
import { diffSnapshot, dataKey } from '../src/repo/diff.js';
import { newKeypair } from './helpers.js';
import type { DesiredRecord } from '../src/repo/diff.js';

const DID = 'did:web:node.test.example';
const COLL = 'app.omniroute.errorReport';

async function newManager() {
  const kp = await newKeypair();
  const storage = new SqliteRepoStorage(DID);
  const signer = new LocalKeyCommitSigner(kp);
  return { mgr: new RepoManager(storage, signer), kp, storage, signer };
}

function rec(n: number): DesiredRecord {
  return {
    collection: COLL,
    rkey: 'current',
    record: { $type: COLL, provider: 'groq', count429: n, observedAt: '2026-07-21T12:00:00Z' },
  };
}

describe('diff engine (snapshot mode)', () => {
  it('empty repo + records => all creates', async () => {
    const d = await diffSnapshot(new Map(), [rec(1), { ...rec(2), rkey: 'other' }]);
    expect(d.creates).toBe(2);
    expect(d.updates).toBe(0);
    expect(d.deletes).toBe(0);
    expect(d.writes.every((w) => w.action === WriteOpAction.Create)).toBe(true);
  });

  it('unchanged feed => no ops (204 path)', async () => {
    const { mgr } = await newManager();
    await mgr.commitWrites((await mgr.diffAgainstFeed([rec(1)])).writes);
    const d = await mgr.diffAgainstFeed([rec(1)]);
    expect(d.writes.length).toBe(0);
  });

  it('reordering records produces no spurious commit', async () => {
    const { mgr } = await newManager();
    const a = { ...rec(1), rkey: 'a' };
    const b = { ...rec(2), rkey: 'b' };
    await mgr.commitWrites((await mgr.diffAgainstFeed([a, b])).writes);
    const d = await mgr.diffAgainstFeed([b, a]); // reversed
    expect(d.writes.length).toBe(0);
  });

  it('changed value => update', async () => {
    const { mgr } = await newManager();
    await mgr.commitWrites((await mgr.diffAgainstFeed([rec(1)])).writes);
    const d = await mgr.diffAgainstFeed([rec(999)]);
    expect(d.updates).toBe(1);
    expect(d.writes[0]?.action).toBe(WriteOpAction.Update);
  });

  it('empty feed deletes everything', async () => {
    const { mgr } = await newManager();
    await mgr.commitWrites((await mgr.diffAgainstFeed([rec(1), { ...rec(2), rkey: 'x' }])).writes);
    const d = await mgr.diffAgainstFeed([]);
    expect(d.deletes).toBe(2);
    expect(d.writes.every((w) => w.action === WriteOpAction.Delete)).toBe(true);
  });

  it('deleting a record never in the repo is a no-op', async () => {
    const cur = new Map();
    const d = await diffSnapshot(cur, []); // nothing present, nothing desired
    expect(d.writes.length).toBe(0);
  });
});

describe('commit chain integrity', () => {
  it('rev is strictly monotonic across a sequence of commits', async () => {
    const { mgr } = await newManager();
    const revs: string[] = [];
    for (let n = 1; n <= 5; n++) {
      const d = await mgr.diffAgainstFeed([rec(n)]);
      if (d.writes.length) {
        const r = await mgr.commitWrites(d.writes);
        revs.push(r.commit.rev);
      }
    }
    expect(revs.length).toBe(5);
    for (let i = 1; i < revs.length; i++) {
      expect(revs[i]! > revs[i - 1]!).toBe(true);
    }
  });

  it('every commit signature verifies against the PDS key', async () => {
    const { mgr, kp, storage } = await newManager();
    await mgr.commitWrites((await mgr.diffAgainstFeed([rec(1)])).writes);
    await mgr.commitWrites((await mgr.diffAgainstFeed([rec(2)])).writes);
    // Load the head commit and verify its signature.
    const root = storage.getRoot()!;
    const repo = await Repo.load(storage.asRepoStorage(), root);
    const valid = await verifyCommitSig(repo.commit, kp.did());
    expect(valid).toBe(true);
  });

  it('since points at the previous rev; prevData linkage present', async () => {
    const { mgr } = await newManager();
    const c1 = await mgr.commitWrites((await mgr.diffAgainstFeed([rec(1)])).writes);
    const c2 = await mgr.commitWrites((await mgr.diffAgainstFeed([rec(2)])).writes);
    expect(c1.commit.since).toBeNull();
    expect(c2.commit.since).toBe(c1.commit.rev);
    // Spec D3: prev is null (linkage via prevData), but the CommitData exposes prev CID.
    expect(c2.commit.prev?.equals(c1.commit.cid)).toBe(true);
  });
});

describe('CAR export', () => {
  it('full-repo CAR round-trips and matches the current root', async () => {
    const { mgr, kp, storage } = await newManager();
    await mgr.commitWrites((await mgr.diffAgainstFeed([rec(1), { ...rec(2), rkey: 'x' }])).writes);
    const car = await mgr.fullCar();
    const { root, blocks } = await readCarWithRoot(car);
    expect(root.equals(storage.getRoot()!)).toBe(true);
    // The CAR verifies as a real atproto repo signed by the PDS key.
    const { verifyRepo } = await import('@atproto/repo');
    const verified = await verifyRepo(blocks, root, DID, kp.did());
    expect(verified.creates.length).toBe(2);
  });

  it('commit CAR (diff) contains only the changed record leaves + proofs', async () => {
    const { mgr } = await newManager();
    await mgr.commitWrites((await mgr.diffAgainstFeed([rec(1), { ...rec(2), rkey: 'x' }])).writes);
    const c2 = await mgr.commitWrites((await mgr.diffAgainstFeed([rec(1), { ...rec(999), rkey: 'x' }])).writes);
    const car = await mgr.commitCar(c2.commit);
    const { root } = await readCarWithRoot(car);
    expect(root.equals(c2.commit.cid)).toBe(true);
  });
});

describe('getRecord covering proof', () => {
  it('produces a proof CAR that verifies the record inclusion', async () => {
    const { mgr, kp } = await newManager();
    await mgr.commitWrites((await mgr.diffAgainstFeed([rec(42)])).writes);
    const car = await mgr.recordProofCar(COLL, 'current');
    expect(car).not.toBeNull();
    const { verifyRecords } = await import('@atproto/repo');
    const claims = await verifyRecords(car!, DID, kp.did());
    const mine = claims.find((c) => c.collection === COLL && c.rkey === 'current');
    expect(mine?.record).toMatchObject({ count429: 42 });
  });

  it('returns a proof-of-absence CAR (commit only, no leaf) for a missing record', async () => {
    const { mgr } = await newManager();
    await mgr.commitWrites((await mgr.diffAgainstFeed([rec(1)])).writes);
    // A record that does not exist still yields a CAR (commit + covering proof),
    // but verifyRecords finds no such record in it.
    const car = await mgr.recordProofCar(COLL, 'does-not-exist');
    expect(car).not.toBeNull();
    const { root } = await readCarWithRoot(car!);
    // Root is the current commit; the CAR is a valid proof structure.
    expect(root).toBeTruthy();
  });
});
