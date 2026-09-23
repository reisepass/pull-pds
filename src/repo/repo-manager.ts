import { CID } from 'multiformats';
import {
  Repo,
  WriteOpAction,
  blocksToCarFile,
  formatDataKey,
} from '@atproto/repo';
import type { CommitData, RecordWriteOp } from '@atproto/repo';
import type { RepoStorage } from '@atproto/repo';
import { TID } from '@atproto/common-web';
import type { RepoRecord } from '@atproto/lexicon';
import { asKeypair, type CommitSigner } from './commit-signer.js';
import { SqliteRepoStorage } from '../storage/sqlite-repo-store.js';
import { diffSnapshot, dataKey, type DesiredRecord } from './diff.js';

/**
 * The design-neutral commit pipeline (pull-pds-spec.md §5 steps 6-8), everything
 * *above* the signature. It:
 *   - loads (or lazily creates) the repo from storage,
 *   - reads the current record set (for the diff engine),
 *   - turns a set of writes into a signed CommitData using an injected
 *     `CommitSigner` (so PA=local key, SS=remote signature drop in unchanged),
 *   - persists blocks + the commit-log row,
 *   - exports CAR slices for the firehose and getRepo.
 *
 * `rev` is a TID seeded from the persisted last rev (QUESTIONS.md D2 / FINDINGS
 * F-D2): `TID.next(prev)` guarantees the new TID is strictly greater than the
 * previous even if the wall clock regressed across a restart.
 */
export class RepoManager {
  constructor(
    readonly storage: SqliteRepoStorage,
    private readonly signer: CommitSigner,
  ) {}

  get did(): string {
    return this.storage.did;
  }

  /** True if the repo has no root commit yet. */
  isEmpty(): boolean {
    return this.storage.getRoot() === null;
  }

  getRoot(): CID | null {
    return this.storage.getRoot();
  }

  getRev(): string | null {
    return this.storage.getRev();
  }

  /**
   * Read the current record set as a `collection/rkey -> CID` map, for diffing.
   * Empty map if the repo is empty.
   */
  async currentState(): Promise<Map<string, CID>> {
    const out = new Map<string, CID>();
    const root = this.storage.getRoot();
    if (!root) return out;
    const repo = await Repo.load(this.storage.asRepoStorage(), root);
    for await (const entry of repo.walkRecords()) {
      out.set(dataKey(entry.collection, entry.rkey), entry.cid);
    }
    return out;
  }

  /**
   * Read the full current contents as records, for validation / getRecord.
   */
  async currentRecords(): Promise<
    Array<{ collection: string; rkey: string; cid: CID; record: RepoRecord }>
  > {
    const out: Array<{ collection: string; rkey: string; cid: CID; record: RepoRecord }> = [];
    const root = this.storage.getRoot();
    if (!root) return out;
    const repo = await Repo.load(this.storage.asRepoStorage(), root);
    for await (const entry of repo.walkRecords()) {
      out.push(entry);
    }
    return out;
  }

  /**
   * Diff a feed snapshot against the current repo (the PA snapshot path).
   * Returns the write ops that make the repo match the feed; empty if unchanged.
   */
  async diffAgainstFeed(desired: DesiredRecord[]) {
    const current = await this.currentState();
    return diffSnapshot(current, desired);
  }

