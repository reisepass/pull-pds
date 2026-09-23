import { describe, it, expect } from 'vitest';
import { SqliteSequencerStore } from '../src/storage/sqlite-sequencer-store.js';
import { Sequencer } from '../src/firehose/sequencer.js';

function ev(n: number) {
  return { did: 'did:web:x', type: '#commit', payload: new Uint8Array([n]) };
}

async function collect(gen: AsyncGenerator<{ seq: number }>, n: number): Promise<number[]> {
  const out: number[] = [];
  for await (const e of gen) {
    out.push(e.seq);
    if (out.length >= n) break;
  }
  return out;
}

describe('Sequencer stream', () => {
  it('backfills from an arbitrary past cursor, in order', async () => {
    const seq = new Sequencer(new SqliteSequencerStore());
    for (let i = 1; i <= 5; i++) seq.append(ev(i));
    const ac = new AbortController();
    const got = await collect(seq.stream(2, ac.signal), 3);
    ac.abort();
    expect(got).toEqual([3, 4, 5]);
  });

  it('delivers live events after draining history, no gap no dup', async () => {
    const seq = new Sequencer(new SqliteSequencerStore());
    seq.append(ev(1));
    seq.append(ev(2));
    const ac = new AbortController();
    const iter = seq.stream(0, ac.signal);
    const collected: number[] = [];
    const task = (async () => {
      for await (const e of iter) {
        collected.push(e.seq);
        if (collected.length >= 4) break;
      }
    })();
    // Give backfill a tick, then append live events.
    await new Promise((r) => setTimeout(r, 20));
    seq.append(ev(3));
    seq.append(ev(4));
    await task;
    ac.abort();
    expect(collected).toEqual([1, 2, 3, 4]);
  });

  it('a late subscriber that resumes from a cursor ends in the same state', async () => {
    const store = new SqliteSequencerStore();
    const seq = new Sequencer(store);
    for (let i = 1; i <= 3; i++) seq.append(ev(i));
    // Subscriber A saw up to seq 3, disconnects, reconnects from cursor 3.
    seq.append(ev(4));
    seq.append(ev(5));
    const ac = new AbortController();
    const resumed = await collect(seq.stream(3, ac.signal), 2);
    ac.abort();
    expect(resumed).toEqual([4, 5]); // exactly the missed events, no replay of 1-3
  });

  it('disconnect mid-stream then reconnect from the last-seen cursor loses nothing', async () => {
    const seq = new Sequencer(new SqliteSequencerStore());
    for (let i = 1; i <= 10; i++) seq.append(ev(i));

    // Reader A consumes the first 4 then "disconnects" (aborts).
    const acA = new AbortController();
    const seenA = await collect(seq.stream(0, acA.signal), 4);
    acA.abort();
    expect(seenA).toEqual([1, 2, 3, 4]);

    // More events arrive while A is disconnected.
    for (let i = 11; i <= 13; i++) seq.append(ev(i));

    // Reader A reconnects from its last-seen cursor (4) and must see 5..13 with
    // no gap and no replay of 1..4.
    const acB = new AbortController();
    const resumed = await collect(seq.stream(4, acB.signal), 9);
    acB.abort();
    expect(resumed).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it('does not duplicate an event that arrives during the backfill/live handoff', async () => {
    const seq = new Sequencer(new SqliteSequencerStore());
    for (let i = 1; i <= 500; i++) seq.append(ev(i % 256)); // exactly one page
    const ac = new AbortController();
    const iter = seq.stream(0, ac.signal);
    const seen: number[] = [];
    const task = (async () => {
      for await (const e of iter) {
        seen.push(e.seq);
        if (e.seq >= 501) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 5));
    seq.append(ev(1)); // seq 501, may land during handoff
    await task;
    ac.abort();
    // Strictly increasing, no duplicates.
    for (let i = 1; i < seen.length; i++) expect(seen[i]! > seen[i - 1]!).toBe(true);
    expect(seen[seen.length - 1]).toBe(501);
  });
});
