import { EventEmitter } from 'node:events';
import type { SequencerStore, SequencedEvent } from '../storage/types.js';

/**
 * The durable, monotonic firehose sequencer (NEXT-TASK step 4).
 *
 * Wraps a `SequencerStore` (persistence) with an in-process `EventEmitter` (live
 * fan-out). Every emitted firehose frame is:
 *   1. persisted with an assigned monotonic `seq` (survives restart), then
 *   2. broadcast to connected `subscribeRepos` sockets.
 *
 * A late subscriber first drains everything strictly after its cursor from the
 * store (backfill), then switches to the live stream - with no gap and no
 * duplication, because it records the last seq it delivered and the live path
 * skips anything <= that. This is what makes "join late, getRepo, then
 * subscribe" end in the same state as "connected the whole time".
 */
export class Sequencer {
  private readonly emitter = new EventEmitter();

  constructor(private readonly store: SequencerStore) {
    // Firehose can have many concurrent subscribers.
    this.emitter.setMaxListeners(0);
  }

  /** Persist + assign a seq, then broadcast. Returns the assigned seq. */
  append(evt: { did: string; type: string; payload: Uint8Array }): number {
    const seq = this.store.append(evt);
    const seqEvt: SequencedEvent = { seq, ...evt };
    this.emitter.emit('event', seqEvt);
    return seq;
  }

  currentSeq(): number {
    return this.store.currentSeq();
  }

  /** Read a page of persisted events strictly after `cursor`. */
  readSince(cursor: number, limit: number): SequencedEvent[] {
    return this.store.readSince(cursor, limit);
  }

  /**
   * An async iterator over events from `cursor` onward: first backfilled from
   * the store in pages, then live. `signal` aborts it (socket close).
   *
   * A single persistent listener buffers every live event for the whole lifetime
   * of the stream, and a wakeup promise unblocks the consumer. This is the fix
   * for FINDINGS: a naive `emitter.once()` per iteration drops any event emitted
   * synchronously while the generator is suspended at a `yield` (no listener is
   * attached at that instant). Buffering unconditionally, and deduping by a
   * monotonic `lastDelivered`, closes both the backfill/live handoff gap and the
   * between-yields gap.
   */
  async *stream(
    cursor: number,
    signal: AbortSignal,
    pageSize = 500,
    opts: { wantedCollections?: string[] } = {},
  ): AsyncGenerator<SequencedEvent> {
    // REDESIGN-TASK §3: an optional collection filter. Backfill pushes it into
    // SQL (cheap); the live path matches the CBOR frame bytes for the NSID so a
    // filtered subscriber is never handed — and never buffers — a frame outside
    // its collections. Unfiltered when absent (the standard firehose).
    const wanted = opts.wantedCollections && opts.wantedCollections.length > 0 ? opts.wantedCollections : null;
    const wantedBytes = wanted?.map((c) => Buffer.from(`${c}/`, 'utf8')) ?? null;
    // Single Buffer wrap per frame, then a (tiny, usually 1-element) needle
    // scan. Buffer.includes is a memmem — no per-byte JS loop, no per-needle
    // copy of the payload.
    const matches = (e: SequencedEvent): boolean => {
      if (wantedBytes == null) return true;
      const buf = Buffer.isBuffer(e.payload) ? e.payload : Buffer.from(e.payload);
      for (const w of wantedBytes) if (buf.includes(w)) return true;
      return false;
    };

    let lastDelivered = cursor;
    const buffer: SequencedEvent[] = [];
    let wake: (() => void) | null = null;

    const onEvent = (e: SequencedEvent) => {
      // Only buffer frames the subscriber wants: a filtered socket must not
      // accumulate out-of-collection frames for the lifetime of the stream.
      if (matches(e)) buffer.push(e);
      wake?.();
    };
    const onAbort = () => wake?.();
    this.emitter.on('event', onEvent);
    signal.addEventListener('abort', onAbort);

    // FILTERED backfill: the store page contains only matching frames, so
    // `lastDelivered` cannot advance past non-matching frames by itself (it
    // would stall at the last match and re-read the same filtered page). We
    // instead advance the watermark to the store's current tip once the
    // filtered page runs dry, and close the race to the live buffer by
    // draining the buffer first in the live phase (dedupe by seq makes
    // re-delivery of anything the buffer captured harmless).
    const useFilteredStore = wanted != null && typeof this.store.readSinceFiltered === 'function';
    try {
      // 1. Backfill from the store. Live events arriving now land in `buffer`.
      for (;;) {
        if (signal.aborted) return;
        if (useFilteredStore) {
          const page = this.store.readSinceFiltered!(lastDelivered, pageSize, wanted as string[]);
          for (const e of page) {
            yield e; // filtered page: every row matches by construction
            lastDelivered = e.seq;
          }
          const tip = this.store.currentSeq();
          if (tip <= lastDelivered) break; // fully caught up to the tip
          // No more matches below the tip: resume live from the tip. Matching
          // frames between the last match and the tip are out-of-collection
          // (filtered out); matching frames AT/after the tip are in the buffer.
          lastDelivered = tip;
          break;
        }
        const page = this.store.readSince(lastDelivered, pageSize);
        if (page.length === 0) break;
        for (const e of page) {
          if (matches(e)) {
            yield e;
          }
          lastDelivered = e.seq;
        }
        if (page.length < pageSize) break;
      }

      // 2. Live: drain the buffer, then sleep until woken by a new event/abort.
      //    The seq guard re-delivers nothing already backfilled (dedupe), but
      //    DOES deliver anything the buffer captured during the backfill.
      for (;;) {
        if (signal.aborted) return;
        if (buffer.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
          continue;
        }
        const e = buffer.shift() as SequencedEvent;
        if (e.seq > lastDelivered) {
          yield e;
          lastDelivered = e.seq;
        }
      }
    } finally {
      this.emitter.off('event', onEvent);
      signal.removeEventListener('abort', onAbort);
    }
  }
}
