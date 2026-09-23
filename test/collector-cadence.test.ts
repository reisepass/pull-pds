import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CadenceState,
  DEFAULT_CADENCE,
  DEFAULT_MAX_PUBLISHES_PER_DAY,
  SESSION_CAP_PER_DAY,
  clampCadence,
  utcDay,
} from '../src/collector/cadence.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'cadence-'));
const T0 = Date.UTC(2026, 7, 3, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;

describe('cadence budget clamping', () => {
  it('refuses a publish allowance above the session cap', () => {
    const { options, adjustments } = clampCadence({ maxPublishesPerDay: 5_000 });
    expect(options.maxPublishesPerDay).toBe(DEFAULT_MAX_PUBLISHES_PER_DAY);
    expect(adjustments.join(' ')).toContain(String(SESSION_CAP_PER_DAY));
  });

  it('raises a cooldown that would breach the daily allowance', () => {
    // 5 minutes would be 288 publishes/day - the exact footgun this guards.
    const { options, adjustments } = clampCadence({ cooldownMs: 5 * MIN });
    const publishesPerDay = 86_400_000 / options.cooldownMs;
    expect(publishesPerDay).toBeLessThanOrEqual(options.maxPublishesPerDay);
    expect(adjustments.join(' ')).toContain('raised to');
  });

  it('reports every adjustment rather than silently overriding', () => {
    const { adjustments } = clampCadence({ maxPublishesPerDay: 9_999, cooldownMs: 1 });
    expect(adjustments.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves a conforming configuration untouched', () => {
    const { options, adjustments } = clampCadence({ cooldownMs: 2 * HOUR });
    expect(options.cooldownMs).toBe(2 * HOUR);
    expect(adjustments).toEqual([]);
  });
});

describe('cadence phases', () => {
  it('stays idle and does not publish when nothing is new', () => {
    const c = CadenceState.load(dir());
    const d = c.decide(T0, 0);
    expect(d.publish).toBe(false);
    expect(d.phase).toBe('idle');
    expect(d.nextScanMs).toBe(DEFAULT_CADENCE.idleScanMs);
  });

  it('publishes the first time new events appear', () => {
    const c = CadenceState.load(dir());
    const d = c.decide(T0, 3);
    expect(d.publish).toBe(true);
    expect(d.pending).toBe(3);
  });

  it('scans at the fast interval once errors are seen', () => {
    const c = CadenceState.load(dir());
    expect(c.decide(T0, 2).nextScanMs).toBe(DEFAULT_CADENCE.alertScanMs);
  });

  it('refuses to publish again during cooldown', () => {
    const d0 = dir();
    const c = CadenceState.load(d0);
    c.decide(T0, 2);
    c.notePublished(T0);

    const d = CadenceState.load(d0).decide(T0 + 10 * MIN, 1);
    expect(d.publish).toBe(false);
    expect(d.phase).toBe('cooldown');
    expect(d.reason).toContain('cooling down');
  });

  it('publishes the whole backlog once cooldown expires', () => {
    const d0 = dir();
    const c = CadenceState.load(d0);
    c.notePublished(T0);
    // A deferred run does not advance the cursors, so each rescan re-reads the
    // same lines plus whatever is new: the counts are snapshots, not increments.
    c.noteDeferred(T0 + 5 * MIN, 4);
    c.noteDeferred(T0 + 20 * MIN, 7);

    const after = CadenceState.load(d0).decide(T0 + HOUR + MIN, 8);
    expect(after.publish).toBe(true);
    expect(after.pending).toBe(8);
  });

  it('does not inflate the backlog by re-counting rescanned events', () => {
    const d0 = dir();
    const c = CadenceState.load(d0);
    c.notePublished(T0);
    c.noteDeferred(T0 + 5 * MIN, 4);
    c.noteDeferred(T0 + 10 * MIN, 4);
    c.noteDeferred(T0 + 15 * MIN, 4);
    // Three scans of the same four unread errors is four, not twelve.
    expect(CadenceState.load(d0).pendingEvents).toBe(4);
  });

  it('never drops events found during cooldown', () => {
    const d0 = dir();
    const c = CadenceState.load(d0);
    c.notePublished(T0);
    c.noteDeferred(T0 + MIN, 5);
    expect(CadenceState.load(d0).pendingEvents).toBe(5);
  });

  it('clears the backlog after publishing it', () => {
    const d0 = dir();
    const c = CadenceState.load(d0);
    c.noteDeferred(T0, 9);
    c.notePublished(T0 + HOUR);
    expect(CadenceState.load(d0).pendingEvents).toBe(0);
  });
});

describe('session budget', () => {
  it('stops publishing once the daily allowance is spent', () => {
    const d0 = dir();
    const opts = { ...DEFAULT_CADENCE, maxPublishesPerDay: 2, cooldownMs: MIN };
    const c = CadenceState.load(d0);
    c.notePublished(T0, opts);
    c.notePublished(T0 + 2 * MIN, opts);

    const d = c.decide(T0 + 10 * MIN, 1, opts);
    expect(d.publish).toBe(false);
    expect(d.sessionsRemainingToday).toBe(0);
    expect(d.reason).toContain('budget exhausted');
  });

  it('holds the events rather than discarding them when out of budget', () => {
    const opts = { ...DEFAULT_CADENCE, maxPublishesPerDay: 1, cooldownMs: MIN };
    const c = CadenceState.load(dir());
    c.notePublished(T0, opts);
    const d = c.decide(T0 + 5 * MIN, 7, opts);
    expect(d.publish).toBe(false);
    expect(d.pending).toBe(7);
  });

  it('resets the counter on the UTC day boundary', () => {
    const d0 = dir();
    const opts = { ...DEFAULT_CADENCE, maxPublishesPerDay: 1, cooldownMs: MIN };
    const c = CadenceState.load(d0);
    c.notePublished(T0, opts);
    expect(c.decide(T0 + 5 * MIN, 1, opts).publish).toBe(false);

    const nextDay = Date.UTC(2026, 7, 4, 0, 30, 0);
    expect(c.decide(nextDay, 1, opts).publish).toBe(true);
  });

  it('counts the day in UTC, not local time', () => {
    expect(utcDay(Date.UTC(2026, 7, 3, 23, 59, 0))).toBe('2026-08-03');
    expect(utcDay(Date.UTC(2026, 7, 4, 0, 1, 0))).toBe('2026-08-04');
  });

  it('survives a restart without handing back a spent allowance', () => {
    const d0 = dir();
    const opts = { ...DEFAULT_CADENCE, maxPublishesPerDay: 3, cooldownMs: MIN };
    CadenceState.load(d0).notePublished(T0, opts);
    CadenceState.load(d0).notePublished(T0 + 2 * MIN, opts);
    expect(CadenceState.load(d0).sessionsUsedToday).toBe(2);
  });

  it('keeps the default worst case far under the remote cap', () => {
    const perDay = 86_400_000 / DEFAULT_CADENCE.cooldownMs;
    expect(perDay).toBeLessThanOrEqual(DEFAULT_CADENCE.maxPublishesPerDay);
    expect(perDay).toBeLessThan(SESSION_CAP_PER_DAY / 4);
  });
});
