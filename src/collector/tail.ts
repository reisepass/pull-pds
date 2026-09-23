/**
 * Incremental line reading for append-only log files.
 *
 * Every adapter reads the same way: stat, resume at the cursor, stream the new
 * bytes, hand each COMPLETE line to a callback, and advance the cursor only as
 * far as the last newline actually seen. That last part is the whole trick - a
 * CLI writing a JSONL record is not atomic, so a run that fired mid-write would
 * otherwise consume half a line, fail to parse it, and skip a real error
 * permanently. Stopping at the last newline means the partial line is read whole
 * on the next run instead.
 *
 * NOTHING IS ACCUMULATED. Lines go to the callback one at a time and are
 * dropped; the only state that survives a line is whatever counters the adapter
 * chose to keep. On a corpus this size (700 MB of Claude Code transcripts) that
 * is a requirement rather than a style preference, and it is also what makes it
 * structurally impossible for this module to retain conversation text.
 */
import { openSync, readSync, closeSync, statSync } from 'node:fs';
import type { FileCursor } from './types.js';
import { resumeOffset } from './state.js';

/** Read this much at a time. Big enough to be one syscall per typical tail. */
const CHUNK_BYTES = 1024 * 1024;

/**
 * Refuse to hold a single line longer than this. A transcript line carrying a
 * large pasted file can be megabytes; we have no use for one, and buffering it
 * would be exactly the "read conversation content into memory" this collector
 * must not do. Over-long lines are skipped and counted.
 */
const MAX_LINE_BYTES = 256 * 1024;

export interface TailResult {
  /** The cursor to persist. Absent when the file could not be read at all. */
  cursor?: FileCursor;
  bytesRead: number;
  linesRead: number;
  /** Lines dropped for exceeding {@link MAX_LINE_BYTES}. */
  linesTooLong: number;
  /** The file was reread from the start (rotated or truncated). */
  rescanned: boolean;
  /** Read failure, already free of anything sensitive. */
  error?: string;
}

/**
 * Read the new lines of `path` since `cursor`, calling `onLine` for each.
 *
 * `onLine` returning false stops the read early; the cursor still advances past
 * the lines already consumed, because they HAVE been consumed.
 */
export function tailLines(
  path: string,
  cursor: FileCursor | undefined,
  nowMs: number,
  onLine: (line: string) => boolean | void,
): TailResult {
  let size: number;
  let ino: number;
  try {
    const st = statSync(path);
    size = st.size;
    ino = st.ino;
  } catch (err) {
    return {
      bytesRead: 0,
      linesRead: 0,
      linesTooLong: 0,
      rescanned: false,
      error: `stat failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
    };
  }

  const { offset: start, rescanned } = resumeOffset(cursor, { size, ino });
  const base: FileCursor = { offset: start, size, inode: ino, lastSeenMs: nowMs };
  if (start >= size) {
    // Nothing new. The common case on every run after the first.
    return { cursor: base, bytesRead: 0, linesRead: 0, linesTooLong: 0, rescanned };
  }

  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    return {
      cursor: base,
      bytesRead: 0,
      linesRead: 0,
      linesTooLong: 0,
      rescanned,
      error: `open failed: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`,
    };
  }

  const buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let pos = start;
  let consumed = start; // advances only past a newline
  // The partial line carried across a chunk boundary. `carryBytes` counts every
  // byte of it INCLUDING bytes dropped by the overflow guard, so `consumed`
  // stays exact even for a line we refused to hold.
  let carry = '';
  let carryBytes = 0;
  let carryOverflow = false;
  let linesRead = 0;
  let linesTooLong = 0;
  let stop = false;

  try {
    while (!stop && pos < size) {
      const want = Math.min(CHUNK_BYTES, size - pos);
      const got = readSync(fd, buf, 0, want, pos);
      if (got <= 0) break;
      pos += got;
      // `latin1` keeps one byte = one char, so byte offsets stay exact even for
      // a line holding multi-byte UTF-8. Lines are re-decoded as UTF-8 below.
      const text = buf.toString('latin1', 0, got);
      let from = 0;
      for (;;) {
        const nl = text.indexOf('\n', from);
        if (nl === -1) break;
        const piece = text.slice(from, nl);
        from = nl + 1;
        consumed += carryBytes + piece.length + 1;
        const overflowed = carryOverflow;
        const line = carry + piece;
        carry = '';
        carryBytes = 0;
        carryOverflow = false;
        if (overflowed) {
          linesTooLong++;
          continue;
        }
        if (line.length === 0) continue;
        // Also checked here, not only on the carry path: a long line that
        // happens to fit inside one chunk would otherwise be handed on whole.
        if (line.length > MAX_LINE_BYTES) {
          linesTooLong++;
          continue;
        }
        linesRead++;
        if (onLine(Buffer.from(line, 'latin1').toString('utf8')) === false) {
          stop = true;
          break;
        }
      }
      if (!stop) {
        const rest = text.slice(from);
        carryBytes += rest.length;
        if (carryOverflow || carryBytes > MAX_LINE_BYTES) {
          // Drop what we hold and discard the rest of this line when it ends.
          carry = '';
          carryOverflow = true;
        } else {
          carry += rest;
        }
      }
    }
  } finally {
    closeSync(fd);
  }

  return {
    cursor: { offset: consumed, size, inode: ino, lastSeenMs: nowMs },
    bytesRead: consumed - start,
    linesRead,
    linesTooLong,
    rescanned,
  };
}

/**
 * Parse a JSONL line, returning undefined rather than throwing. A transcript
 * always has some line a parser does not like (a rotation artefact, a partial
 * flush); one bad line must never stop a scan.
 */
export function parseJsonLine(line: string): Record<string, unknown> | undefined {
  const t = line.trim();
  if (t.length === 0 || t[0] !== '{') return undefined;
  try {
    const v: unknown = JSON.parse(t);
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
    return v as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
