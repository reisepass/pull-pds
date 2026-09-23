import http from 'node:http';
import { IndexStore, type IndexedRecord } from './index-store.js';
import type { Indexer } from './indexer.js';
import { renderAppView } from './views.js';
import type { GlobalStore } from '../globalindex/store.js';
import type { GlobalIndexer } from '../globalindex/indexer.js';
import { ERROR_METRICS_COLLECTIONS, USAGE_METRICS_COLLECTIONS } from '../collections.js';

export interface GlobalDeps {
  store: GlobalStore;
  indexer: GlobalIndexer;
}

/**
 * The AppView HTTP surface (PHASE-3 B3). Query API + server-rendered HTML views.
 * Same display rules as the PDS UI: every view a bookmarkable GET, identifiers
 * never truncated, red only for real failures, and every row shows which PDS +
 * publisher DID it came from and whether its signature verified.
 *
 * `global` (FIREHOSE-INDEXER-TASK) wires in the bsky.network global-firehose
 * index so /firehose-global can serve the round-trip aggregation.
 */
export function createAppViewServer(store: IndexStore, indexer: Indexer, hosts: string[], global?: GlobalDeps): http.Server {
  return http.createServer((req, res) => {
    handle(store, indexer, hosts, global, req, res).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'InternalServerError', message: (err as Error).message }));
    });
  });
}

async function handle(
  store: IndexStore,
  indexer: Indexer,
  hosts: string[],
  global: GlobalDeps | undefined,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  // JSON API
  if (path === '/health') {
    return json(res, 200, health(store, hosts));
  }
  if (path === '/api/records') {
    return json(res, 200, store.allRecords());
  }
  if (path === '/api/aggregate') {
    return json(res, 200, aggregateByProvider(store));
  }
  if (path === '/api/global/aggregate' && global) {
    return json(res, 200, globalAggregate(global.store));
  }
  if (path === '/api/global/events' && global) {
    return json(res, 200, global.store.recentEvents(500));
  }
  if (path === '/api/global/health' && global) {
    return json(res, 200, { ...global.indexer.status(), ...globalHealth(global.store) });
  }
  if (path === '/api/global/latency' && global) {
    const since = url.searchParams.get('since') ?? undefined;
    return json(res, 200, globalLatency(global.store, since));
  }

  // HTML views (delegated to views.ts)
  if (req.method === 'GET') {
    const html = await renderAppView(store, hosts, path, url.searchParams, global);
    if (html) {
      res.writeHead(html.status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html.body);
      return;
    }
  }

  json(res, 404, { error: 'NotFound' });
}

export function health(store: IndexStore, hosts: string[]): Record<string, unknown> {
  return {
    status: 'ok',
    pdsHosts: hosts,
    cursors: Object.fromEntries(hosts.map((h) => [h, store.getCursor(h)])),
    indexedRecords: store.recordCount(),
    distinctPublishers: store.distinctDids().length,
    commitsIndexed: store.getStat('commits_indexed'),
    commitsRejected: store.getStat('commits_rejected'),
  };
}

// --- aggregation ----------------------------------------------------------

export interface ErrorCodeCount {
  code: string;
  count: number;
}

/**
 * Read the specific provider error-code breakdown out of a statusReport record
 * (REDESIGN-TASK §1). The canonical shape is `errors: [{code, count}]` +
 * `totalErrors`; a legacy `count429` field (pre-redesign records) is folded in
 * as a 429 code so old rows still render honestly.
 */
export function parseErrorCodes(v: Record<string, unknown>): ErrorCodeCount[] {
  const out: ErrorCodeCount[] = [];
  if (Array.isArray(v.errors)) {
    for (const e of v.errors) {
      if (e && typeof e === 'object') {
        const code = String((e as Record<string, unknown>).code ?? '');
        const count = Number((e as Record<string, unknown>).count ?? 0);
        if (code && Number.isFinite(count) && count > 0) out.push({ code, count });
      }
    }
  }
  const legacy429 = Number(v.count429 ?? 0);
  if (legacy429 > 0 && !out.some((e) => e.code === '429')) out.push({ code: '429', count: legacy429 });
  out.sort((a, b) => b.count - a.count);
  return out;
}

/** Total errors for a record: `totalErrors` if present, else the code sum. */
export function totalErrorsOf(v: Record<string, unknown>, codes: ErrorCodeCount[]): number {
  const t = Number(v.totalErrors ?? NaN);
  if (Number.isFinite(t) && t >= 0) return t;
  return codes.reduce((a, b) => a + b.count, 0);
}

