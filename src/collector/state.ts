/**
 * Incremental-scan state: per-file cursors and a run lock, on disk.
 *
 * WHY THIS EXISTS. The Claude Code transcript corpus on a working laptop is
 * ~700 MB across ~1250 files. Rescanning it every 30 minutes to find ~57 error
 * records would be a laptop-heating no-op 99.99% of the time. The cursor turns
 * every run after the first into "stat every file, read the tail of the few that
 * grew".
 *
 * WHAT IS AND IS NOT WRITTEN HERE. Counts and cursors, nothing else. Never a
 * record, never a line of a transcript. And never a PATH: a Claude Code
 * transcript path encodes the project directory it belongs to
 * (`~/.claude/projects/-Users-someone-workspace-secret-client/...`), so the
 * state file keys on a SHA-256 of the absolute path instead. The hash is
 * one-way, stable across runs, and useless to anyone reading the file. The cost
 * is that the state file is not human-diagnosable by eye; the `--status` flag
 * prints what an operator actually needs instead.
 *
 * CONCURRENCY. Two runs can overlap (a slow scan still going when the timer
 * fires again). The lock is an `O_EXCL` create, so the second run loses the race
 * cleanly and exits 0 rather than double-counting the same log lines. State is
 * written write-temp-then-rename, so a crash mid-write leaves the previous
 * state intact rather than a truncated JSON file that would force a full
 * rescan.
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
  statSync,
  existsSync,
} from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { log } from '../log.js';
import type { CursorStore, FileCursor } from './types.js';

const STATE_VERSION = 1;
const STATE_FILE = 'cursors.json';
const LOCK_FILE = 'run.lock';

/**
 * Drop cursors for files nothing has seen in this long. Claude Code prunes
 * transcripts on a 30-day default retention, so their cursors would otherwise
 * accumulate forever. 45 days leaves room for a longer `cleanupPeriodDays`
 * without the state file growing without bound.
 */
const CURSOR_TTL_MS = 45 * 24 * 60 * 60 * 1000;

/**
 * A lock older than this is assumed to belong to a run that was killed. Long
 * enough that a genuinely slow first scan of a 700 MB corpus is never stolen
 * from, short enough that a crash does not wedge the timer for a day.
 */
const LOCK_STALE_MS = 60 * 60 * 1000;

interface StateFile {
  version: number;
  /** Epoch ms at the end of the previous successful run. The window start. */
  lastRunEndMs: number;
  /** sha256(absolute path) -> cursor. */
  files: Record<string, FileCursor>;
  /** Named sqlite table -> highest rowid consumed. */
  rows: Record<string, number>;
}

/** Stable, one-way key for a path. Never store the path itself. */
export function pathKey(path: string): string {
  return createHash('sha256').update(path).digest('hex');
}

/**
 * A path safe to put in a log line: the basename only, and only when it carries
 * no project name. Claude Code's per-project directories encode a full absolute
 * path in their NAME, so a bare basename of a transcript is still a leak; the
 * file's own name is a session UUID, which is also off limits. So log lines get
 * the adapter id and a count, and this returns the directory-level anchor only.
 */
export function redactPath(path: string, root: string): string {
  if (!path.startsWith(root)) return '<outside-root>';
  const rel = path.slice(root.length).replace(/^\/+/, '');
  const depth = rel.split('/').length;
  return `<${basename(root)}>/…${depth} levels`;
}

export class CollectorState implements CursorStore {
  private state: StateFile;
  private lockPath: string | undefined;

  private constructor(
    private readonly dir: string,
    state: StateFile,
  ) {
    this.state = state;
  }

