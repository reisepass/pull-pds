/**
 * Publish cadence: when a scan is allowed to turn into a published record.
 *
 * SCANNING AND PUBLISHING HAVE DIFFERENT COSTS, and conflating them is the
 * mistake this module exists to prevent. Reading local log files costs nothing -
 * no network, no session, no quota. Publishing opens a
 * `com.atproto.server.createSession`, and Bluesky caps those at 300 per DAY.
 * Every run is a separate process opening a separate session, so a naive
 * 5-minute publish cadence is 288 sessions/day against 300: no headroom for a
 * single manual run, and a failure mode that looks random when it arrives.
 *
 * So the two are decoupled. Scan often, publish rarely:
 *
 *   IDLE      scan every 5 min. Nothing new, nothing published.
 *   ALERT     something failed. Scan every 1 min for a bounded window, because
 *             a provider going down is exactly when fresh data is worth most.
 *   COOLDOWN  published; hold off for an hour. KEEP SCANNING AND ACCUMULATING -
 *             events found during cooldown are never dropped, they are batched
 *             into the next publish.
 *
 * The cooldown is not only about the session cap. These records are permanent
 * signed commits in someone's real account: an unthrottled incident would flood
 * their repo with near-duplicate records that can never be un-published. Backing
 * off is a courtesy to the operator's repo as much as to the PDS.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../log.js';

const CADENCE_FILE = 'cadence.json';
const CADENCE_VERSION = 1;

/** Bluesky's documented per-account ceiling on createSession. Not ours to raise. */
export const SESSION_CAP_PER_DAY = 300;

/**
 * What we allow ourselves of that cap. One publish/hour is 24/day; 48 leaves
 * room for manual runs, clock skew either side of the UTC boundary, and a retry,
 * while still sitting at 16% of the ceiling. The gap is deliberate: the cap is
 * shared with every other tool the operator runs against the same account.
 */
export const DEFAULT_MAX_PUBLISHES_PER_DAY = 48;

export const DEFAULT_IDLE_SCAN_MS = 5 * 60_000;
export const DEFAULT_ALERT_SCAN_MS = 60_000;
export const DEFAULT_ALERT_WINDOW_MS = 15 * 60_000;
export const DEFAULT_COOLDOWN_MS = 60 * 60_000;

/**
 * Floor on the cooldown, derived rather than chosen: a day divided by the
 * publish allowance. Intervals are configurable because deployments differ, but
 * no configuration may breach the session budget - a setting that quietly
 * exceeds a remote quota is a footgun, not a feature.
 */
export const MIN_COOLDOWN_MS = Math.ceil(86_400_000 / DEFAULT_MAX_PUBLISHES_PER_DAY);

export type CadencePhase = 'idle' | 'alert' | 'cooldown';

export interface CadenceOptions {
  idleScanMs: number;
  alertScanMs: number;
  alertWindowMs: number;
  cooldownMs: number;
  maxPublishesPerDay: number;
}

export const DEFAULT_CADENCE: CadenceOptions = {
  idleScanMs: DEFAULT_IDLE_SCAN_MS,
  alertScanMs: DEFAULT_ALERT_SCAN_MS,
  alertWindowMs: DEFAULT_ALERT_WINDOW_MS,
  cooldownMs: DEFAULT_COOLDOWN_MS,
  maxPublishesPerDay: DEFAULT_MAX_PUBLISHES_PER_DAY,
};

/**
 * Clamp an operator's cadence into what the session budget can actually pay for.
 * Returns the effective options and any adjustments made, so the caller can say
 * out loud that it overrode a setting rather than silently ignoring it.
 */
