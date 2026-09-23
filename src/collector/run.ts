/**
 * One collector run, end to end: take the lock, scan each installed CLI's logs
 * from its cursor, collapse bursts, aggregate per (provider, model), validate
 * against the committed lexicon, publish once, save the cursors.
 *
 * RUN-ONCE, NOT A LOOP, for the same reasons as the prober: the OS schedules it
 * (launchd on macOS, a systemd timer or crontab line elsewhere), so there is no
 * supervision code, no drift, and running it by hand does exactly what the timer
 * does. Unlike the prober this one DOES hold state between runs - the file
 * cursors - which is why it also holds a lock.
 *
 * ORDER MATTERS: CURSORS ARE SAVED ONLY AFTER A SUCCESSFUL PUBLISH. If the
 * publish fails, the cursors are left where they were and the next run re-reads
 * the same lines. That re-reads some data rather than losing it, which is the
 * right direction for a telemetry collector - and the aggregate is per-window,
 * so a repeated window is a repeated `putRecord` on the same rkey, which is an
 * idempotent update rather than a duplicate.
 *
 * FAILURE IS DATA, MISCONFIGURATION IS NOT. Providers erroring is the signal
 * this exists to collect: exit 0. A bad config, a missing credential, or a
 * record that fails lexicon validation is an operator problem: logged loudly,
 * exit 1, so launchd or systemd reports the unit failed.
 */
import { homedir } from 'node:os';
import { log } from '../log.js';
import { buildRecordValidator, type RecordValidator } from '../pds-websub/lexicon-validate.js';
import { createPublisher, type Publisher, type TelemetryRecord } from '../prober/publish.js';
import { CadenceState, clampCadence, type CadenceOptions } from './cadence.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';
import { codexAdapter } from './adapters/codex.js';
import { agyAdapter } from './adapters/agy.js';
import { aggregateEvents, type GroupStats } from './aggregate.js';
import { dedupeBursts } from './dedupe.js';
import { CollectorState } from './state.js';
import type { CollectorConfig } from './config.js';
import type { AttemptCount, ErrorEvent, SourceAdapter } from './types.js';

/** Every adapter this build ships, keyed by the id used in config. */
export const ADAPTERS: Record<string, SourceAdapter> = {
  [claudeCodeAdapter.id]: claudeCodeAdapter,
  [codexAdapter.id]: codexAdapter,
  [agyAdapter.id]: agyAdapter,
};

export interface CollectorRunDeps {
  publisher?: Publisher;
  now?: () => number;
  home?: string;
  adapters?: Record<string, SourceAdapter>;
  /**
   * Per-record lexicon check. Defaults to the committed-lexicon validator the
   * ingest path uses. The PDS does not validate custom lexicons - it stores them
   * with `validationStatus: "unknown"` - so this is the ONLY thing standing
   * between a malformed record and a permanent signed commit.
   */
  validateRecord?: RecordValidator;
  /** Injected for tests; loaded from the state dir otherwise. */
  cadence?: CadenceState;
}

export interface SourceSummary {
  id: string;
  detected: boolean;
  events: number;
  sourcesScanned: number;
  bytesScanned: number;
  warnings: string[];
}

export interface CollectorRunSummary {
  sources: SourceSummary[];
  /** Errors seen before burst collapsing. */
  rawEvents: number;
  collapsed: number;
  records: TelemetryRecord[];
  stats: GroupStats[];
  /** Groups withheld for having no observed denominator. */
  withheld: GroupStats[];
  /** Records that failed lexicon validation and were not published. */
  invalid: { rkey: string; reason: string }[];
  publisher: string;
  destination: string;
  published: number;
  /** True when another run held the lock and this one did nothing. */
  skippedLocked: boolean;
  exitCode: 0 | 1;
}

