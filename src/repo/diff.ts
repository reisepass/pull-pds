import { CID } from 'multiformats';
import { WriteOpAction } from '@atproto/repo';
import type { RecordWriteOp } from '@atproto/repo';
import type { RepoRecord } from '@atproto/lexicon';
import { cidForRecord } from '@atproto/repo';

/**
 * The snapshot diff engine.
 *
 * A publisher's `feed.json` in snapshot mode is its *complete current desired
 * state*. The aggregator diffs it against what the repo currently holds and
 * emits the minimal set of `[put|update|delete]` ops that make the repo match
 * the feed:
 *
 *   - `(collection, rkey)` in feed but not in repo      -> Create
 *   - `(collection, rkey)` in both, different content   -> Update
 *   - `(collection, rkey)` in both, identical content   -> (no op)
 *   - `(collection, rkey)` in repo but absent from feed -> Delete
 *
 * Content identity is by record CID (the DAG-CBOR content address), so record
 * *reordering* in the feed produces no ops (F: reorder must not spuriously
 * commit) and a byte-identical re-post produces no ops (unchanged feed -> 204).
 */

/** One desired record from a feed snapshot. */
export interface DesiredRecord {
  collection: string;
  rkey: string;
  record: RepoRecord;
}

/** The current CID of a stored record, keyed by `collection/rkey`. */
export type CurrentState = Map<string, CID>;

export interface DiffResult {
  writes: RecordWriteOp[];
  /**
   * The prior record CID for each update/delete op, keyed by `collection/rkey`.
   * Sync 1.1 per-op `prev` linkage: the reference relay's MST inversion
   * (`repo.VerifyCommitMessage`) requires every update/delete op to carry the
   * CID it replaced, otherwise it logs "can't invert legacy op" and skips the
   * MST-diff check. Creates have no prior CID and are absent from this map.
   */
  prevCids: Map<string, CID>;
  /** Convenience counts for logging / sanity bounds. */
  creates: number;
  updates: number;
  deletes: number;
}

export function dataKey(collection: string, rkey: string): string {
  return `${collection}/${rkey}`;
}

/**
 * Compute the snapshot diff. `current` maps `collection/rkey` -> stored record
 * CID; `desired` is the feed's record list. Deterministic ordering: deletes,
 * then creates, then updates, each sorted by key, so two runs over the same
 * inputs produce identical write lists (matters for test stability and for the
 * firehose `ops` array being reproducible).
 */
export async function diffSnapshot(
  current: CurrentState,
  desired: DesiredRecord[],
): Promise<DiffResult> {
  const desiredByKey = new Map<string, DesiredRecord>();
  const desiredCids = new Map<string, CID>();
  for (const d of desired) {
    const key = dataKey(d.collection, d.rkey);
    desiredByKey.set(key, d);
    desiredCids.set(key, await cidForRecord(d.record));
  }

  const creates: RecordWriteOp[] = [];
  const updates: RecordWriteOp[] = [];
  const deletes: RecordWriteOp[] = [];
  // prev record CID per update/delete key (Sync 1.1 per-op linkage).
  const prevCids = new Map<string, CID>();

  // Creates + updates: walk desired.
  for (const [key, d] of desiredByKey) {
    const cur = current.get(key);
    const next = desiredCids.get(key) as CID;
    if (!cur) {
      creates.push({
        action: WriteOpAction.Create,
        collection: d.collection,
        rkey: d.rkey,
        record: d.record,
      });
    } else if (!cur.equals(next)) {
      updates.push({
        action: WriteOpAction.Update,
        collection: d.collection,
        rkey: d.rkey,
        record: d.record,
      });
      prevCids.set(key, cur); // the CID this update replaces
    }
    // identical CID -> no op
  }

  // Deletes: anything in the repo but absent from the feed.
  for (const key of current.keys()) {
    if (!desiredByKey.has(key)) {
      const { collection, rkey } = parseDataKey(key);
      deletes.push({ action: WriteOpAction.Delete, collection, rkey });
      prevCids.set(key, current.get(key) as CID); // the CID this delete removes
    }
  }

  const byKey = (a: RecordWriteOp, b: RecordWriteOp) =>
    dataKey(a.collection, a.rkey).localeCompare(dataKey(b.collection, b.rkey));
  deletes.sort(byKey);
  creates.sort(byKey);
  updates.sort(byKey);

  return {
    writes: [...deletes, ...creates, ...updates],
    prevCids,
    creates: creates.length,
    updates: updates.length,
    deletes: deletes.length,
  };
}

export function parseDataKey(key: string): { collection: string; rkey: string } {
  const slash = key.indexOf('/');
  if (slash === -1) throw new Error(`Malformed data key: ${key}`);
  return { collection: key.slice(0, slash), rkey: key.slice(slash + 1) };
}
