import type { CID } from 'multiformats';

/**
 * The durable persistence seam, kept behind an interface the way `AdmissionStore`
 * already is (BRIEF milestone-1, NEXT-TASK step 2). The concrete backend is
 * SQLite-per-repo (DESIGN.md open question 2 recommendation), but nothing above
 * this interface depends on that choice.
 *
 * This is design-neutral: both the self-sign and pull-aggregator models persist
 * the same artifact - a content-addressed block store, a chain of signed
 * commits, the current record set, and a monotonic firehose cursor. Only the
 * *source* of writes differs, never the stored shape.
 */

/** A stored, content-addressed block (an MST node, a record, or a commit). */
export interface StoredBlock {
  cid: CID;
  bytes: Uint8Array;
  /** The repo rev at which this block was written; lets us prune by revision. */
  rev: string;
}

/** A row in the per-repo commit log. */
export interface StoredCommit {
  /** The commit CID. */
  cid: CID;
  /** Monotonic repo revision (a TID). */
  rev: string;
  /** The previous commit's rev, or null for the first commit. */
  since: string | null;
  /** DAG-CBOR bytes of the signed commit block. */
  bytes: Uint8Array;
  /**
   * The did:key that signed this commit, recorded alongside it. did:web has no
   * audit log (DESIGN.md section 4); this is the only thing that keeps history
   * checkable after a key rotation. Design-neutral: under the aggregator model
   * it is the aggregator key, under self-sign it is the holder key.
   */
  signingDidKey: string;
}

/**
 * Per-repo storage. Read methods plus the block/commit writes needed to persist
 * an atproto repo. The concrete SQLite implementation also satisfies
 * `@atproto/repo`'s `RepoStorage`, so it plugs straight into `Repo`.
 */
export interface RepoStore {
  readonly did: string;

  /** The current repo root commit CID, or null if the repo is empty. */
  getRoot(): CID | null;
  /** The current repo revision, or null if empty. */
  getRev(): string | null;

  /** Fetch one block's bytes, or null if absent. */
  getBlockBytes(cid: CID): Uint8Array | null;
  /** True if the block is present. */
  hasBlock(cid: CID): boolean;

  /** Persist many blocks at a revision, then point the root at `root`@`rev`. */
  putCommit(params: {
    root: CID;
    rev: string;
    since: string | null;
    commitCid: CID;
    signingDidKey: string;
    blocks: Iterable<StoredBlock>;
    removedCids?: Iterable<CID>;
  }): void;

  /** The most recent commit, or null. */
  getLatestCommit(): StoredCommit | null;
  /** Walk the commit log newest-first, optionally stopping once `sinceRev` is passed. */
  listCommits(opts?: { sinceRev?: string | null }): StoredCommit[];

  /** Total stored block bytes - a cheap size signal for caps. */
  sizeInBytes(): number;

  close(): void;
}

/**
 * The durable, monotonic firehose cursor. One row per emitted event; the
 * sequencer assigns `seq` and this store persists it so a restart resumes
 * exactly where it left off (NEXT-TASK step 4).
 */
export interface SequencerStore {
  /**
   * Append an event and return its assigned monotonic seq. `payload` is the
   * opaque, already-encoded firehose frame; the sequencer owns its shape.
   */
  append(evt: { did: string; type: string; payload: Uint8Array }): number;

  /** The highest assigned seq, or 0 if none. */
  currentSeq(): number;

  /** Events with seq strictly greater than `cursor`, in seq order, capped at `limit`. */
  readSince(cursor: number, limit: number): SequencedEvent[];

  /**
   * Filtered variant of `readSince` (REDESIGN-TASK §3): only events whose frame
   * mentions one of `wantedCollections`. Optional — stores that implement it let
   * the sequencer push the collection filter down into the SQL query (cheap)
   * instead of scanning every frame payload in memory.
   */
  readSinceFiltered?(cursor: number, limit: number, wantedCollections: string[]): SequencedEvent[];

  close(): void;
}

export interface SequencedEvent {
  seq: number;
  did: string;
  type: string;
  payload: Uint8Array;
}