  /** Load (or start) state in `dir`. Creates the directory if missing. */
  static load(dir: string): CollectorState {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, STATE_FILE);
    let state: StateFile = { version: STATE_VERSION, lastRunEndMs: 0, files: {}, rows: {} };
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StateFile>;
        // A state file from a future or unrecognised version is discarded rather
        // than half-read: a wrong cursor silently skips real errors, and losing
        // one run's incrementality is much cheaper than losing the data.
        if (parsed.version === STATE_VERSION) {
          state = {
            version: STATE_VERSION,
            lastRunEndMs: typeof parsed.lastRunEndMs === 'number' ? parsed.lastRunEndMs : 0,
            files: isRecord(parsed.files) ? (parsed.files as Record<string, FileCursor>) : {},
            rows: isRecord(parsed.rows) ? (parsed.rows as Record<string, number>) : {},
          };
        } else {
          log.warn('collector state version mismatch - starting fresh', {
            found: parsed.version,
            expected: STATE_VERSION,
          });
        }
      } catch (err) {
        log.warn('collector state unreadable - starting fresh', { reason: (err as Error).message });
      }
    }
    return new CollectorState(dir, state);
  }

  getFile(key: string): FileCursor | undefined {
    return this.state.files[key];
  }

  setFile(key: string, cursor: FileCursor): void {
    this.state.files[key] = cursor;
  }

  getRowId(key: string): number {
    return this.state.rows[key] ?? 0;
  }

  setRowId(key: string, rowId: number): void {
    this.state.rows[key] = rowId;
  }

  /**
   * Start of this run's aggregation window: the end of the last successful run.
   * 0 on a first run, which the caller turns into a bounded backfill window
   * rather than "everything on disk".
   */
  get lastRunEndMs(): number {
    return this.state.lastRunEndMs;
  }

  set lastRunEndMs(ms: number) {
    this.state.lastRunEndMs = ms;
  }

  /** Number of live file cursors. Logged so an operator can see the scan shrink. */
  get cursorCount(): number {
    return Object.keys(this.state.files).length;
  }

  /**
   * Take the run lock. Returns false when another run holds a fresh one, which
   * is not an error: the timer fired while the previous run was still going, and
   * the right response is to exit 0 and let that run finish.
   */
  acquireLock(now: number): boolean {
    const path = join(this.dir, LOCK_FILE);
    try {
      const fd = openSync(path, 'wx', 0o600);
      closeSync(fd);
      writeFileSync(path, `${process.pid}\n`, { mode: 0o600 });
      this.lockPath = path;
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    // Someone holds it. Break it only if it is old enough to be a corpse.
    let ageMs = 0;
    try {
      ageMs = now - statSync(path).mtimeMs;
    } catch {
      return false; // it vanished between the create and the stat; let the winner have it
    }
    if (ageMs < LOCK_STALE_MS) return false;
    log.warn('collector breaking a stale run lock', { ageMs, staleAfterMs: LOCK_STALE_MS });
    try {
      writeFileSync(path, `${process.pid}\n`, { mode: 0o600 });
      this.lockPath = path;
      return true;
    } catch {
      return false;
    }
  }

  /** Release the lock. Safe to call when it was never taken. */
  releaseLock(): void {
    if (this.lockPath === undefined) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* already gone: another run broke it as stale, which is its right */
    }
    this.lockPath = undefined;
  }

  /**
   * Persist. Prunes cursors for files nothing has seen in {@link CURSOR_TTL_MS},
   * so a laptop that has been running this for a year does not carry a cursor
   * per long-deleted transcript.
   */
  save(now: number): void {
    let pruned = 0;
    for (const [key, cursor] of Object.entries(this.state.files)) {
      if (now - cursor.lastSeenMs > CURSOR_TTL_MS) {
        delete this.state.files[key];
        pruned++;
      }
    }
    const path = join(this.dir, STATE_FILE);
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${STATE_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        /* the temp file may never have been created */
      }
      throw err;
    }
    if (pruned > 0) log.debug('collector pruned dead cursors', { pruned });
  }
}

/**
 * Decide where to resume reading `path`, given its cursor. Returns the byte
 * offset to start from and whether this is a full (re)read.
 *
 * Rotation and truncation both land on offset 0 deliberately. Guessing that a
 * shrunken file was "probably just rotated, skip it" is how a collector silently
 * stops collecting.
 */
export function resumeOffset(
  cursor: FileCursor | undefined,
  stat: { size: number; ino: number },
): { offset: number; rescanned: boolean } {
  if (cursor === undefined) return { offset: 0, rescanned: false };
  if (cursor.inode !== stat.ino) return { offset: 0, rescanned: true }; // rotated
  if (stat.size < cursor.offset) return { offset: 0, rescanned: true }; // truncated
  return { offset: cursor.offset, rescanned: false };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
