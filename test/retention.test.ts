import { describe, it, expect } from 'vitest';
import { SqliteSequencerStore } from '../src/storage/sqlite-sequencer-store.js';
import { pruneStore, DEFAULT_RETENTION } from '../src/retention.js';

/**
 * Retention pruning: 6 months OR 0.5 GB, whichever first.
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
