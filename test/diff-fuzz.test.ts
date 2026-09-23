import { describe, it, expect } from 'vitest';
import { SqliteRepoStorage } from '../src/storage/sqlite-repo-store.js';
import { RepoManager } from '../src/repo/repo-manager.js';
import { LocalKeyCommitSigner } from '../src/repo/commit-signer.js';
import { newKeypair } from './helpers.js';
import type { DesiredRecord } from '../src/repo/diff.js';

/**
 * Property/fuzz test for the diff engine + MST (OVERNIGHT §3 "fuzz the diff
 * engine and the MST"). Invariants under a random walk of feed snapshots:
 *
 *   I1. After each ingest, the repo's record set EQUALS the last feed exactly
 *       (same keys, same values).
 *   I2. rev is strictly monotonic across every commit.
 *   I3. An unchanged feed produces no commit (no rev bump).
 *   I4. Re-submitting the same feed with records reordered produces no commit.
 *
 * The randomness is derived from a fixed seed per case (no Math.random, which is
 * unavailable) so failures are reproducible from the case index.
 */

const COLL = 'com.example.custom.record';
const DID = 'did:web:fuzz.test.example';

// A tiny deterministic PRNG (mulberry32) seeded per case.
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomFeed(rand: () => number): DesiredRecord[] {
  const keySpace = ['a', 'b', 'c', 'd', 'e'];
  const feed: DesiredRecord[] = [];
  for (const k of keySpace) {
    if (rand() < 0.5) {
      feed.push({ collection: COLL, rkey: k, record: { $type: COLL, count429: Math.floor(rand() * 100) } });
    }
  }
  return feed;
}

function feedKeyVals(feed: DesiredRecord[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of feed) m.set(r.rkey, (r.record as { count429: number }).count429);
  return m;
}

async function stateKeyVals(mgr: RepoManager): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const r of await mgr.currentRecords()) {
    m.set(r.rkey, (r.record as { count429: number }).count429);
  }
  return m;
}

describe('diff engine fuzz', () => {
  it('repo always matches the last feed across a random walk (30 cases x 20 steps)', async () => {
    for (let seed = 1; seed <= 30; seed++) {
      const kp = await newKeypair();
      const mgr = new RepoManager(new SqliteRepoStorage(DID), new LocalKeyCommitSigner(kp));
      const rand = prng(seed);
      let lastRev: string | null = null;

      for (let step = 0; step < 20; step++) {
        const feed = randomFeed(rand);
        const diff = await mgr.diffAgainstFeed(feed);
        if (diff.writes.length > 0) {
          const r = await mgr.commitWrites(diff.writes);
          // I2: rev strictly increases.
          if (lastRev !== null) {
            expect(r.commit.rev > lastRev, `seed ${seed} step ${step}: rev not increasing`).toBe(true);
          }
          lastRev = r.commit.rev;
        }

        // I1: repo state equals the feed.
        const want = feedKeyVals(feed);
        const got = await stateKeyVals(mgr);
        expect(got, `seed ${seed} step ${step}: state != feed`).toEqual(want);

        // I3 + I4: re-submitting the same feed (reordered) is a no-op.
        const reordered = [...feed].reverse();
        const noop = await mgr.diffAgainstFeed(reordered);
        expect(noop.writes.length, `seed ${seed} step ${step}: reorder produced a commit`).toBe(0);
      }
    }
  }, 30_000);
});