export interface ProviderRow {
  did: string;
  sourcePds: string;
  /** Kind of digital service provider (open vocab). Empty for legacy records. */
  serviceType: string;
  provider: string;
  model: string;
  errors: ErrorCodeCount[];
  totalErrors: number;
  /**
   * Coarse order-of-magnitude request-volume bucket (new schema). Empty string
   * for legacy records that never carried a denominator. NEVER an exact count.
   */
  requestVolumeBucket: string;
  /** Exact denominator (new schema). 0 when only the coarse bucket was signed. */
  requestCount: number;
  /** Emitting software (new schema, telemetry.distro.name). Empty for legacy records. */
  emitter: string;
  observedAt: string;
  rkey: string;
  collection: string;
  cid: string;
  rev: string;
  sigVerified: boolean;
}

/**
 * Read the provider name from either schema: the new OTel field
 * `gen_ai.provider.name`, or the legacy `provider`. Dual-read: pre-rename
 * records signed under `app.omniroute.errorReport` carry the legacy names in
 * immutable bytes forever, so both must render.
 */
function providerOf(v: Record<string, unknown>): string {
  return String(v['gen_ai.provider.name'] ?? v.provider ?? '?');
}

/** Model from either schema: new `gen_ai.request.model`, or legacy `model`. */
function modelOf(v: Record<string, unknown>): string {
  return String(v['gen_ai.request.model'] ?? v.model ?? '?');
}

/**
 * Flatten every indexed error-metrics record into a provider row, spanning both
 * dual-read NSIDs (current `org.llmtelemetry.errorMetrics` and legacy
 * `app.omniroute.errorReport`). Field names are mapped per-record so old and
 * new shapes both render.
 */
export function providerRows(store: IndexStore): ProviderRow[] {
  const out: ProviderRow[] = [];
  for (const collection of ERROR_METRICS_COLLECTIONS) {
    for (const r of store.recordsForCollection(collection)) {
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(r.recordJson) as Record<string, unknown>;
      } catch {
        continue;
      }
      const errors = parseErrorCodes(v);
      out.push({
        did: r.did,
        sourcePds: r.sourcePds,
        serviceType: String(v.serviceType ?? ''),
        provider: providerOf(v),
        model: modelOf(v),
        errors,
        totalErrors: totalErrorsOf(v, errors),
        requestVolumeBucket: String(v.requestVolumeBucket ?? ''),
        requestCount: Number(v.requestCount ?? 0),
        emitter: String(v['telemetry.distro.name'] ?? ''),
        observedAt: String(v.observedAt ?? ''),
        rkey: r.rkey,
        collection: r.collection,
        cid: r.cid,
        rev: r.rev,
        sigVerified: r.sigVerified,
      });
    }
  }
  return out;
}

/**
 * A single indexed usage-metrics record (org.llmtelemetry.usageMetrics). Usage
 * is a separate opt-in signal from errors; these rows are self-reported, so
 * `did` (who claimed it) and `sigVerified` are load-bearing - see the sybil
 * discussion in USAGE-STATS.md.
 */
export interface UsageRow {
  did: string;
  sourcePds: string;
  /** Kind of digital service provider (open vocab). Empty for records without it. */
  serviceType: string;
  provider: string;
  model: string;
  operationCount: number;
  inputTokens: number;
  outputTokens: number;
  latencyMsP50: number | null;
  latencyMsP90: number | null;
  latencyMsP99: number | null;
  emitter: string;
  kAnonRare: boolean;
  observedAt: string;
  rkey: string;
  collection: string;
  cid: string;
  rev: string;
  sigVerified: boolean;
}