export function clampCadence(opts: Partial<CadenceOptions> = {}): {
  options: CadenceOptions;
  adjustments: string[];
} {
  const adjustments: string[] = [];
  const merged: CadenceOptions = { ...DEFAULT_CADENCE, ...opts };

  if (merged.maxPublishesPerDay > SESSION_CAP_PER_DAY) {
    adjustments.push(
      `maxPublishesPerDay ${merged.maxPublishesPerDay} exceeds the ${SESSION_CAP_PER_DAY}/day session cap; using ${DEFAULT_MAX_PUBLISHES_PER_DAY}`,
    );
    merged.maxPublishesPerDay = DEFAULT_MAX_PUBLISHES_PER_DAY;
  }
  if (merged.maxPublishesPerDay < 1) {
    adjustments.push(`maxPublishesPerDay must be at least 1; using 1`);
    merged.maxPublishesPerDay = 1;
  }

  const floor = Math.ceil(86_400_000 / merged.maxPublishesPerDay);
  if (merged.cooldownMs < floor) {
    adjustments.push(
      `cooldownMs ${merged.cooldownMs} would allow more than ${merged.maxPublishesPerDay} publishes/day; raised to ${floor}`,
    );
    merged.cooldownMs = floor;
  }
  if (merged.idleScanMs < 1_000) {
    adjustments.push('idleScanMs below 1s; raised to 1s');
    merged.idleScanMs = 1_000;
  }
  if (merged.alertScanMs < 1_000) {
    adjustments.push('alertScanMs below 1s; raised to 1s');
    merged.alertScanMs = 1_000;
  }
  return { options: merged, adjustments };
}

interface CadenceFile {
  version: number;
  /** Epoch ms of the last successful publish. 0 when nothing has published. */
  lastPublishMs: number;
  /** Epoch ms until which scanning stays at the fast interval. */
  alertUntilMs: number;
  /** UTC day (YYYY-MM-DD) the session counter belongs to. */
  sessionDayUtc: string;
  /** Publishes already spent on `sessionDayUtc`. */
  sessionsUsed: number;
  /** Events accumulated while cooling down, carried into the next publish. */
  pendingEvents: number;
}

export interface CadenceDecision {
  /** Whether this run may publish. */
  publish: boolean;
  phase: CadencePhase;
  /** How long the scheduler should wait before the next scan, in ms. */
  nextScanMs: number;
  /** Human-readable justification, logged and surfaced by `--status`. */
  reason: string;
  /** Events waiting to be published, including this run's. */
  pending: number;
  sessionsUsedToday: number;
  sessionsRemainingToday: number;
}

/** UTC calendar day for the session counter. Deliberately UTC: the cap is. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Cadence state, persisted beside the cursors but in its OWN file. Keeping them
 * separate means an operator can reset scheduling without losing incremental
 * position - and, more importantly, a corrupt cadence file cannot cost us the
 * cursors, which is the expensive half to rebuild.
 */
export class CadenceState {
  private constructor(
    private readonly dir: string,
    private file: CadenceFile,
  ) {}

