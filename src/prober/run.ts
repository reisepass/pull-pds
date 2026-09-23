/**
 * One prober run, end to end: probe every configured endpoint, aggregate,
 * validate against the committed lexicon, publish once.
 *
 * RUN-ONCE, NOT A LOOP. There is no in-process scheduler. The OS runs this on a
 * systemd timer or a crontab line, which means no supervision code, no drift, no
 * "did the daemon wedge", and `systemctl start` / a manual invocation is exactly
 * what the timer does. The process holds no state between runs: each run is its
 * own aggregation window, so two overlapping runs cannot corrupt each other and
 * no lock file is needed (the file publisher's write is atomic).
 *
 * FAILURE IS DATA, MISCONFIGURATION IS NOT. A provider returning 503 is the
 * signal this daemon exists to collect: the run succeeds and exits 0. A missing
 * credential, an unreadable config, or a record that fails lexicon validation is
 * an operator problem: it is logged loudly and the run exits non-zero, so a
 * systemd timer marks the unit failed and somebody notices.
 */
import { log } from '../log.js';
import { buildRecordValidator, type RecordValidator } from '../pds-websub/lexicon-validate.js';
import type { ProberConfig, EndpointConfig } from './config.js';
import { resolveCredential, ProberConfigError } from './config.js';
import { probeEndpoint, guardedTransport, type ProbeTransport, type ProbeResult } from './probe.js';
import { aggregateEndpoint, type AggregateStats } from './aggregate.js';
import { createPublisher, type Publisher, type TelemetryRecord } from './publish.js';

/** Everything the run touches that a test needs to replace. */
export interface RunDeps {
  transport?: ProbeTransport;
  publisher?: Publisher;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /**
   * Per-record lexicon check. Defaults to the committed-lexicon validator the
   * ingest path uses, so a record this daemon emits is checked by exactly the
   * same rules that would reject it downstream - a bad record fails here, at
   * 03:00 in our own log, instead of silently at someone else's ingest.
   */
  validateRecord?: RecordValidator;
}

export interface EndpointSummary {
  rkey: string;
  provider: string;
  model?: string;
  stats: AggregateStats;
}

export interface RunSummary {
  /** Records handed to the publisher. */
  records: TelemetryRecord[];
  endpoints: EndpointSummary[];
  /** Endpoints skipped with the operator-facing reason (credential, validation). */
  skipped: { rkey: string; reason: string }[];
  publisher: string;
  destination: string;
  published: number;
  /** 0 = run healthy (provider failures included); 1 = operator must intervene. */
  exitCode: 0 | 1;
}

export async function runOnce(cfg: ProberConfig, deps: RunDeps = {}): Promise<RunSummary> {
  const transport = deps.transport ?? guardedTransport;
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => Date.now());
  const validate = deps.validateRecord ?? buildRecordValidator();
  const publisher =
    deps.publisher ?? createPublisher(cfg.publish, { publisherDid: cfg.publisherDid });

  const windowStartMs = now();
  const records: TelemetryRecord[] = [];
  const endpoints: EndpointSummary[] = [];
  const skipped: { rkey: string; reason: string }[] = [];

  for (const ep of cfg.endpoints) {
    let credential: string | undefined;
    try {
      credential = resolveCredential(ep, env);
    } catch (err) {
      // No key means no probe was made. Emitting a record here would publish a
      // clean bill of health for a provider we never contacted, so the endpoint
      // is skipped and the run is marked failed instead.
      const reason = err instanceof ProberConfigError ? err.message : String(err);
      log.error('prober endpoint skipped: credential unavailable', { rkey: ep.rkey, reason });
      skipped.push({ rkey: ep.rkey, reason });
      continue;
    }

    const results = await probeSeries(ep, credential, transport, cfg.allowLocalhost, now);
    const windowEndMs = now();
    const { record, stats } = aggregateEndpoint(ep, results, {
      windowStartMs,
      windowEndMs,
      distroName: cfg.distroName,
      ...(cfg.distroVersion === undefined ? {} : { distroVersion: cfg.distroVersion }),
    });

    const invalid = validate(record.collection, record.record);
    if (invalid) {
      log.error('prober record failed lexicon validation - not published', {
        rkey: ep.rkey,
        reason: invalid,
      });
      skipped.push({ rkey: ep.rkey, reason: `lexicon validation: ${invalid}` });
      continue;
    }

    // Latency has nowhere to go on the errorMetrics schema (see aggregate.ts),
    // so it is logged locally and nowhere else.
    log.info('prober endpoint probed', {
      rkey: ep.rkey,
      provider: ep.provider,
      ...(ep.model === undefined ? {} : { model: ep.model }),
      attempts: stats.attempts,
      ok: stats.ok,
      healthErrors: stats.healthErrors,
      unclassifiedErrors: stats.unclassifiedErrors,
      latenciesMs: stats.latenciesMs,
    });
    // Account-scoped codes were dropped before the record was built, so this
    // warning is the ONLY place an operator learns their key is dead.
    if (stats.accountErrors > 0) {
      log.warn(
        'prober saw account-scoped errors (auth/quota/billing) - dropped before signing, so the published record understates the failure. Check this endpoint\'s credential.',
        { rkey: ep.rkey, accountErrors: stats.accountErrors },
      );
    }

    records.push(record);
    endpoints.push({
      rkey: ep.rkey,
      provider: ep.provider,
      ...(ep.model === undefined ? {} : { model: ep.model }),
      stats,
    });
  }

  // Publish once, with every record: the feed is a complete snapshot, and a
  // partial one would delete the endpoints missing from it.
  let published = 0;
  let destination = 'none';
  if (records.length > 0) {
    const res = await publisher.publish(records);
    published = res.published;
    destination = res.destination;
  } else {
    log.error('prober produced no records - nothing published');
  }

  const summary: RunSummary = {
    records,
    endpoints,
    skipped,
    publisher: publisher.kind,
    destination,
    published,
    exitCode: skipped.length > 0 || records.length === 0 ? 1 : 0,
  };
  log.info('prober run complete', {
    endpoints: endpoints.length,
    skipped: skipped.length,
    published,
    destination,
    publisher: publisher.kind,
  });
  return summary;
}

/** Run an endpoint's probes sequentially so `attempts > 1` is not a burst. */
async function probeSeries(
  ep: EndpointConfig,
  credential: string | undefined,
  transport: ProbeTransport,
  allowLocalhost: boolean,
  now: () => number,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (let i = 0; i < ep.attempts; i++) {
    results.push(await probeEndpoint(ep, credential, transport, allowLocalhost, now));
  }
  return results;
}
