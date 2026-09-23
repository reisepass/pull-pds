import type { RepoRecord } from '@atproto/lexicon';
import { ensureValidRecordKey, ensureValidNsid } from '@atproto/syntax';
import type { DesiredRecord } from '../repo/diff.js';

/**
 * Parse + validate a publisher's `feed.json` (pull-pds-spec.md §3.2, snapshot
 * mode). The feed is the complete desired state for the publisher's allowlisted
 * collections. This module is pure: it turns raw bytes into `DesiredRecord[]` or
 * a typed error. It does NOT decide the diff or touch storage.
 *
 * Rules enforced here (spec §3.2 / §5 step 5):
 *   - top-level `$type` is `app.pullpds.feed` and `did` matches the ingesting DID
 *   - every record's `collection` is in the allowlist (batch-atomic: one bad
 *     record fails the whole feed - spec §9 atomicity)
 *   - no duplicate `(collection, rkey)` (a snapshot with two values for one key
 *     is ambiguous; reject rather than pick one)
 *   - each `record` is a JSON object AND, when a `validateRecord` predicate is
*     supplied (SPEC-COMPLIANCE §4), matches its committed lexicon - schema,
 *     types, required fields, and no undeclared top-level fields. A record that
 *     fails is a `lexicon-invalid` FeedError, batch-atomic like every other
 *     rejection: one bad record fails the whole feed and nothing reaches the MST.
*     supplied, matches its committed lexicon - schema, types, required fields,
 *     and no undeclared top-level fields. A record that fails is a
 *     `lexicon-invalid` FeedError, batch-atomic like every other rejection: one
 *     bad record fails the whole feed and nothing reaches the MST. */

export class FeedError extends Error {
  constructor(
    readonly code: FeedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FeedError';
  }
}

export type FeedErrorCode =
  | 'invalid-json'
  | 'not-a-feed'
  | 'did-mismatch'
  | 'collection-not-allowed'
  | 'duplicate-key'
  | 'invalid-record'
  | 'lexicon-invalid'
  | 'record-too-deep'
  | 'record-not-encodable'
  | 'too-many-records';

/**
 * Max nesting depth of a single record value. atproto records are shallow config
 * blobs; a pathologically deep object (F-11) would overflow the recursive
 * DAG-CBOR encoder (`cidForRecord`) with a `RangeError` deep in the diff, turning
 * a ~60 KB feed (under `maxFeedBytes`) into a stack-overflow DoS. 32 is far above
 * any real record and well below the ~hundreds where V8's CBOR encoder recurses
 * into trouble.
 */
export const MAX_RECORD_DEPTH = 32;

export interface ParsedFeed {
  did: string;
  records: DesiredRecord[];
  /** Feed-supplied cursor (oplog mode); absent in snapshot mode. */
  cursor?: string;
}

export interface FeedParseOpts {
  /** The DID this ingest is for; the feed's `did` must equal it. */
  expectedDid: string;
  allowedCollections: string[];
  maxRecords: number;
  /**
* Optional per-record lexicon predicate (SPEC-COMPLIANCE §4). Returns null if
   * the record is valid, or a human-readable reason string to reject it. Runs
   * after structural checks, before the record enters the batch. Injected so
* Optional per-record lexicon predicate (SECOND-EXAMPLE §Part 2). Returns null
   * if the record is valid, or a human-readable reason string to reject it. Runs
   * after the structural checks, before the record enters the batch. Injected so   * `parseFeed` stays pure and the validator is built once at boot.
   */
  validateRecord?: (collection: string, record: Record<string, unknown>) => string | null;
}

const FEED_TYPE = 'app.pullpds.feed';

