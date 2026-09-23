import { cborEncode } from '@atproto/lex-cbor';
import type { LexValue } from '@atproto/lex-cbor';
import type { CID } from 'multiformats';

/**
 * atproto firehose framing (`com.atproto.sync.subscribeRepos`).
 *
 * Every WebSocket message is two concatenated DAG-CBOR objects:
 *   1. a header `{ op, t }` where op=1 is a message and op=-1 is an error, and
 *      `t` is the message type (`#commit`, `#identity`, `#account`, `#sync`);
 *   2. the message body.
 *
 * This is the exact wire format the reference relay/consumer expect, so a
 * standard atproto subscriber consumes our firehose unmodified (the whole
 * justification for the MST/commit machinery per both specs).
 */

export type FrameType = '#commit' | '#identity' | '#account' | '#sync' | '#info';

/** Encode a normal (op=1) message frame: header ++ body. */
export function encodeFrame(type: FrameType, body: Record<string, unknown>): Uint8Array {
  const header = cborEncode({ op: 1, t: type } as LexValue);
  const payload = cborEncode(body as LexValue);
  return concat(header, payload);
}

/** Encode an error (op=-1) frame. */
export function encodeErrorFrame(error: string, message?: string): Uint8Array {
  const header = cborEncode({ op: -1 } as LexValue);
  const body = cborEncode((message ? { error, message } : { error }) as LexValue);
  return concat(header, body);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// --- message bodies -------------------------------------------------------

/** One write op in a `#commit` frame. */
export interface FirehoseOp {
  action: 'create' | 'update' | 'delete';
  path: string; // collection/rkey
  cid: CID | null; // null for deletes
  prev?: CID | null; // Sync 1.1: the prior record CID for update/delete
}

export interface CommitFrameInput {
  seq: number;
  repo: string; // did
  commit: CID; // commit block CID
  rev: string;
  since: string | null;
  blocks: Uint8Array; // CAR of the diff
  ops: FirehoseOp[];
  prevData: CID | null;
  time: string; // ISO
}

export function commitBody(i: CommitFrameInput): Record<string, unknown> {
  return {
    seq: i.seq,
    rebase: false,
    tooBig: false,
    repo: i.repo,
    commit: i.commit,
    rev: i.rev,
    since: i.since,
    blocks: i.blocks,
    ops: i.ops.map((o) => ({
      action: o.action,
      path: o.path,
      cid: o.cid ?? null,
      ...(o.prev !== undefined ? { prev: o.prev } : {}),
    })),
    blobs: [],
    prevData: i.prevData,
    time: i.time,
  };
}

export function identityBody(seq: number, did: string, time: string, handle?: string): Record<string, unknown> {
  return { seq, did, time, ...(handle ? { handle } : {}) };
}

export function accountBody(
  seq: number,
  did: string,
  time: string,
  active: boolean,
  status?: string,
): Record<string, unknown> {
  return { seq, did, time, active, ...(status ? { status } : {}) };
}

export function syncBody(
  seq: number,
  did: string,
  blocks: Uint8Array,
  rev: string,
  time: string,
): Record<string, unknown> {
  return { seq, did, blocks, rev, time };
}