function numOrNull(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

/**
 * Flatten every indexed usage-metrics record. Optionally restrict to a publisher
 * subset (`onlyDids`) - the sybil defense is that a consumer chooses WHOSE
 * numbers to count; there is no canonical ranking (USAGE-STATS §2).
 */
export function usageRows(store: IndexStore, onlyDids?: ReadonlySet<string>): UsageRow[] {
  const out: UsageRow[] = [];
  for (const collection of USAGE_METRICS_COLLECTIONS) {
    for (const r of store.recordsForCollection(collection)) {
      if (onlyDids && !onlyDids.has(r.did)) continue;
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(r.recordJson) as Record<string, unknown>;
      } catch {
        continue;
      }
      out.push({
        did: r.did,
        sourcePds: r.sourcePds,
        serviceType: String(v.serviceType ?? ''),
        provider: providerOf(v),
        model: modelOf(v),
        operationCount: Number(v.operationCount ?? 0),
        inputTokens: Number(v['gen_ai.usage.input_tokens'] ?? 0),
        outputTokens: Number(v['gen_ai.usage.output_tokens'] ?? 0),
        latencyMsP50: numOrNull(v.latencyMsP50),
        latencyMsP90: numOrNull(v.latencyMsP90),
        latencyMsP99: numOrNull(v.latencyMsP99),
        emitter: String(v['telemetry.distro.name'] ?? ''),
        kAnonRare: v.kAnonRare === true,
        observedAt: String(v.observedAt ?? ''),
        rkey: r.rkey,
        collection: r.collection,
        cid: r.cid,
        rev: r.rev,
        sigVerified: r.sigVerified,
      });
    }
  }
  return out;
}

/**
 * A usage ranking across an EXPLICIT, ATTESTED publisher set. There is never a
 * single canonical ranking (USAGE-STATS §2): the publisher set is always part of
 * the output so the aggregate is auditable, and only signature-verified records
 * from the chosen publishers are counted.
 */
export interface UsageRanking {
  /** model -> summed operation/token counts across the counted publishers. */
  rows: UsageAgg[];
  /** The exact publishers whose (verified) numbers were counted. Always emitted. */
  publishers: string[];
  /** How many records were skipped because their signature did not verify. */
  unverifiedSkipped: number;
}

export interface UsageAgg {
  provider: string;
  model: string;
  operationCount: number;
  inputTokens: number;
  outputTokens: number;
  /** Distinct publishers who reported this (provider, model). */
  publishers: number;
  /** True if only one publisher reported it (k-anonymity / sybil caution). */
  singleSource: boolean;
}

/**
 * Rank usage across a chosen publisher subset. Counts ONLY signature-verified
 * records (a self-reported number that does not even verify against its claimed
 * key is worthless). Emits the publisher set and the count of skipped
 * unverified records alongside the ranking.
 */
export function rankUsage(store: IndexStore, onlyDids?: ReadonlySet<string>): UsageRanking {
  const rows = usageRows(store, onlyDids);
  const byModel = new Map<string, UsageAgg & { dids: Set<string> }>();
  const publishers = new Set<string>();
  let unverifiedSkipped = 0;
  for (const r of rows) {
    if (!r.sigVerified) {
      unverifiedSkipped++;
      continue;
    }
    publishers.add(r.did);
    const key = `${r.provider}\0${r.model}`;
    let agg = byModel.get(key);
    if (!agg) {
      agg = {
        provider: r.provider,
        model: r.model,
        operationCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        publishers: 0,
        singleSource: true,
        dids: new Set<string>(),
      };
      byModel.set(key, agg);
    }
    agg.operationCount += r.operationCount;
    agg.inputTokens += r.inputTokens;
    agg.outputTokens += r.outputTokens;
    agg.dids.add(r.did);
  }
  const out: UsageAgg[] = [...byModel.values()]
    .map((a) => ({
      provider: a.provider,
      model: a.model,
      operationCount: a.operationCount,
      inputTokens: a.inputTokens,
      outputTokens: a.outputTokens,
      publishers: a.dids.size,
      singleSource: a.dids.size <= 1,
    }))
    .sort((x, y) => y.operationCount - x.operationCount);
  return { rows: out, publishers: [...publishers].sort(), unverifiedSkipped };
}

export interface ProviderAgg {
  provider: string;
  reports: number;
  totalErrors: number;
  maxErrors: number;
  /** code -> summed count across every publisher's report. */
  codes: ErrorCodeCount[];
  publishers: number;
}

