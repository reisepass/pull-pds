import { log } from './log.js';

/**
 * Retention pruning (REDESIGN-TASK §2). One cheap PERIODIC pass — never on the
 * write path — that caps every store at 6 months of age OR ~0.5 GB on disk,
 * whichever hits first. Each store implements `pruneRetention` with a batched
 * DELETE (bounded per batch so one pass never holds the DB for long), and the
 * scheduler logs exactly what was removed.
 *
 * Cost discipline (the box already OOM'd once): the timer is `unref()`ed so it
 * never keeps a process alive, each store caps rows deleted per pass, and there
 * is no per-write bookkeeping — just a `setInterval` on a multi-minute tick.
 */

export interface RetentionPolicy {
  /** Rows older than this are dropped. Default 6 months. */
  maxAgeMs: number;
  /**
   * Soft on-disk budget per store. When a store reports itself over budget the
   * pass keeps pruning oldest-first until it fits (or hits the per-pass batch
   * cap). Default 0.5 GB.
   */
  maxBytes: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  maxAgeMs: 6 * 30 * 24 * 60 * 60 * 1000, // 6 months
  maxBytes: 512 * 1024 * 1024, // 0.5 GB
};

/** One store that knows how to prune itself. Implemented by each sqlite store. */
export interface PrunableStore {
  /** Human/store label for the prune log line (e.g. 'repo did:web:x'). */
  retentionLabel(): string;
  /** Age-prune rows older than `olderThanIso`; returns rows removed. */
  pruneOlderThan(olderThanIso: string, batchCap: number): number;
  /** Current size in bytes (content bytes; cheap SUM or file stat). */
  sizeInBytes(): number;
  /** Size-prune oldest rows until under `maxBytes` (or batchCap hit). */
  pruneToBytes(maxBytes: number, batchCap: number): number;
}

export interface RetentionPruneReport {
  label: string;
  agedOut: number;
  sizePruned: number;
  bytesAfter: number;
}

/** Prune a single store: age first, then size. Never throws. */
export function pruneStore(
  store: PrunableStore,
  policy: RetentionPolicy = DEFAULT_RETENTION,
  batchCap = 5_000,
): RetentionPruneReport {
  const cutoff = new Date(Date.now() - policy.maxAgeMs).toISOString();
  let agedOut = 0;
  let sizePruned = 0;
  try {
    agedOut = store.pruneOlderThan(cutoff, batchCap);
  } catch (err) {
    log.warn('retention: age prune failed', { label: store.retentionLabel(), err: (err as Error).message });
  }
  try {
    if (store.sizeInBytes() > policy.maxBytes) {
      sizePruned = store.pruneToBytes(policy.maxBytes, batchCap);
    }
  } catch (err) {
    log.warn('retention: size prune failed', { label: store.retentionLabel(), err: (err as Error).message });
  }
  return { label: store.retentionLabel(), agedOut, sizePruned, bytesAfter: safeSize(store) };
}

function safeSize(store: PrunableStore): number {
  try {
    return store.sizeInBytes();
  } catch {
    return -1;
  }
}

/**
 * Run `pruneStore` over `stores()` every `intervalMs` (default 5 min). The
 * timer is unref'd; the store list is re-fetched each tick so repos created
 * after boot are covered. Logs one line per store that actually pruned
 * something — silence means nothing was over budget.
 */
export function startRetentionPruner(
  stores: () => PrunableStore[],
  policy: RetentionPolicy = DEFAULT_RETENTION,
  intervalMs = 5 * 60 * 1000,
): () => void {
  const tick = () => {
    let list: PrunableStore[];
    try {
      list = stores();
    } catch (err) {
      log.warn('retention: could not enumerate stores', { err: (err as Error).message });
      return;
    }
    for (const s of list) {
      const r = pruneStore(s, policy);
      if (r.agedOut > 0 || r.sizePruned > 0) {
        log.info('retention: pruned', {
          store: r.label,
          agedOut: r.agedOut,
          sizePruned: r.sizePruned,
          bytesAfter: r.bytesAfter,
        });
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  // One pass shortly after boot so a restarted-over-budget store shrinks now,
  // not 5 minutes from now. Kept off the boot path (async, unref'd).
  const first = setTimeout(tick, 15_000);
  first.unref();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