  static load(dir: string): CadenceState {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, CADENCE_FILE);
    let file: CadenceFile = {
      version: CADENCE_VERSION,
      lastPublishMs: 0,
      alertUntilMs: 0,
      sessionDayUtc: '',
      sessionsUsed: 0,
      pendingEvents: 0,
    };
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CadenceFile>;
        if (parsed.version === CADENCE_VERSION) {
          file = {
            version: CADENCE_VERSION,
            lastPublishMs: numberOr(parsed.lastPublishMs, 0),
            alertUntilMs: numberOr(parsed.alertUntilMs, 0),
            sessionDayUtc: typeof parsed.sessionDayUtc === 'string' ? parsed.sessionDayUtc : '',
            sessionsUsed: numberOr(parsed.sessionsUsed, 0),
            pendingEvents: numberOr(parsed.pendingEvents, 0),
          };
        } else {
          log.warn('collector cadence version mismatch - starting fresh', {
            found: parsed.version,
            expected: CADENCE_VERSION,
          });
        }
      } catch (err) {
        // Starting fresh re-arms the cooldown from now, which errs toward
        // publishing LESS than configured rather than more. That is the safe
        // direction when the remote quota is the thing at stake.
        log.warn('collector cadence unreadable - starting fresh', {
          reason: (err as Error).message,
        });
      }
    }
    return new CadenceState(dir, file);
  }

  /**
   * Decide what this run may do. `newEvents` is the count of genuinely new,
   * post-dedupe errors this scan produced - zero means there is nothing worth a
   * session, however long it has been since the last publish.
   */
  decide(nowMs: number, newEvents: number, opts: CadenceOptions = DEFAULT_CADENCE): CadenceDecision {
    this.rollDayIfNeeded(nowMs);
    // A deferred run leaves the cursors untouched, so this scan's count ALREADY
    // includes everything the deferred one saw. Summing would double-count.
    // The stored figure is only a fallback for the odd case of a scan finding
    // nothing while a backlog is recorded.
    const pending = newEvents > 0 ? newEvents : this.file.pendingEvents;
    const remaining = Math.max(0, opts.maxPublishesPerDay - this.file.sessionsUsed);
    const inAlert = nowMs < this.file.alertUntilMs;
    const scan = inAlert || newEvents > 0 ? opts.alertScanMs : opts.idleScanMs;

    const base = {
      pending,
      sessionsUsedToday: this.file.sessionsUsed,
      sessionsRemainingToday: remaining,
    };

    if (pending === 0) {
      return {
        ...base,
        publish: false,
        phase: inAlert ? 'alert' : 'idle',
        nextScanMs: scan,
        reason: 'nothing new to publish',
      };
    }

    // Budget first. A day's allowance spent is a hard stop, not a suggestion:
    // burning the account's shared createSession quota to emit one more record
    // is a bad trade, and the events are not lost - they stay pending.
    if (remaining === 0) {
      return {
        ...base,
        publish: false,
        phase: 'cooldown',
        nextScanMs: scan,
        reason: `daily publish budget exhausted (${this.file.sessionsUsed}/${opts.maxPublishesPerDay}); ${pending} event(s) held for tomorrow`,
      };
    }

    const sinceLast = nowMs - this.file.lastPublishMs;
    if (this.file.lastPublishMs > 0 && sinceLast < opts.cooldownMs) {
      const waitMs = opts.cooldownMs - sinceLast;
      return {
        ...base,
        publish: false,
        phase: 'cooldown',
        nextScanMs: Math.min(scan, waitMs),
        reason: `cooling down for another ${Math.ceil(waitMs / 1000)}s; ${pending} event(s) accumulating`,
      };
    }

    return {
      ...base,
      publish: true,
      phase: 'alert',
      nextScanMs: opts.alertScanMs,
      reason: `publishing ${pending} event(s)`,
    };
  }

  /**
   * Record that a publish happened: spend a session, start the cooldown, clear
   * the backlog, and hold the fast scan interval open for the alert window so an
   * unfolding incident keeps being sampled at high resolution.
   */
  notePublished(nowMs: number, opts: CadenceOptions = DEFAULT_CADENCE): void {
    this.rollDayIfNeeded(nowMs);
    this.file.lastPublishMs = nowMs;
    this.file.sessionsUsed += 1;
    this.file.pendingEvents = 0;
    this.file.alertUntilMs = nowMs + opts.alertWindowMs;
    this.save();
  }

  /**
   * Record what is waiting after a deferred run. This SETS rather than adds, and
   * the distinction is load-bearing: a deferred run does not advance the cursors
   * (same rule `run.ts` applies to a failed publish), so the next scan re-reads
   * exactly the same lines. Accumulating would count every event once per scan
   * and report a backlog that grows on its own while nothing is happening.
   *
   * Nothing is dropped by this - the events are still on disk, unread, and the
   * next scan that is allowed to publish picks them all up.
   */
  noteDeferred(nowMs: number, pendingEvents: number): void {
    this.rollDayIfNeeded(nowMs);
    this.file.pendingEvents = pendingEvents;
    if (pendingEvents > 0) this.file.alertUntilMs = Math.max(this.file.alertUntilMs, nowMs);
    this.save();
  }

  get pendingEvents(): number {
    return this.file.pendingEvents;
  }

  get sessionsUsedToday(): number {
    return this.file.sessionsUsed;
  }

  get lastPublishMs(): number {
    return this.file.lastPublishMs;
  }

  private rollDayIfNeeded(nowMs: number): void {
    const day = utcDay(nowMs);
    if (this.file.sessionDayUtc !== day) {
      this.file.sessionDayUtc = day;
      this.file.sessionsUsed = 0;
    }
  }

  private save(): void {
    const path = join(this.dir, CADENCE_FILE);
    const tmp = `${path}.tmp`;
    // Same write-then-rename the cursor state uses: a run killed mid-write must
    // not leave a half-parsed budget behind, because "starting fresh" on the
    // session counter would hand back an allowance we already spent.
    writeFileSync(tmp, JSON.stringify(this.file), { mode: 0o600 });
    renameSync(tmp, path);
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
