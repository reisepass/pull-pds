import { describe, it, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { Repo, WriteOpAction, cidForRecord } from '@atproto/repo';
import { SqliteRepoStorage } from '../src/storage/sqlite-repo-store.js';
import { SqliteSequencerStore } from '../src/storage/sqlite-sequencer-store.js';
import { newKeypair } from './helpers.js';

/** Remove a sqlite file plus its WAL/SHM sidecars, ignoring absence. */
function rmSqlite(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(path + suffix);
    } catch {
      /* not present */
    }
  }
}

const did = 'did:web:example.com';

describe('SqliteRepoStorage as an @atproto/repo RepoStorage', () => {
  it('backs Repo.create and Repo.load end to end (real MST + commit)', async () => {
    const kp = await newKeypair();
    const storage = new SqliteRepoStorage(did);

    // Build a real repo with one record through @atproto/repo, writing straight
    // into SQLite. This exercises putMany/updateRoot/getBytes/has under load.
    const record = {
      $type: 'com.example.custom.record',
      windowStart: '2026-07-21T00:00:00Z',
      windowEnd: '2026-07-21T00:05:00Z',
      nodeVersion: '1.2.3',
      entries: [],
    };
    let repo = await Repo.create(storage, did, kp);
    repo = await repo.applyWrites(
      [
        {
          action: WriteOpAction.Create,
          collection: 'com.example.custom.record',
          rkey: '3lqrecord0001',
          record,
        },
      ],
      kp,
    );

    // Root and rev are persisted.
    const root = storage.getRoot();
    expect(root).not.toBeNull();
    expect(storage.getRev()).not.toBeNull();
    expect(root?.equals(repo.cid)).toBe(true);

    // Reload from storage alone and read the record back.
    const reloaded = await Repo.load(storage, root ?? undefined);
    const got = await reloaded.getRecord('com.example.custom.record', '3lqrecord0001');
    expect(got).toMatchObject({ nodeVersion: '1.2.3' });

    // The record block is content-addressed and present.
    const recCid = await cidForRecord(record);
    expect(storage.hasBlock(recCid)).toBe(true);
    expect(storage.sizeInBytes()).toBeGreaterThan(0);

    storage.close();
  });

  it('persists across a reopen of the same file (durability)', async () => {
    const kp = await newKeypair();
    const path = `/tmp/selfsign-test-repo-${Buffer.from(kp.did()).toString('hex').slice(0, 12)}.sqlite`;
    rmSqlite(path);
    const s1 = new SqliteRepoStorage(did, path);
    const repo = await Repo.create(s1, did, kp);
    const rootRev = s1.getRev();
    s1.close();

    const s2 = new SqliteRepoStorage(did, path);
    expect(s2.getRoot()?.equals(repo.cid)).toBe(true);
    expect(s2.getRev()).toBe(rootRev);
    s2.close();
  });

  it('records a commit in the commit log via putCommit', async () => {
    const kp = await newKeypair();
    const storage = new SqliteRepoStorage(did);
    const record = { $type: 'com.example.custom.record', nodeVersion: 'x', entries: [] };
    const cid = await cidForRecord(record);
    const bytes = new TextEncoder().encode('fake-commit-block');
    // Use the raw putCommit path with the record CID standing in as the commit.
    storage.putCommit({
      root: cid,
      rev: '3lqcommit0001',
      since: null,
      commitCid: cid,
      signingDidKey: kp.did(),
      blocks: [{ cid, bytes, rev: '3lqcommit0001' }],
    });
    const latest = storage.getLatestCommit();
    expect(latest?.rev).toBe('3lqcommit0001');
    expect(latest?.signingDidKey).toBe(kp.did());
    expect(storage.listCommits().length).toBe(1);
    expect(storage.listCommits({ sinceRev: '3lqcommit0001' }).length).toBe(0);
    storage.close();
  });
});

describe('SqliteSequencerStore', () => {
  it('assigns strictly monotonic seqs', () => {
    const seq = new SqliteSequencerStore();
    const a = seq.append({ did, type: '#commit', payload: new Uint8Array([1]) });
    const b = seq.append({ did, type: '#commit', payload: new Uint8Array([2]) });
    const c = seq.append({ did, type: '#identity', payload: new Uint8Array([3]) });
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(c).toBe(3);
    expect(seq.currentSeq()).toBe(3);
    seq.close();
  });

  it('reads events strictly after a cursor, in order, capped by limit', () => {
    const seq = new SqliteSequencerStore();
    for (let i = 0; i < 5; i++) {
      seq.append({ did, type: '#commit', payload: new Uint8Array([i]) });
    }
    const page = seq.readSince(2, 2);
    expect(page.map((e) => e.seq)).toEqual([3, 4]);
    expect(page[0]?.payload[0]).toBe(2); // payload for seq 3 was byte 2 (0-indexed loop)
    const rest = seq.readSince(4, 100);
    expect(rest.map((e) => e.seq)).toEqual([5]);
    seq.close();
  });

  it('stays monotonic and resumable across a reopen', () => {
    const path = `/tmp/selfsign-test-seq-reopen.sqlite`;
    rmSqlite(path);
    const s1 = new SqliteSequencerStore(path);
    s1.append({ did, type: '#commit', payload: new Uint8Array([1]) });
    s1.append({ did, type: '#commit', payload: new Uint8Array([2]) });
    expect(s1.currentSeq()).toBe(2);
    s1.close();

    const s2 = new SqliteSequencerStore(path);
    expect(s2.currentSeq()).toBe(2);
    // New appends continue past the persisted max; seq is never reused.
    const next = s2.append({ did, type: '#commit', payload: new Uint8Array([3]) });
    expect(next).toBe(3);
    s2.close();
  });
});