  /**
   * Build + sign a commit for `writes` and persist it. Returns the CommitData
   * plus the ops (for the firehose `#commit`). Assumes `writes` is non-empty;
   * callers short-circuit an empty diff to a no-op (204) upstream.
   *
   * This is the one place the signer is used; everything above is identical
   * between the two designs.
   */
  async commitWrites(
    writes: RecordWriteOp[],
    prevCids?: Map<string, CID>,
  ): Promise<CommitResult> {
    if (writes.length === 0) {
      throw new Error('commitWrites called with no writes');
    }
    const keypair = asKeypair(this.signer);
    const root = this.storage.getRoot();

    let commit: CommitData;
    if (!root) {
      // First commit: create the repo with the writes as initial creates.
      // formatInitCommit only takes creates; updates/deletes on an empty repo
      // are nonsensical, so we assert all-creates here.
      const initialCreates = writes.map((w) => {
        if (w.action !== WriteOpAction.Create) {
          throw new Error(`First commit must be all creates, got ${w.action}`);
        }
        return w;
      });
      const rev = TID.nextStr();
      commit = await Repo.formatInitCommit(
        this.storage.asRepoStorage(),
        this.did,
        keypair,
        initialCreates,
        rev,
      );
    } else {
      const repo = await Repo.load(this.storage.asRepoStorage(), root);
      commit = await repo.formatCommit(writes, keypair);
    }

    this.storage.putCommit({
      root: commit.cid,
      rev: commit.rev,
      since: commit.since,
      commitCid: commit.cid,
      signingDidKey: this.signer.signingDidKey(),
      blocks: mapBlocks(commit),
      removedCids: commit.removedCids.toList(),
    });

    return {
      commit,
      ops: writes,
      prevCids: prevCids ?? new Map(),
      signingDidKey: this.signer.signingDidKey(),
    };
  }

  /**
   * The blocks that go on the firehose / into a diff CAR for this commit: the
   * new MST nodes, the new record leaves, the covering proofs, and the commit
   * block itself. `@atproto/repo`'s `relevantBlocks` is exactly this set.
   */
  async commitCar(commit: CommitData): Promise<Uint8Array> {
    return blocksToCarFile(commit.cid, commit.relevantBlocks);
  }

  /**
   * Full-repo CAR export (getRepo). `putCommit` prunes removed blocks, so the
   * stored block set is exactly the live set reachable from root.
   */
  async fullCar(): Promise<Uint8Array> {
    const root = this.storage.getRoot();
    if (!root) throw new Error('repo is empty');
    return blocksToCarFile(root, this.storage.allBlocks());
  }

  /**
   * getRepo with `since`: only the blocks written at a rev strictly greater than
   * `sinceRev`. Consumers already holding the older state need only the delta.
   */
  async carSince(sinceRev: string): Promise<Uint8Array> {
    const root = this.storage.getRoot();
    if (!root) throw new Error('repo is empty');
    return blocksToCarFile(root, this.storage.blocksSince(sinceRev));
  }

  /**
   * Covering-MST-proof CAR for one record (com.atproto.sync.getRecord).
   *
   * The CAR carries: the signed commit block (so the consumer checks the
   * signature + root), the covering MST proof (so it checks the record's
   * inclusion path), and the record leaf block itself (so `verifyRecords` can
   * read the value). Returns null if the repo is empty; returns a
   * proof-of-absence CAR (commit + covering proof, no leaf) if the record does
   * not exist.
   */
  async recordProofCar(collection: string, rkey: string): Promise<Uint8Array | null> {
    const root = this.storage.getRoot();
    if (!root) return null;
    const key = formatDataKey(collection, rkey);
    const repo = await Repo.load(this.storage.asRepoStorage(), root);
    const proof = await repo.data.getCoveringProof(key);
    // Include the commit block so a consumer can validate the signature + root.
    const commitBytes = this.storage.getBlockBytes(root);
    if (commitBytes) proof.set(root, commitBytes);
    // Include the record leaf block, if the record exists, so the value is readable.
    const recordCid = await repo.data.get(key);
    if (recordCid) {
      const recBytes = this.storage.getBlockBytes(recordCid);
      if (recBytes) proof.set(recordCid, recBytes);
    }
    return blocksToCarFile(root, proof);
  }
}

export interface CommitResult {
  commit: CommitData;
  ops: RecordWriteOp[];
  /** Prior record CID per update/delete op key (Sync 1.1 per-op `prev`). */
  prevCids: Map<string, CID>;
  signingDidKey: string;
}

function* mapBlocks(commit: CommitData) {
  for (const entry of commit.newBlocks.entries()) {
    yield { cid: entry.cid, bytes: entry.bytes, rev: commit.rev };
  }
}