export async function runOnce(
  cfg: CollectorConfig,
  deps: CollectorRunDeps = {},
): Promise<CollectorRunSummary> {
  const now = deps.now ?? (() => Date.now());
  const home = deps.home ?? homedir();
  const adapters = deps.adapters ?? ADAPTERS;
  const validate = deps.validateRecord ?? buildRecordValidator();

  const state = CollectorState.load(cfg.stateDir);
  const empty = (skippedLocked: boolean): CollectorRunSummary => ({
    sources: [],
    rawEvents: 0,
    collapsed: 0,
    records: [],
    stats: [],
    withheld: [],
    invalid: [],
    publisher: 'none',
    destination: 'none',
    published: 0,
    skippedLocked,
    exitCode: 0,
  });

  if (!state.acquireLock(now())) {
    // Not a failure. The previous run is still scanning; two runs consuming the
    // same cursors would double-count every line between them.
    log.info('collector run skipped - another run holds the lock', { stateDir: cfg.stateDir });
    return empty(true);
  }

  try {
    const windowEndMs = now();
    // A first run has no previous window, so it looks back a bounded distance
    // rather than publishing months of history as if it had just happened.
    const windowStartMs =
      state.lastRunEndMs > 0 ? state.lastRunEndMs : windowEndMs - cfg.backfillMs;

    const events: ErrorEvent[] = [];
    const attempts: AttemptCount[] = [];
    const sources: SourceSummary[] = [];

    for (const sc of cfg.sources) {
      if (!sc.enabled) continue;
      const adapter = adapters[sc.id];
      if (adapter === undefined) {
        log.warn('collector skipping an unknown source', { id: sc.id });
        continue;
      }
      const root = sc.root ?? adapter.defaultRoot(home);
      if (!adapter.detect(root)) {
        // Not installed. Normal on any machine that does not run all three.
        sources.push({
          id: sc.id,
          detected: false,
          events: 0,
          sourcesScanned: 0,
          bytesScanned: 0,
          warnings: [],
        });
        continue;
      }
      const obs = await adapter.collect({
        root,
        cursors: state,
        now,
        minTimestampMs: windowStartMs,
      });
      events.push(...obs.events);
      attempts.push(...obs.attempts);
      sources.push({
        id: sc.id,
        detected: true,
        events: obs.events.length,
        sourcesScanned: obs.sourcesScanned,
        bytesScanned: obs.bytesScanned,
        warnings: obs.warnings,
      });
      for (const w of obs.warnings) log.warn('collector source warning', { id: sc.id, warning: w });
      log.info('collector scanned a source', {
        id: sc.id,
        files: obs.sourcesScanned,
        bytes: obs.bytesScanned,
        errors: obs.events.length,
        // The denominator, summed. Never per-project, never per-session.
        successes: obs.attempts.reduce((n, a) => n + a.successes, 0),
      });
    }

    const { events: deduped, collapsed } = dedupeBursts(events, cfg.dedupeWindowMs);
    const { records, stats, withheld } = aggregateEvents(deduped, attempts, {
      windowStartMs,
      windowEndMs,
      distroName: cfg.distroName,
      ...(cfg.distroVersion === undefined ? {} : { distroVersion: cfg.distroVersion }),
      serviceType: cfg.serviceType,
      publishWithoutSuccesses: cfg.publishWithoutSuccesses,
    });

    for (const s of stats) {
      log.info('collector aggregated a provider/model group', {
        provider: s.provider,
        model: s.model,
        healthErrors: s.healthErrors,
        unclassifiedErrors: s.unclassifiedErrors,
        sources: s.sources,
      });
      // Account-scoped codes were dropped before the record was built, so this
      // is the ONLY place an operator learns their credential is dead.
      if (s.accountErrors > 0) {
        log.warn(
          'collector saw account-scoped errors (auth/quota/billing) - dropped before signing, so the published record understates the failure. Check that CLI\'s credentials.',
          { provider: s.provider, model: s.model, accountErrors: s.accountErrors },
        );
      }
    }
    for (const w of withheld) {
      log.warn(
        'collector withheld a group - the source recorded errors but no successful requests, so any published rate would read as ~100%. Set publishWithoutSuccesses if that source really does log every request.',
        { provider: w.provider, model: w.model, errors: w.healthErrors + w.unclassifiedErrors, sources: w.sources },
      );
    }

    const valid: TelemetryRecord[] = [];
    const invalid: { rkey: string; reason: string }[] = [];
    for (const r of records) {
      const reason = validate(r.collection, r.record);
      if (reason === null) valid.push(r);
      else {
        log.error('collector record failed lexicon validation - not published', {
          rkey: r.rkey,
          reason,
        });
        invalid.push({ rkey: r.rkey, reason });
      }
    }

    let published = 0;
    let destination = 'none';
    let publisherKind = 'none';

    // Scanning is free; publishing spends one of a capped 300 sessions/day. The
    // cadence decides whether this run has earned one.
    const cadenceState = deps.cadence ?? CadenceState.load(cfg.stateDir);
    const { options: cadenceOpts, adjustments } = clampCadence(cfg.cadence);
    for (const adjustment of adjustments) {
      log.warn('collector cadence setting overridden to stay inside the session budget', {
        adjustment,
      });
    }
    const decision = cadenceState.decide(windowEndMs, valid.length, cadenceOpts);

    if (valid.length > 0 && decision.publish) {
      const publisher =
        deps.publisher ?? createPublisher(cfg.publish, { publisherDid: cfg.publisherDid });
      publisherKind = publisher.kind;
      const res = await publisher.publish(valid);
      published = res.published;
      destination = res.destination;
      cadenceState.notePublished(windowEndMs, cadenceOpts);
    } else if (valid.length > 0) {
      // Deferred, not dropped. The cursors below are NOT advanced, so the next
      // run re-reads these same lines and publishes them together with whatever
      // has arrived meanwhile.
      publisherKind = deps.publisher?.kind ?? cfg.publish.kind;
      cadenceState.noteDeferred(windowEndMs, valid.length);
      log.info('collector holding records - cadence deferred this publish', {
        reason: decision.reason,
        phase: decision.phase,
        pending: decision.pending,
        sessionsUsedToday: decision.sessionsUsedToday,
        sessionsRemainingToday: decision.sessionsRemainingToday,
        nextScanMs: decision.nextScanMs,
      });
    } else {
      log.info('collector produced no records this window - nothing published');
      publisherKind = deps.publisher?.kind ?? cfg.publish.kind;
    }

    // Only now, and only when this run actually published. A failed publish
    // throws; a DEFERRED one must leave the cursors alone for the same reason -
    // advancing them would consume the lines without ever emitting them.
    if (published > 0 || valid.length === 0) {
      state.lastRunEndMs = windowEndMs;
      state.save(windowEndMs);
    }

    const summary: CollectorRunSummary = {
      sources,
      rawEvents: events.length,
      collapsed,
      records: valid,
      stats,
      withheld,
      invalid,
      publisher: publisherKind,
      destination,
      published,
      skippedLocked: false,
      exitCode: invalid.length > 0 ? 1 : 0,
    };
    log.info('collector run complete', {
      sources: sources.filter((s) => s.detected).map((s) => s.id),
      rawEvents: events.length,
      collapsed,
      records: valid.length,
      withheld: withheld.length,
      published,
      destination,
      cursors: state.cursorCount,
    });
    return summary;
  } finally {
    state.releaseLock();
  }
}
