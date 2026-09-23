/**
 * The normalized shape every agent-CLI log source is reduced to.
 *
 * WHAT AN ADAPTER MAY EMIT, AND NOTHING ELSE. These logs are the user's private
 * conversations. An adapter reads them looking ONLY for error/status/model
 * fields; the shapes below have no field that can carry prompt or response text,
 * no session or request identifier, and no filesystem path, so an adapter that
 * accidentally scooped up a transcript line has nowhere to put it. That is the
 * point of the type: privacy enforced by the data model rather than by review.
 *
 * The one deliberate omission worth naming: there is no `sessionId`. The
 * research on Claude Code's transcripts shows errors CLUSTER (one auth expiry or
 * one workflow fan-out produces a dozen records in milliseconds), and the
 * obvious deduplication key would be the session. We dedupe on
 * (source, provider, model, code) inside a time window instead - see
 * `dedupe.ts` - which collapses the same bursts without ever holding a session
 * identifier.
 */

/** One provider failure, reduced to the only five things worth keeping. */
export interface ErrorEvent {
  /** When the CLI recorded the failure, epoch ms. */
  timestampMs: number;
  /**
   * OTel `gen_ai.provider.name`, or `unknown` when the log does not establish
   * it. NEVER guessed: a wrong provider corrupts the federated aggregate more
   * than a missing one does. See each adapter's attribution note.
   */
  provider: string;
  /** OTel `gen_ai.request.model`, or `unknown`. */
  model: string;
  /**
   * The provider's own error-code / error-type string, normalized by the
   * adapter into the vocabulary `src/genai/error-classify.ts` already knows
   * (`rate_limit_error`, `overloaded_error`, `connection_error`, `503`, ...).
   * Normalizing at the adapter is what keeps the classifier from having to
   * learn every CLI's private spelling of "the stream broke".
   */
  errorCode: string;
  /** HTTP status when the CLI recorded one. The classifier's weak secondary signal. */
  httpStatus?: number;
  /** Which adapter produced this. Local-only: it does not reach a record. */
  sourceCli: string;
}

/**
 * A successful request the adapter observed, counted per (provider, model).
 * This is the DENOMINATOR, and it is what makes an error count mean anything -
 * 5 errors out of 5 requests and out of 5000 are opposite signals.
 */
export interface AttemptCount {
  provider: string;
  model: string;
  /** Requests observed that did NOT fail. Errors are counted separately. */
  successes: number;
}

/** What one adapter found in one run. */
export interface SourceObservation {
  /** Adapter id, e.g. `claude-code`. */
  sourceCli: string;
  events: ErrorEvent[];
  attempts: AttemptCount[];
  /** Files (or DB row ranges) the run actually read. Local logging only. */
  sourcesScanned: number;
  /** Bytes read this run. Local logging only; proves the cursor works. */
  bytesScanned: number;
  /**
   * Operator-facing reasons this adapter could not do its whole job (an
   * unreadable file, a missing sqlite binding). Never contains a path under the
   * user's project tree - see `redactPath`.
   */
  warnings: string[];
}

/** Everything an adapter needs from the run, injected so tests own all of it. */
export interface CollectContext {
  /** Root the adapter reads under. Tests point this at a fixture. */
  root: string;
  /** Per-file cursors, persisted between runs. */
  cursors: CursorStore;
  /** Wall clock, injectable. */
  now: () => number;
  /**
   * Ignore events older than this (epoch ms). A first run on a laptop with five
   * weeks of transcripts would otherwise publish five weeks of history as if it
   * had just happened.
   */
  minTimestampMs: number;
}

/** A source of error events. One per agent CLI. */
export interface SourceAdapter {
  /** Stable id used in logs, config, and `ErrorEvent.sourceCli`. */
  readonly id: string;
  /** Default root under the user's home. */
  defaultRoot(home: string): string;
  /** Is this CLI installed and has it written anything? Cheap: a stat, not a scan. */
  detect(root: string): boolean;
  collect(ctx: CollectContext): Promise<SourceObservation>;
}

/**
 * Cursor state for one file, so a rerun does not rescan 700 MB of transcripts.
 *
 * `inode` and `size` together detect the two ways a log file stops being the
 * file we remember: ROTATION (a new file at the same path - inode changes) and
 * TRUNCATION (the same file emptied and rewritten - size drops below our
 * offset). Either resets `offset` to 0 and rereads, which is the safe direction:
 * re-reading costs time, skipping costs data.
 */
export interface FileCursor {
  offset: number;
  size: number;
  inode: number;
  /** Last run that saw this file, epoch ms. Drives pruning of dead cursors. */
  lastSeenMs: number;
}

export interface CursorStore {
  /** Look up a file cursor. `key` is a HASH of the path, never the path. */
  getFile(key: string): FileCursor | undefined;
  setFile(key: string, cursor: FileCursor): void;
  /** Highest sqlite rowid consumed for a named table, or 0. */
  getRowId(key: string): number;
  setRowId(key: string, rowId: number): void;
}

/** The unknown-provider / unknown-model sentinel. One spelling, checked in tests. */
export const UNKNOWN = 'unknown';

/**
 * Field separator for the composite map keys used to group by
 * (provider, model) and to dedupe by (source, provider, model, code).
 *
 * A NUL rather than a space, and a NAMED constant rather than a literal at each
 * call site. Both parts matter: a model id is free-form and could contain a
 * space, which would let two different pairs collide into one group; and a
 * separator written out at four call sites is a separator that eventually
 * differs at one of them, which is a silent mis-grouping rather than a crash.
 */
export const KEY_SEP = String.fromCharCode(0);

export function groupKey(...parts: readonly string[]): string {
  return parts.join(KEY_SEP);
}

export function splitGroupKey(key: string): string[] {
  return key.split(KEY_SEP);
}
