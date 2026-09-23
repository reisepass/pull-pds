import { describe, it, expect } from 'vitest';
import { SqliteSequencerStore } from '../src/storage/sqlite-sequencer-store.js';
import { IndexStore } from '../src/appview/index-store.js';
import { GlobalStore } from '../src/globalindex/store.js';
import { pruneStore, DEFAULT_RETENTION } from '../src/retention.js';

/**
 * REDESIGN-TASK §2: retention pruning — 6 months OR 0.5 GB, whichever first.
 * Cheap, batched, age-then-size. These tests drive the store methods directly
 * with a synthetic clock via explicit ISO cutoffs (no timers, no sleeping).
 */

describe('retention pruning', () => {
  it('sequencer: age-prunes only events older than the cutoff', () => {
    const seq = new SqliteSequencerStore(':memory:');
    // Backdate one row by writing then forcing created_at into the past.
    seq.append({ did: 'did:web:old', type: '#commit', payload: new Uint8Array([1]) });
    seq.append({ did: 'did:web:new', type: '#commit', payload: new Uint8Array([2]) });
    const db = (seq as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db;
    db.prepare(`UPDATE event SET created_at = ? WHERE did = ?`).run('2020-01-01T00:00:00.000Z', 'did:web:old');

    const cutoff = new Date(Date.now() - DEFAULT_RETENTION.maxAgeMs).toISOString();
    const removed = seq.pruneOlderThan(cutoff, 5_000);
    expect(removed).toBe(1);
    const rest = seq.readSince(0, 100);
    expect(rest).toHaveLength(1);
    expect(rest[0].did).toBe('did:web:new');
    seq.close();
  });

  it('sequencer: size-prunes oldest until under budget', () => {
    const seq = new SqliteSequencerStore(':memory:');
    const chunk = new Uint8Array(1024); // 1 KB payload
    for (let i = 0; i < 20; i++) seq.append({ did: 'did:web:x', type: '#commit', payload: chunk });
    const before = seq.sizeInBytes();
    expect(before).toBeGreaterThan(10 * 1024);
    const removed = seq.pruneToBytes(5 * 1024, 4); // tiny batches: 4 rows/pass
    expect(removed).toBeGreaterThan(0);
    expect(seq.sizeInBytes()).toBeLessThanOrEqual(5 * 1024);
    // Newest rows survive (oldest-first pruning).
    const rest = seq.readSince(0, 100);
    expect(rest.length).toBeLessThan(20);
    expect(rest.length).toBeGreaterThan(0);
    seq.close();
  });

  it('appview index: age-prunes old rejections and stale records', () => {
    const store = new IndexStore(':memory:');
    store.putRecord({
      did: 'did:web:a', collection: 'app.omniroute.errorReport', rkey: '1',
      cid: 'bafy1', recordJson: '{}', rev: 'r1', sourcePds: 'p2', sigVerified: true,
      indexedAt: '2020-01-01T00:00:00.000Z',
    });
    store.recordRejection({ at: '2020-01-01T00:00:00.000Z', did: 'did:web:a', sourcePds: 'p2', rev: 'r0', reason: 'bad-sig' });
    store.recordRejection({ at: new Date().toISOString(), did: 'did:web:b', sourcePds: 'p2', rev: 'r9', reason: 'bad-sig' });

    const cutoff = new Date(Date.now() - DEFAULT_RETENTION.maxAgeMs).toISOString();
    const removed = store.pruneOlderThan(cutoff, 5_000);
    expect(removed).toBe(2); // 1 stale record + 1 old rejection
    expect(store.recordCount()).toBe(0);
    expect(store.recentRejections(10)).toHaveLength(1);
    store.close();
  });

  it('global index: size-prune removes oldest events, keeps latest view', () => {
    const g = new GlobalStore(':memory:');
    const big = JSON.stringify({ pad: 'x'.repeat(2048) });
    for (let i = 1; i <= 12; i++) {
      g.putRecord({
        seq: i, commitCid: `c${i}`, did: 'did:web:g', rev: `r${i}`, opAction: 'create',
        collection: 'app.omniroute.errorReport', rkey: String(i), opCid: `o${i}`,
        recordJson: big, sigOk: true, frameTime: new Date().toISOString(),
        indexedAt: new Date().toISOString(), arrivedAt: new Date().toISOString(),
        publisherSeq: i, publisherEmittedAt: new Date().toISOString(),
      });
    }
    expect(g.eventCount()).toBe(12);
    const removed = g.pruneToBytes(8 * 1024, 3);
    expect(removed).toBeGreaterThan(0);
    expect(g.eventCount()).toBeLessThan(12);
    // latest_record (the live view) is never touched by size pruning.
    expect(g.latestRecords().length).toBe(12);
    g.close();
  });

  it('pruneStore reports per-store and never throws on a healthy store', () => {
    const seq = new SqliteSequencerStore(':memory:');
    seq.append({ did: 'did:web:x', type: '#commit', payload: new Uint8Array([1]) });
    const report = pruneStore(seq, { maxAgeMs: DEFAULT_RETENTION.maxAgeMs, maxBytes: DEFAULT_RETENTION.maxBytes });
    expect(report.label).toBe('sequencer');
    expect(report.agedOut).toBe(0);
    expect(report.sizePruned).toBe(0);
    expect(report.bytesAfter).toBeGreaterThan(0);
    seq.close();
  });
});