export function parseFeed(bytes: Uint8Array, opts: FeedParseOpts): ParsedFeed {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    throw new FeedError('invalid-json', `feed.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(json)) {
    throw new FeedError('not-a-feed', 'feed.json is not a JSON object');
  }
  if (json.$type !== FEED_TYPE) {
    throw new FeedError('not-a-feed', `feed $type is not ${FEED_TYPE}`);
  }
  if (typeof json.did !== 'string') {
    throw new FeedError('not-a-feed', 'feed has no string did');
  }
  if (json.did !== opts.expectedDid) {
    // A feed claiming a different DID than the origin we fetched it from is a
    // binding violation - never ingest another identity's records.
    throw new FeedError(
      'did-mismatch',
      `feed did ${json.did} != ingesting did ${opts.expectedDid}`,
    );
  }

  const rawRecords = Array.isArray(json.records) ? json.records : null;
  if (!rawRecords) {
    throw new FeedError('not-a-feed', 'feed has no records array');
  }
  if (rawRecords.length > opts.maxRecords) {
    throw new FeedError(
      'too-many-records',
      `feed has ${rawRecords.length} records > cap ${opts.maxRecords}`,
    );
  }

  const seen = new Set<string>();
  const records: DesiredRecord[] = [];
  for (const raw of rawRecords) {
    if (!isObject(raw)) {
      throw new FeedError('invalid-record', 'feed record entry is not an object');
    }
    const { collection, rkey, record } = raw;
    if (typeof collection !== 'string' || typeof rkey !== 'string') {
      throw new FeedError('invalid-record', 'feed record has non-string collection/rkey');
    }
    // The collection must be a syntactically valid NSID and the rkey a valid
    // record key BEFORE the allowlist check - a malformed key (e.g. `../../x`,
    // empty, `.`/`..`, spaces) would otherwise reach the MST layer and throw an
    // opaque "Not a valid MST key" deep in commit construction (F-6). Reject it
    // here, batch-atomically, with a clear code and no commit work started.
    try {
      ensureValidNsid(collection);
    } catch {
      throw new FeedError('invalid-record', `collection ${collection} is not a valid NSID`);
    }
    try {
      ensureValidRecordKey(rkey);
    } catch {
      throw new FeedError('invalid-record', `rkey ${JSON.stringify(rkey)} is not a valid record key`);
    }
    if (!opts.allowedCollections.includes(collection)) {
      throw new FeedError(
        'collection-not-allowed',
        `collection ${collection} is not allowed`,
      );
    }
    if (!isObject(record)) {
      throw new FeedError('invalid-record', `record ${collection}/${rkey} value is not an object`);
    }
    if (exceedsDepth(record, MAX_RECORD_DEPTH)) {
      // Reject BEFORE the recursive DAG-CBOR encode in the diff (F-11).
      throw new FeedError('record-too-deep', `record ${collection}/${rkey} nests deeper than ${MAX_RECORD_DEPTH}`);
    }
    // Deep lexicon validation (SPEC-COMPLIANCE §4): schema/type/required-field +
    // no-undeclared-field check against the committed lexicon. Batch-atomic: a
    // single invalid record fails the whole feed, so nothing reaches the MST.
    if (opts.validateRecord) {
      const reason = opts.validateRecord(collection, record);
      if (reason) throw new FeedError('lexicon-invalid', reason);
    }
    // The AT Data Model (DAG-CBOR) supports only safe integers: a fractional
    // number or an integer beyond +-2^53-1 makes `cidForRecord` throw "Non-integer
    // numbers are not supported" deep in the diff (F-12), which would otherwise
    // surface as the generic `internal` catch-all on every ingest of that feed -
    // a hostile-input DoS/log-spam vector, same class as F-6 and F-11. Reject it
    // here, batch-atomically, before any commit work starts.
    const badNumberPath = firstUnencodableNumber(record);
    if (badNumberPath !== null) {
      throw new FeedError(
        'record-not-encodable',
        `record ${collection}/${rkey} has a value the AT Data Model cannot encode at ${badNumberPath} (only safe integers are allowed)`,
      );
    }
    const key = `${collection}/${rkey}`;
    if (seen.has(key)) {
      throw new FeedError('duplicate-key', `duplicate (collection, rkey): ${key}`);
    }
    seen.add(key);
    records.push({ collection, rkey, record: record as RepoRecord });
  }

  const parsed: ParsedFeed = { did: json.did, records };
  if (typeof json.cursor === 'string') parsed.cursor = json.cursor;
  return parsed;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * True if `value` nests objects/arrays deeper than `max`. Iterative (explicit
 * stack) so the check itself cannot overflow on a hostile input - the very thing
 * it defends against. Stops as soon as the limit is exceeded.
 */
function exceedsDepth(value: unknown, max: number): boolean {
  const stack: Array<{ v: unknown; depth: number }> = [{ v: value, depth: 0 }];
  while (stack.length > 0) {
    const { v, depth } = stack.pop() as { v: unknown; depth: number };
    if (depth > max) return true;
    if (Array.isArray(v)) {
      for (const child of v) stack.push({ v: child, depth: depth + 1 });
    } else if (typeof v === 'object' && v !== null) {
      for (const child of Object.values(v)) stack.push({ v: child, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * Find the first number in `value` that the AT Data Model (DAG-CBOR) cannot
 * encode - anything that is not a safe integer (`Number.isSafeInteger` is false):
 * a fraction, an out-of-range integer (|n| > 2^53-1), Infinity, or NaN. Returns
 * a dotted path to the offender (for the error message) or null if every number
 * is encodable. Iterative (explicit stack) so a record that is deep-but-legal
 * cannot overflow the check itself - the same discipline as `exceedsDepth`.
 *
 * `Number.isSafeInteger` is the correct predicate here: `@atproto/repo`'s CBOR
 * encoder accepts exactly the safe integers and throws on everything else, so a
 * looser `Number.isInteger` check would let 2^53 through to the throwing encoder.
 */
function firstUnencodableNumber(value: unknown): string | null {
  const stack: Array<{ v: unknown; path: string }> = [{ v: value, path: '' }];
  while (stack.length > 0) {
    const { v, path } = stack.pop() as { v: unknown; path: string };
    if (typeof v === 'number') {
      if (!Number.isSafeInteger(v)) return path || '(root)';
      continue;
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) stack.push({ v: v[i], path: `${path}[${i}]` });
    } else if (typeof v === 'object' && v !== null) {
      for (const [k, child] of Object.entries(v)) stack.push({ v: child, path: path ? `${path}.${k}` : k });
    }
  }
  return null;
}