export function aggregateByProvider(store: IndexStore): ProviderAgg[] {
  const rows = providerRows(store);
  const byProvider = new Map<string, ProviderRow[]>();
  for (const r of rows) {
    const list = byProvider.get(r.provider) ?? [];
    list.push(r);
    byProvider.set(r.provider, list);
  }
  const out: ProviderAgg[] = [];
  for (const [provider, list] of byProvider) {
    const codeTotals = new Map<string, number>();
    for (const r of list) for (const e of r.errors) codeTotals.set(e.code, (codeTotals.get(e.code) ?? 0) + e.count);
    out.push({
      provider,
      reports: list.length,
      totalErrors: list.reduce((a, b) => a + b.totalErrors, 0),
      maxErrors: list.reduce((a, b) => Math.max(a, b.totalErrors), 0),
      codes: [...codeTotals.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
      publishers: new Set(list.map((r) => r.did)).size,
    });
  }
  out.sort((a, b) => b.totalErrors - a.totalErrors);
  return out;
}

/**
 * Providers where publishers report materially DIFFERENT error-code profiles
 * (B3, error-code redesign): different dominant codes or a >2x spread in total
 * errors. No single source of truth; every row is signature-verified.
 */
export interface Disagreement {
  provider: string;
  states: Array<{ state: string; publishers: string[] }>;
  rows: ProviderRow[];
}

/** A compact comparable profile string, e.g. "429×150 529×29" (top 3 codes). */
export function errorProfile(r: { errors: ErrorCodeCount[]; totalErrors: number }): string {
  if (r.errors.length === 0) return 'no-errors';
  return r.errors
    .slice(0, 3)
    .map((e) => `${e.code}×${e.count}`)
    .join(' ');
}

export function disagreements(store: IndexStore): Disagreement[] {
  const rows = providerRows(store);
  const byProvider = new Map<string, ProviderRow[]>();
  for (const r of rows) {
    const list = byProvider.get(r.provider) ?? [];
    list.push(r);
    byProvider.set(r.provider, list);
  }
  const out: Disagreement[] = [];
  for (const [provider, list] of byProvider) {
    if (list.length < 2) continue;
    const profiles = new Map<string, string[]>();
    const totals = list.map((r) => r.totalErrors);
    const maxT = Math.max(...totals);
    const minT = Math.min(...totals);
    // Disagreement = distinct dominant code, or a >2x spread in total errors.
    const dominant = new Set(list.map((r) => r.errors[0]?.code ?? 'none'));
    const spread = maxT > 0 && maxT > 2 * Math.max(minT, 1);
    if (dominant.size <= 1 && !spread) continue;
    for (const r of list) {
      const p = errorProfile(r);
      const pubs = profiles.get(p) ?? [];
      pubs.push(r.did);
      profiles.set(p, pubs);
    }
    out.push({
      provider,
      states: [...profiles.entries()].map(([state, publishers]) => ({ state, publishers })),
      rows: list,
    });
  }
  return out;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

// --- global-firehose aggregation (FIREHOSE-INDEXER-TASK) --------------------

export interface GlobalProviderRow {
  provider: string;
  model: string;
  errors: ErrorCodeCount[];
  totalErrors: number;
  observedAt: string;
  did: string;
  collection: string;
  rkey: string;
  seq: number;
  commitCid: string;
  opCid: string | null;
  rev: string;
  sigOk: boolean;
  frameTime: string;
  indexedAt: string;
}

/** Latest record per (did, collection, rkey) as seen on the GLOBAL firehose. */
export function globalProviderRows(store: GlobalStore): GlobalProviderRow[] {
  const out: GlobalProviderRow[] = [];
  for (const r of store.latestRecords()) {
    let v: Record<string, unknown> = {};
    if (r.recordJson) {
      try {
        v = JSON.parse(r.recordJson) as Record<string, unknown>;
      } catch {
        continue;
      }
    }
    const errors = parseErrorCodes(v);
    out.push({
      provider: providerOf(v),
      model: modelOf(v),
      errors,
      totalErrors: totalErrorsOf(v, errors),
      observedAt: String(v.observedAt ?? ''),
      did: r.did,
      collection: r.collection,
      rkey: r.rkey,
      seq: r.seq,
      commitCid: r.commitCid,
      opCid: r.opCid,
      rev: r.rev,
      sigOk: r.sigOk,
      frameTime: r.frameTime,
      indexedAt: r.indexedAt,
    });
  }
  return out;
}

export interface GlobalProviderAgg {
  provider: string;
  reports: number;
  totalErrors: number;
  maxErrors: number;
  codes: ErrorCodeCount[];
  publishers: number;
  latestSeq: number;
  latestObservedAt: string;
}

export function globalAggregate(store: GlobalStore): GlobalProviderAgg[] {
  const rows = globalProviderRows(store);
  const byProvider = new Map<string, GlobalProviderRow[]>();
  for (const r of rows) {
    const list = byProvider.get(r.provider) ?? [];
    list.push(r);
    byProvider.set(r.provider, list);
  }
  const out: GlobalProviderAgg[] = [];
  for (const [provider, list] of byProvider) {
    const codeTotals = new Map<string, number>();
    for (const r of list) for (const e of r.errors) codeTotals.set(e.code, (codeTotals.get(e.code) ?? 0) + e.count);
    out.push({
      provider,
      reports: list.length,
      totalErrors: list.reduce((a, b) => a + b.totalErrors, 0),
      maxErrors: list.reduce((a, b) => Math.max(a, b.totalErrors), 0),
      codes: [...codeTotals.entries()].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
      publishers: new Set(list.map((r) => r.did)).size,
      latestSeq: list.reduce((a, b) => Math.max(a, b.seq), 0),
      latestObservedAt: list.reduce((a, b) => (b.observedAt > a ? b.observedAt : a), ''),
    });
  }
  out.sort((a, b) => b.totalErrors - a.totalErrors);
  return out;
}

function globalHealth(store: GlobalStore): Record<string, unknown> {
  return {
    eventsIndexed: store.eventCount(),
    latestRecords: store.latestRecords().length,
    distinctPublishers: store.distinctDids().length,
    recordsIndexed: store.getStat('records_indexed'),
    commitsRejected: store.getStat('commits_rejected'),
  };
}

/**
 * In-band global round-trip latency (GLOBAL-LATENCY-FIX.md). Two distributions
 * over records carrying the signed correlation fields, percentiles never means:
 *   - relayDelayMs   = frame_time - emittedAt   (publisher -> relay, relay stamp)
 *   - arrivalDelayMs = arrived_at - emittedAt   (publisher -> relay -> THIS consumer,
 *                                                live wall clock at socket receipt)
 * `indexed_at` is never used: it is inflated during catch-up replay. Only LIVE
 * frames (arrived within 60s of the relay stamp) count toward arrivalDelayMs;
 * replayed/backfill rows are reported separately, loudly.
 */
export interface LatencyDist {
  n: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  max: number | null;
}

function dist(values: number[]): LatencyDist {
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number): number | null =>
    sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? null;
  return {
    n: sorted.length,
    p50: pick(50),
    p90: pick(90),
    p99: pick(99),
    max: sorted.length ? (sorted[sorted.length - 1] ?? null) : null,
  };
}

export function globalLatency(
  store: GlobalStore,
  since?: string,
): {
  relayDelayMs: LatencyDist;
  arrivalDelayMs: LatencyDist;
  total: number;
  live: number;
  backfilled: number;
  distinctPublishers: number;
  since: string | null;
  currentLag: {
    lagMs: number;
    emittedAt: string;
    arrivedAt: string;
    measuredAt: string;
  } | null;
} {
  const samples = store.latencySamples(60_000, since);
  const liveSamples = samples.filter((s) => s.live && s.arrivalDelayMs != null);

  // TRUE current lag (unwindowed, always shown even under ?since=): how far
  // behind wall-clock the freshest correlation-carrying sample actually is
  // (now - its emittedAt). The live-only arrival distribution above
  // structurally excludes replay, so it can never show this — when the
  // consumer is minutes behind, the freshest data it has processed is old,
  // and this number is the honest "how stale is this consumer right now".
  let currentLag: {
    lagMs: number;
    emittedAt: string;
    arrivedAt: string;
    measuredAt: string;
  } | null = null;
  const freshest = store.freshestCorrelationSample();
  if (freshest) {
    const emitted = Date.parse(freshest.emittedAt);
    if (!Number.isNaN(emitted)) {
      currentLag = {
        lagMs: Date.now() - emitted,
        emittedAt: freshest.emittedAt,
        arrivedAt: freshest.arrivedAt,
        measuredAt: new Date().toISOString(),
      };
    }
  }

  return {
    relayDelayMs: dist(samples.map((s) => s.relayDelayMs)),
    arrivalDelayMs: dist(liveSamples.map((s) => s.arrivalDelayMs as number)),
    total: samples.length,
    live: liveSamples.length,
    backfilled: samples.length - liveSamples.length,
    distinctPublishers: new Set(samples.map((s) => s.did)).size,
    since: since ?? null,
    currentLag,
  };
}

export type { IndexedRecord };
