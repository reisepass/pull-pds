import { WriteOpAction, cidForRecord } from '@atproto/repo';
import type { RecordWriteOp } from '@atproto/repo';
import type { CID } from 'multiformats';
import { Sequencer } from './sequencer.js';
import {
  encodeFrame,
  commitBody,
  identityBody,
  accountBody,
  syncBody,
  type FirehoseOp,
} from './frames.js';
import type { CommitResult } from '../repo/repo-manager.js';
import { RepoManager } from '../repo/repo-manager.js';

/**
 * Turns a persisted commit into the sequence of firehose frames a Sync-1.1
 * consumer expects, and appends them through the
 * durable Sequencer.
 *
 * On the *first* ingest of a repo we emit `#identity`, `#account{active:true}`,
 * and `#sync` (a self-contained CAR of the initial commit) before the `#commit`,
 * so a relay that connects fresh can bootstrap. On later commits we emit only
 * `#commit`. `nowIso` is injected so the caller controls the timestamp (tests
 * pin it; production passes the wall clock).
 */
export class FirehoseService {
  constructor(private readonly seq: Sequencer) {}

  /**
   * Emit all frames for a commit. Returns the seq of the `#commit` frame (the
   * cursor a consumer would resume from).
   */
  async emitCommit(
    mgr: RepoManager,
    result: CommitResult,
    opts: { firstIngest: boolean; nowIso: string; handle?: string },
  ): Promise<{ commitSeq: number }> {
    const did = mgr.did;
    const { commit } = result;

    if (opts.firstIngest) {
      this.append(did, '#identity', encodeFrameSeq('#identity', (seq) => identityBody(seq, did, opts.nowIso, opts.handle)));
      this.append(did, '#account', encodeFrameSeq('#account', (seq) => accountBody(seq, did, opts.nowIso, true, 'active')));
      const fullCar = await mgr.fullCar();
      this.append(did, '#sync', encodeFrameSeq('#sync', (seq) => syncBody(seq, did, fullCar, commit.rev, opts.nowIso)));
    }

    const car = await mgr.commitCar(commit);
    const ops = await toFirehoseOps(result.ops, result.prevCids);
    const commitSeq = this.append(did, '#commit', (seq) =>
      encodeFrame(
        '#commit',
        commitBody({
          seq,
          repo: did,
          commit: commit.cid,
          rev: commit.rev,
          since: commit.since,
          blocks: car,
          ops,
          prevData: commit.prev, // Sync 1.1 linkage
          time: opts.nowIso,
        }),
      ),
    );
    return { commitSeq };
  }

  /** Emit an `#account{active:false}` deactivation (spec §9). */
  emitDeactivation(did: string, nowIso: string): number {
    return this.append(did, '#account', (seq) => encodeFrame('#account', accountBody(seq, did, nowIso, false, 'deactivated')));
  }

  /**
   * Append a frame whose body embeds the assigned seq. The sequencer assigns seq
   * atomically, but the frame body must carry that same seq - so we append a
   * placeholder to reserve the seq, then... no: instead we build the payload
   * from the seq the store *will* assign. Since append is synchronous and
   * single-threaded per process, we peek `currentSeq()+1`. The store's
   * AUTOINCREMENT then confirms it; a mismatch throws (see append()).
   */
  private append(did: string, type: string, build: (seq: number) => Uint8Array): number {
    const expected = this.seq.currentSeq() + 1;
    const payload = build(expected);
    const assigned = this.seq.append({ did, type, payload });
    if (assigned !== expected) {
      // Would only happen under concurrent appends to the same sequencer; the
      // ingest path serialises per repo and the sequencer is single-process.
      throw new Error(`Sequencer seq skew: expected ${expected}, got ${assigned}`);
    }
    return assigned;
  }
}

/** Helper: bind a body-builder that needs the seq into the append signature. */
function encodeFrameSeq(
  type: '#identity' | '#account' | '#sync',
  body: (seq: number) => Record<string, unknown>,
): (seq: number) => Uint8Array {
  return (seq) => encodeFrame(type, body(seq));
}

async function toFirehoseOps(
  ops: RecordWriteOp[],
  prevCids: Map<string, CID>,
): Promise<FirehoseOp[]> {
  const out: FirehoseOp[] = [];
  for (const op of ops) {
    const path = `${op.collection}/${op.rkey}`;
    // Sync 1.1 per-op linkage: update/delete carry `prev` = the CID they
    // replace/remove, so a relay can invert the MST diff. Create has no prev.
    const prev = prevCids.get(path) ?? null;
    if (op.action === WriteOpAction.Delete) {
      out.push({ action: 'delete', path, cid: null, prev });
    } else if (op.action === WriteOpAction.Create) {
      out.push({ action: 'create', path, cid: await cidForRecord(op.record) });
    } else {
      out.push({ action: 'update', path, cid: await cidForRecord(op.record), prev });
    }
  }
  return out;
}
