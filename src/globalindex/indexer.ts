import { guardedFetch, GuardedFetchError } from '../net/guarded-fetch.js';
import { WebSocket } from 'ws';
import { readCarWithRoot, verifyRecords, MemoryBlockstore, def } from '@atproto/repo';
import type { Commit } from '@atproto/repo';
import { CID } from 'multiformats';
import { GlobalStore } from './store.js';
import { resolveDidWeb, defaultResolverDeps } from '../identity/didweb.js';
import type { ResolverDeps } from '../identity/didweb.js';
import type { ResolverConfig } from '../config.js';
import { log } from '../log.js';

/**
* The global-firehose indexer (FIREHOSE-INDEXER-TASK). It subscribes to the
 * REAL production relay `wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos`
 * — not our own aggregators — and indexes our lexicon (the current
 * `org.peertelemetry.errorMetrics` and, via permanent dual-read, the legacy
 * `app.omniroute.errorReport`) back OUT of the merged global stream. This is
 * the round-trip proof: publisher -> our aggregator -> bsky.network -> here.
* The global-firehose indexer (FIREHOSE-INDEXER-TASK), REWRITTEN per
 * KILL-RAW-FIREHOSE.md. It no longer DRINKS anyone's raw
 * `com.atproto.sync.subscribeRepos`. The human decision, already made and proven
 * by the soak: consuming the full `bsky.network` firehose is the wrong end of
 * the tradeoff. `bsky.network` ignores `wantedCollections`, a verifying consumer
 * on one small VM cannot keep up with ~383 commits/s, and the old indexer fell
 * ~23.7 h / ~16.4M events behind while pure transport was 271 ms p50. *
 * The replacement is the Jetstream hybrid (JETSTREAM-NOTE.md):
 *
 *   1. NOTIFY. Subscribe Jetstream filtered server-side to our one collection
 *      (`wss://<jetstream>/subscribe?wantedCollections=<coll>`). Near-zero
 *      bandwidth; Jetstream honours the filter (a 12 s probe returned 3111/3117
 *      matching). Jetstream STRIPS the crypto - decoded JSON plus `rev`/`cid`,
 *      no `sig`, no signed commit block, no MST proof. It is a NOTIFICATION only.
 *   2. FETCH + VERIFY. On each notification, fetch the SIGNED record from the
 *      publisher's OWN PDS with `com.atproto.sync.getRecord` (record plus its
 *      covering MST proof as a CAR) and verify it against the publisher's
 *      did:web `#atproto` key with `verifyRecords` (checks the commit signature
 *      AND that the record is proven by the covering MST). Verification load
 *      drops from ~383/s of strangers' traffic to our own ~0.3/s.
 *   3. A record is INDEXED ONLY AFTER verification succeeds. Unverifiable
 *      records are rejected and counted, never indexed. We NEVER index straight
 *      from Jetstream's decoded JSON - that would reintroduce the trusted
 *      central operator this project exists to remove.
 *
 * `arrivedAt` is stamped at NOTIFICATION receipt (pre-fetch, pre-verify) so the
 * arrival-lag semantics stay comparable to the raw-firehose numbers already
 * measured.
 *
 * This is CONSUMING only. Our PDS's own `subscribeRepos` emission is a different
 * subsystem (src/firehose/) and is untouched: it is how our records reach the
 * outside world and how Jetstream learns of them at all.
 *
 * Failure modes handled (KILL-RAW-FIREHOSE §"Failure modes"):
 *   - Jetstream can lie by OMISSION (drop records it does not want us to see);
 *     unlike a forged record we cannot detect that cryptographically. A periodic
 *     reconciliation sweep does `listRecords` against each known publisher PDS
 *     and counts any record present at the source but never notified
 *     (`reconcile_missing`) - the trust-but-verify metric for the channel. It
 *     ALSO fetches+verifies+indexes those missed records, so the sweep doubles
 *     as the fallback path.
 *   - Source PDS unreachable at fetch time: bounded retry with backoff via a
 *     capped queue; drops counted (`fetch_drops`). Never index unverified data.
 *   - Jetstream down entirely: the reconciliation sweep IS the fallback, so the
 *     system degrades to polling rather than stopping.
 */
export interface GlobalIndexerConfig {
  /**
   * Collection NSID(s) to index. Accepts one NSID or a set. The set exists for
   * the permanent dual-read: pre-rename records carry the immutable legacy NSID
   * `app.omniroute.errorReport` in signed bytes forever, while new records use
   * `org.peertelemetry.errorMetrics`, so the indexer must match both. See
   * `src/collections.ts`.
   */
  targetCollection: string | readonly string[];
  /**
   * Jetstream host used as the NOTIFICATION channel, e.g.
   * `jetstream1.us-east.bsky.network`. The old `relayHost` name is retained in
   * `status()` for UI continuity but now reports this Jetstream host.
   */
  jetstreamHost: string;
  /**
   * Known publisher PDS hosts to reconcile against, e.g.
   * ['p2.0rs.org', 'p3.0rs.org']. `listRecords` runs against each on a slow tick
   * to catch anything Jetstream dropped by omission. If empty, reconciliation is
   * disabled (notify-only).
   */
  reconcilePdsHosts: string[];
  resolverConfig: ResolverConfig;
  /** Test hook: inject a fake DID resolver instead of the live network. */
  resolverDeps?: ResolverDeps;
  /**
   * Test hook for getRecord / listRecords. Production uses bounded, DNS-pinned
   * HTTPS: the PDS endpoint in a publisher DID document is untrusted input.
   */
  httpGet?: (url: string) => Promise<{ status: number; bytes: Uint8Array; text: () => string }>;
  /** Reconciliation cadence in ms (default 5 min). 0 disables the sweep timer. */
  reconcileIntervalMs?: number;
  /** Max concurrent getRecord+verify fetches (backlog-burst guard). Default 6. */
  verifyMaxInflight?: number;
  /**
   * Base backoff (ms) for the source-PDS-unreachable retry, doubled per attempt
   * and capped at 30 s. Default 500. Tests set this to a small value to drive
   * retry exhaustion deterministically without slowing the suite.
   */
  retryBaseMs?: number;
}

/** A queued notification awaiting fetch-and-verify. */
interface PendingVerify {
  did: string;
  collection: string;
  rkey: string;
  /**
   * True if the notification was a `delete`. A delete is CONFIRMED against the
   * source PDS the same way a create is: we fetch getRecord and only tombstone
   * the local row when the source proves the record is gone (404). We never
   * tombstone on the strength of the unverified Jetstream notification alone -
   * that would let the Jetstream operator censor a record with a fabricated
   * delete. If the source still serves the record, the "delete" was a lie or is
   * stale, and the record is kept.
   */
  isDelete?: boolean;
  /** Wall-clock at notification receipt (t_arrival), pre-verification. */
  arrivedAt: string;
  /** Jetstream's own emit stamp (ms), for the live/replay distinction. */
  jsStampMs: number | null;
  /** Retry attempts already spent on this item. */
  attempts: number;
  /**
   * True once we have already re-resolved the publisher identity for this item
   * after a verification failure (a possible key rotation). Bounds the refresh to
   * a single retry so a genuinely forged record cannot loop.
   */
  keyRefreshed?: boolean;
}

export class GlobalIndexer {
  private ws: WebSocket | null = null;
  private running = false;
  /** Cache of resolved publisher identities (did -> {signing did:key, pdsEndpoint}). */
  private readonly idCache = new Map<string, { signingKey: string; pdsHost: string }>();
  private connectedSince: string | null = null;
  private lastEventUs = 0;
  /** Reconnect backoff (real socket drops only), capped. */
  private reconnectAttempts = 0;
  private static readonly RECONNECT_MIN_MS = 1_000;
  private static readonly RECONNECT_MAX_MS = 30_000;

/** Normalized NSID set to index (dual-read). Derived from config.targetCollection. */
  private readonly targetCollections: readonly string[];
/** Bounded fetch-and-verify queue (source-PDS-unreachable retry path). */
  private readonly queue: PendingVerify[] = [];
  private static readonly QUEUE_CAP = 10_000;
  private static readonly MAX_ATTEMPTS = 5;
  private verifyInflight = 0;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  /** In-flight retry timers, so stop() can cancel them (no leaks on shutdown). */
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Count of items waiting on a scheduled retry (drainQueue must wait for these). */
  private pendingRetries = 0;
  constructor(
    readonly store: GlobalStore,
    private readonly config: GlobalIndexerConfig,
  ) {
    this.targetCollections = Array.isArray(config.targetCollection)
      ? [...config.targetCollection]
      : [config.targetCollection as string];
  }

  private get verifyMaxInflight(): number {
    return this.config.verifyMaxInflight ?? 6;
  }

  private get reconcileIntervalMs(): number {
    return this.config.reconcileIntervalMs ?? 5 * 60_000;
  }

  private get retryBaseMs(): number {
    return this.config.retryBaseMs ?? 500;
  }

  start(): void {
    this.running = true;
    // Seed the monotonic cursor guard from the persisted cursor so a restart
    // does not accept a time_us older than where we already resumed from.
    const persisted = this.store.getCursor(this.config.jetstreamHost);
    if (persisted > 0) this.lastEventUs = persisted;
    // Repair rows indexed before the correlation-field extraction fix (idempotent).
    const backfilled = this.store.backfillCorrelationFields();
    if (backfilled > 0) log.info('globalindex: backfilled correlation fields from record_json', { rows: backfilled });
    this.subscribeJetstream();
    if (this.config.reconcilePdsHosts.length > 0 && this.reconcileIntervalMs > 0) {
      // Kick one sweep shortly after boot, then on the slow tick. The initial
      // delay lets the notify channel catch the live tail first so the very
      // first sweep does not attribute steady-state records to Jetstream drops.
      setTimeout(() => this.reconcileOnce().catch((err) => log.warn('globalindex: reconcile failed', { err: (err as Error).message })), 30_000);
      this.reconcileTimer = setInterval(
        () => this.reconcileOnce().catch((err) => log.warn('globalindex: reconcile failed', { err: (err as Error).message })),
        this.reconcileIntervalMs,
      );
    }
  }

  stop(): void {
    this.running = false;
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    // Cancel any scheduled retries so they do not fire after shutdown (also
    // prevents open-handle leaks in tests).
    for (const t of this.retryTimers) clearTimeout(t);
    this.retryTimers.clear();
    this.pendingRetries = 0;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  /** Observability for the UI header. `relayHost` now reports the Jetstream host. */
  status(): {
    relayHost: string;
    connected: boolean;
    connectedSince: string | null;
    lastSeq: number;
    cursor: number;
    reconnects: number;
    filtered: boolean;
    source: 'jetstream-notify+verify';
    jetstreamEvents: number;
    verified: number;
    fetchDrops: number;
    fetchRetries: number;
    reconcileMissing: number;
    deletesConfirmed: number;
    deletesRejected: number;
    queueDepth: number;
  } {
    return {
      relayHost: this.config.jetstreamHost,
      connected: this.ws != null && this.ws.readyState === this.ws.OPEN,
      connectedSince: this.connectedSince,
      // lastSeq/cursor kept for the UI contract; Jetstream is cursored by
      // time_us (a wall stamp, not a relay seq). Expose the last event stamp so
      // the header still shows liveness. No firehose cursor exists any more.
      lastSeq: Math.floor(this.lastEventUs / 1_000_000),
      cursor: this.store.getCursor(this.config.jetstreamHost),
      reconnects: this.store.getStat('reconnects'),
      filtered: true, // Jetstream filters server-side, always.
      source: 'jetstream-notify+verify',
      jetstreamEvents: this.store.getStat('jetstream_events'),
      verified: this.store.getStat('records_indexed'),
      fetchDrops: this.store.getStat('fetch_drops'),
      fetchRetries: this.store.getStat('fetch_retries'),
      reconcileMissing: this.store.getStat('reconcile_missing'),
      deletesConfirmed: this.store.getStat('deletes_confirmed'),
      deletesRejected: this.store.getStat('deletes_rejected'),
      queueDepth: this.queue.length,
    };
  }

  // --- signing-key + PDS resolution ------------------------------------------

  private async identityFor(did: string): Promise<{ signingKey: string; pdsHost: string } | null> {
    const cached = this.idCache.get(did);
    if (cached) return cached;
    try {
      const identity = await resolveDidWeb(did, this.config.resolverConfig, this.config.resolverDeps ?? defaultResolverDeps());
      // The publisher's OWN PDS is where its signed record lives. did:web docs
      // carry the `#atproto_pds` serviceEndpoint; fetch getRecord from there,
      // never from a relay or from Jetstream.
      const pdsHost = hostOf(identity.pdsEndpoint);
      const entry = { signingKey: identity.atprotoKey.didKey, pdsHost };
      this.idCache.set(did, entry);
      return entry;
    } catch (err) {
      log.warn('globalindex: could not resolve publisher DID doc', { did, err: (err as Error).message });
      return null;
    }
  }

  // --- Jetstream notification channel ----------------------------------------

  private subscribeJetstream(): void {
    if (!this.running) return;
    const base = `wss://${this.config.jetstreamHost}/subscribe`;
    // Persisted cursor: Jetstream accepts `cursor=<time_us>` to resume. On the
    // first connect of a process we omit it (live tail); on reconnect we resume
    // from the last persisted event stamp so a brief drop does not lose the
    // window. One subscribe per process, cursor-resume: the connect-storm
    // discipline that fix ed5ee8f established.
    const persisted = this.store.getCursor(this.config.jetstreamHost);
    const params = new URLSearchParams();
    // Jetstream's JSON subscription uses repeated collection parameters.
    for (const collection of this.targetCollections) params.append('wantedCollections', collection);
    if (persisted > 0) params.set('cursor', String(persisted));
    const url = `${base}?${params.toString()}`;
    log.info('globalindex: subscribing to Jetstream', { url, resume: persisted > 0 });
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.connectedSince = new Date().toISOString();
      this.reconnectAttempts = 0;
      this.store.bumpStat('connections');
      log.info('globalindex: Jetstream connected', { host: this.config.jetstreamHost, resume: persisted > 0 });
    });
    ws.on('message', (data: ArrayBuffer | Buffer) => {
      // Stamp arrival BEFORE any parse/async work - this is t_arrival.
      const arrivedAt = new Date().toISOString();
      let text: string;
      try {
        text = data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : data.toString('utf8');
      } catch {
        return;
      }
      this.onJetstreamEvent(text, arrivedAt);
    });
    ws.on('close', () => {
      this.connectedSince = null;
      this.ws = null;
      if (!this.running) return;
      this.store.bumpStat('reconnects');
      const delay = Math.min(
        GlobalIndexer.RECONNECT_MAX_MS,
        GlobalIndexer.RECONNECT_MIN_MS * 2 ** Math.min(this.reconnectAttempts, 5),
      );
      this.reconnectAttempts += 1;
      setTimeout(() => this.subscribeJetstream(), delay);
    });
    ws.on('error', (err) => log.warn('globalindex: Jetstream socket error', { err: (err as Error).message }));
  }

  /** Test hook: drive the same path a live Jetstream text frame takes. */
  async testOnJetstreamEvent(json: string, arrivedAt = new Date().toISOString()): Promise<void> {
    // A live event only arrives while subscribed, so the retry path (which is
    // gated on `running`) must see the indexer as running. `stop()` clears it.
    this.running = true;
    this.onJetstreamEvent(json, arrivedAt);
    // Drain synchronously for tests: run the queue to completion.
    await this.drainQueue();
  }

  private onJetstreamEvent(text: string, arrivedAt: string): void {
    let evt: {
      kind?: string;
      did?: string;
      time_us?: number;
      commit?: { collection?: string; rkey?: string; operation?: string; rev?: string; cid?: string; record?: Record<string, unknown> };
    };
    try {
      evt = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof evt.time_us === 'number' && Number.isFinite(evt.time_us)) {
      // Persist the cursor so a reconnect resumes from here. Jetstream's cursor
      // is a time_us wall stamp, not a relay seq. Advance it MONOTONICALLY and
      // reject a wildly-future value: a non-monotonic or garbage-large time_us
      // (out-of-order delivery, or a buggy/hostile operator) would otherwise jump
      // the persisted cursor forward and make a later reconnect SKIP everything
      // between the true position and that value - silent data loss. We only move
      // the cursor forward, and never past ~1h ahead of our own wall clock (the
      // stream is live; a stamp far in the future is not a real resume point).
      const maxAcceptable = (Date.now() + 3_600_000) * 1000; // time_us is microseconds
      if (evt.time_us > this.lastEventUs && evt.time_us <= maxAcceptable) {
        this.lastEventUs = evt.time_us;
        this.store.setCursor(this.config.jetstreamHost, evt.time_us);
      }
    }
    if (evt.kind !== 'commit' || !evt.commit) return;
    const c = evt.commit;
    if (typeof c.collection !== 'string' || !this.targetCollections.includes(c.collection)) return;
    this.store.bumpStat('jetstream_events');
    const did = String(evt.did ?? '');
    const rkey = String(c.rkey ?? '');
    if (!did || !rkey) return;
    // A delete notification is CONFIRMED against the source PDS before we act on
    // it, exactly like a create: we never tombstone on Jetstream's unverified
    // word (that would let the operator censor a record with a fabricated
    // delete). Enqueue it with isDelete; fetchVerifyIndex tombstones only if the
    // source proves the record gone (getRecord 404), and keeps it otherwise.
    const isDelete = c.operation === 'delete';
    // A create/update notification: enqueue for fetch-and-verify. We NEVER index
    // from c.record (Jetstream's unsigned decoded JSON) - that is the whole point.
    this.enqueue({
      did,
      collection: c.collection,
      rkey,
      isDelete,
      arrivedAt,
      jsStampMs: typeof evt.time_us === 'number' ? evt.time_us / 1000 : null,
      attempts: 0,
    });
    void this.pump();
  }

  // --- bounded fetch-and-verify queue ----------------------------------------

  private enqueue(item: PendingVerify): void {
    if (this.queue.length >= GlobalIndexer.QUEUE_CAP) {
      // Bounded queue: drop the OLDEST pending item rather than grow unbounded
      // under a backlog burst. Count it - never silently.
      this.queue.shift();
      this.store.bumpStat('fetch_drops');
      log.warn('globalindex: verify queue full, dropped oldest pending', { cap: GlobalIndexer.QUEUE_CAP });
    }
    this.queue.push(item);
  }

  /** Start as many verify workers as the concurrency cap allows. */
  private async pump(): Promise<void> {
    while (this.verifyInflight < this.verifyMaxInflight && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      this.verifyInflight += 1;
      void this.processItem(item).finally(() => {
        this.verifyInflight -= 1;
        // A slot freed: keep draining.
        void this.pump();
      });
    }
  }

  /**
   * Test/reconcile helper: wait until the queue is fully drained, INCLUDING
   * items waiting on a scheduled retry timer. It does NOT process items itself
   * (that would race the real `pump()` workers and the retry timers, which are
   * the sole drainers); it only kicks `pump()` and waits for the system to
   * settle. This lets a test await the full retry-until-exhaustion sequence
   * (retryBaseMs should be small in tests).
   */
  private async drainQueue(): Promise<void> {
    void this.pump();
    while (this.queue.length > 0 || this.verifyInflight > 0 || this.pendingRetries > 0) {
      // Yield long enough for a small-retryBaseMs timer to fire and re-enqueue,
      // then re-check. pump() is re-kicked in case a retry re-enqueued while no
      // worker slot was free.
      await new Promise((r) => setTimeout(r, 1));
      void this.pump();
    }
  }

  private async processItem(item: PendingVerify): Promise<void> {
    const id = await this.identityFor(item.did);
    if (!id) {
      this.store.recordRejection({ at: new Date().toISOString(), did: item.did, seq: null, rev: null, commitCid: null, reason: 'did-doc-unresolvable' });      return;
    }
    try {
      await this.fetchVerifyIndex(item, id);
    } catch (err) {
      const message = (err as Error).message;
      const retryable = isRetryable(err);
      if (retryable && item.attempts + 1 < GlobalIndexer.MAX_ATTEMPTS) {
        // Source PDS unreachable / transient: re-enqueue with backoff. Bounded
        // by MAX_ATTEMPTS; the queue itself is bounded by QUEUE_CAP.
        const next = { ...item, attempts: item.attempts + 1 };
        const delay = Math.min(30_000, this.retryBaseMs * 2 ** item.attempts);
        this.store.bumpStat('fetch_retries');
        // pendingRetries stays incremented until the item is back in the queue,
        // so drainQueue never observes an all-zero (queue empty, nothing in
        // flight, no pending retry) window while a retry is genuinely pending.
        this.pendingRetries += 1;
        const timer = setTimeout(() => {
          this.retryTimers.delete(timer);
          if (this.running) this.enqueue(next);
          this.pendingRetries -= 1;
          if (!this.running) return;
          void this.pump();
        }, delay);
        this.retryTimers.add(timer);
        log.warn('globalindex: fetch failed, will retry', { did: item.did, rkey: item.rkey, attempt: item.attempts + 1, err: message });
        return;
      }
      // A verification failure MIGHT be a stale cached signing key: the publisher
      // rotated its did:web #atproto key (the design explicitly supports rotation
      // and verifies against the CURRENT doc), but idCache still holds the old
      // one, so every genuine new record would fail. On the first verify failure
      // for an item, drop the cached identity and re-enqueue ONCE with a fresh
      // resolve. If it still fails against the freshly-resolved current key, it is
      // a real forgery and is rejected. Bounded to one refresh so a forged record
      // cannot loop. Only verification failures trigger this, never fetch drops.
      if (!retryable && !item.keyRefreshed) {
        this.idCache.delete(item.did);
        this.store.bumpStat('key_refreshes');
        log.warn('globalindex: verify failed, re-resolving did:web (possible key rotation) and retrying once', { did: item.did, rkey: item.rkey, err: message });
        const next = { ...item, keyRefreshed: true, attempts: 0 };
        if (this.running) {
          this.enqueue(next);
          void this.pump();
        }
        return;
      }
      // Exhausted retries or a non-retryable verification failure: reject +
      // count, never index. A verification failure (bad sig / MST mismatch) is
      // the security-relevant rejection; a fetch exhaustion is a drop.
      if (retryable) {
        this.store.bumpStat('fetch_drops');
        log.warn('globalindex: fetch exhausted, dropped (never indexed)', { did: item.did, rkey: item.rkey, err: message });
      } else {
        this.store.recordRejection({
          at: new Date().toISOString(),
          did: item.did,
          seq: null,
          rev: null,
          commitCid: null,
          reason: `verify-failed: ${message}`,
        });
        log.warn('globalindex: record failed verification - not indexed', { did: item.did, rkey: item.rkey, err: message });
      }
    }
  }

  /**
   * Fetch the signed record CAR from the publisher's own PDS via
   * `com.atproto.sync.getRecord`, verify it against the did:web `#atproto` key
   * with `verifyRecords` (commit signature AND covering-MST proof), and index it
   * ONLY on success. Throws on fetch failure (retryable) or verification failure
   * (non-retryable, tagged).
   */
  private async fetchVerifyIndex(item: PendingVerify, id: { signingKey: string; pdsHost: string }): Promise<void> {
    const { did, collection, rkey } = item;
    const url = `https://${id.pdsHost}/xrpc/com.atproto.sync.getRecord?did=${encodeURIComponent(did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
    const res = await this.httpGet(url);

    // Delete confirmation path: a delete is only applied once the SOURCE proves
    // the record is gone. A 404 (RecordNotFound / RepoNotFound) is that proof;
    // tombstone the local row. A 200 means the source still serves the record, so
    // the Jetstream "delete" was spurious or stale - keep the record, do nothing.
    // Any other status is a transient fetch failure and retries like a create.
    if (item.isDelete) {
      if (res.status === 404) {
        this.store.putRecord({
          seq: this.stampSeq(item.jsStampMs == null ? null : item.jsStampMs * 1000),
          commitCid: '',
          did,
          rev: '',
          opAction: 'delete',
          collection,
          rkey,
          opCid: null,
          recordJson: null,
          sigOk: false,
          frameTime: item.arrivedAt,
          indexedAt: new Date().toISOString(),
          arrivedAt: item.arrivedAt,
          publisherSeq: null,
          publisherEmittedAt: null,
        });
        this.store.bumpStat('deletes_confirmed');
        log.info('globalindex: delete confirmed absent at source, tombstoned', { did, rkey });
        return;
      }
      if (res.status === 200) {
        // Source still serves it: the notification's delete was not real. Keep.
        this.store.bumpStat('deletes_rejected');
        log.warn('globalindex: Jetstream delete notification not confirmed by source (record still present) - keeping record', { did, rkey });
        return;
      }
      throw new FetchError(`getRecord HTTP ${res.status} (delete confirmation)`);
    }

    if (res.status === 404) {
      // The record is gone at the source (deleted between notify and fetch).
      // Not an error, not indexed. Not retryable.
      throw new VerifyError(`getRecord 404 (record absent at source)`);
    }
    if (res.status !== 200) {
      throw new FetchError(`getRecord HTTP ${res.status}`);
    }
    const car = res.bytes;

    // verifyRecords(proofs, did, signingKey): reads the commit block from the
    // CAR root, checks commit.did === did, verifies the commit signature against
    // the signing key, loads the MST from the commit, and returns only records
    // reachable through that proven tree. Any mismatch throws. This is the exact
    // consumer verification the raw-firehose indexer did, minus the firehose.
    let recs: Array<{ collection: string; rkey: string; record: Record<string, unknown> }>;
    try {
      recs = (await verifyRecords(car, did, id.signingKey)) as typeof recs;
    } catch (err) {
      // A signature / MST / did-mismatch failure is a REJECTION, not a drop.
      throw new VerifyError(`verifyRecords: ${(err as Error).message}`);
    }
    const hit = recs.find((r) => r.collection === collection && r.rkey === rkey);
    if (!hit) {
      throw new VerifyError('record not present in verified covering proof');
    }

    // Pull the same identifiers the raw-firehose path recorded, from the SIGNED
    // CAR (never from Jetstream's JSON): commit CID (root), rev, per-op record CID.
    const { root, commit } = await readSignedCommit(car);
    const rec = hit.record;
    const recordJson = JSON.stringify(rec);
    const publisherSeq = typeof rec.seq === 'number' && Number.isFinite(rec.seq) ? rec.seq : null;
    const publisherEmittedAt = typeof rec.emittedAt === 'string' ? rec.emittedAt : null;
    const opCid = await recordCidFrom(car, collection, rkey);
    const seq = publisherSeq ?? this.stampSeq(item.jsStampMs == null ? null : item.jsStampMs * 1000);

    this.store.putRecord({
      seq,
      commitCid: root.toString(),
      did,
      rev: commit.rev,
      opAction: 'create',
      collection,
      rkey,
      opCid: opCid?.toString() ?? null,
      recordJson,
      sigOk: true,
      // frameTime keeps its meaning: the publisher's relay-equivalent stamp. We
      // no longer have a relay frame `time`, so use the publisher's own signed
      // emittedAt (authoritative) and fall back to arrival. Latency math in the
      // store subtracts emittedAt from frameTime/arrivedAt; using emittedAt as
      // frameTime yields a 0 relay-hop, which is HONEST: there is no relay hop
      // on this path, only the source-PDS fetch (recorded as arrivedAt lag).
      frameTime: publisherEmittedAt ?? item.arrivedAt,
      indexedAt: new Date().toISOString(),
      arrivedAt: item.arrivedAt,
      publisherSeq,
      publisherEmittedAt,
    });
    this.store.bumpStat('records_indexed');
    log.info('globalindex: verified + indexed via Jetstream notify', { did, rkey, seq, commitCid: root.toString() });
  }

  private httpGet(url: string): Promise<{ status: number; bytes: Uint8Array; text: () => string }> {
    if (this.config.httpGet) return this.config.httpGet(url);
    return defaultHttpGet(url);
  }

  // --- reconciliation sweep (trust-but-verify the notification channel) ------

  /**
   * Slow-tick `listRecords` against every known publisher PDS. Any record that
   * exists at the source but has NO local latest row was never notified by
   * Jetstream: count it (`reconcile_missing`) and, because we already have its
   * (did, collection, rkey), fetch-verify-index it. The counter is the
   * trust-but-verify metric; the indexing makes the sweep the fallback path when
   * Jetstream is dropping records or down entirely.
   */
  async reconcileOnce(): Promise<{ checked: number; missing: number }> {
    let checked = 0;
    let missing = 0;
    for (const pdsHost of this.config.reconcilePdsHosts) {
      // Enumerate the publisher DIDs this PDS serves via listRepos, then
      // listRecords for our collection on each. Both are unauthenticated reads.
      let dids: string[];
      try {
        dids = await this.listRepos(pdsHost);
      } catch (err) {
        log.warn('globalindex: reconcile listRepos failed', { pdsHost, err: (err as Error).message });
        continue;
      }
      for (const did of dids) {
        // Dual-read: sweep every NSID we index, not just the current one -
        // pre-rename records carry the legacy NSID in signed bytes forever.
        for (const collection of this.targetCollections) {
          let records: Array<{ rkey: string }>;
          try {
            records = await this.listRecords(pdsHost, did, collection);
          } catch (err) {
            log.warn('globalindex: reconcile listRecords failed', {
              pdsHost,
              did,
              collection,
              err: (err as Error).message,
            });
            continue;
          }
          for (const r of records) {
            checked += 1;
            if (this.store.hasLatest(did, collection, r.rkey)) continue;
            // Present at source, never notified: a Jetstream drop-by-omission.
            missing += 1;
            this.store.bumpStat('reconcile_missing');
            log.warn('globalindex: reconciliation found record never notified by Jetstream', {
              pdsHost,
              did,
              collection,
              rkey: r.rkey,
            });
            // Fallback path: verify+index it exactly like a notification would.
            this.enqueue({
              did,
              collection,
              rkey: r.rkey,
              arrivedAt: new Date().toISOString(),
              jsStampMs: null,
              attempts: 0,
            });
          }
        }
      }
    }
    if (checked > 0) log.info('globalindex: reconciliation sweep complete', { checked, missing });
    void this.pump();
    return { checked, missing };
  }

  private async listRepos(pdsHost: string): Promise<string[]> {
    const url = `https://${pdsHost}/xrpc/com.atproto.sync.listRepos?limit=500`;
    const res = await this.httpGet(url);
    if (res.status !== 200) throw new FetchError(`listRepos HTTP ${res.status}`);
    const body = JSON.parse(res.text()) as { repos?: Array<{ did?: string }> };
    return (body.repos ?? []).map((r) => String(r.did ?? '')).filter(Boolean);
  }

  private async listRecords(pdsHost: string, did: string, collection: string): Promise<Array<{ rkey: string }>> {
    const out: Array<{ rkey: string }> = [];
    let cursor: string | undefined;
    // Page through; bound the loop so a hostile/broken PDS cannot spin us forever.
    for (let page = 0; page < 1_000; page++) {
      const params = new URLSearchParams({ repo: did, collection, limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const url = `https://${pdsHost}/xrpc/com.atproto.repo.listRecords?${params.toString()}`;
      const res = await this.httpGet(url);
      if (res.status === 404) return out; // no repo / no records at this PDS
      if (res.status !== 200) throw new FetchError(`listRecords HTTP ${res.status}`);
      const body = JSON.parse(res.text()) as { records?: Array<{ uri?: string }>; cursor?: string };
      for (const rec of body.records ?? []) {
        const uri = String(rec.uri ?? '');
        const rkey = uri.slice(uri.lastIndexOf('/') + 1);
        if (rkey) out.push({ rkey });
      }
      if (!body.cursor || (body.records ?? []).length === 0) break;
      cursor = body.cursor;
    }
    return out;
  }

  // --- misc helpers ----------------------------------------------------------

  /** Derive an integer "seq" for the store's PK from a time_us stamp (fallback). */
  private stampSeq(timeUs: number | null | undefined): number {
    if (typeof timeUs === 'number' && Number.isFinite(timeUs)) return Math.floor(timeUs / 1000);
    return this.lastEventUs > 0 ? Math.floor(this.lastEventUs / 1000) : 0;
  }

  private usToIso(timeUs: number | null | undefined): string | null {
    if (typeof timeUs !== 'number' || !Number.isFinite(timeUs)) return null;
    return new Date(timeUs / 1000).toISOString();
  }
}

// --- module-level helpers ----------------------------------------------------

class FetchError extends Error {}
class VerifyError extends Error {}

/** A fetch failure is retryable (network/5xx); a verify failure is not. */
function isRetryable(err: unknown): boolean {
  return err instanceof FetchError;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    // Already a bare host, or malformed - fall back to the raw string.
    return endpoint.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

/** Read the signed commit (root + parsed commit block) from a getRecord CAR. */
async function readSignedCommit(car: Uint8Array): Promise<{ root: CID; commit: Commit }> {
  const { root, blocks } = await readCarWithRoot(car);
  const store = new MemoryBlockstore(blocks);
  const commit = (await store.readObj(root, def.commit)) as unknown as Commit;
  return { root, commit };
}

/**
 * Resolve the per-op record CID from a getRecord covering-proof CAR by walking
 * the proven MST to the leaf. Returns null if the leaf is not present (should
 * not happen for a record verifyRecords already accepted).
 */
async function recordCidFrom(car: Uint8Array, collection: string, rkey: string): Promise<CID | null> {
  const { root, blocks } = await readCarWithRoot(car);
  const store = new MemoryBlockstore(blocks);
  const commit = (await store.readObj(root, def.commit)) as unknown as Commit;
  const { MST } = await import('@atproto/repo');
  const mst = MST.load(store, commit.data);
  const key = `${collection}/${rkey}`;
  try {
    const cid = await mst.get(key);
    return cid ?? null;
  } catch {
    return null;
  }
}

/** Bound and pin all fetches to publisher-advertised PDS endpoints. */
async function defaultHttpGet(url: string): Promise<{ status: number; bytes: Uint8Array; text: () => string }> {
  const res = await guardedFetch(url, { timeoutMs: 10_000, maxBytes: 16 * 1024 * 1024, maxRedirects: 0 }).catch((err: unknown) => {
    if (!(err instanceof GuardedFetchError) || err.code === 'timeout' || err.code === 'dns-failure') {
      throw new FetchError((err as Error).message);
    }
    throw err;
  });
  const buf = res.body;
  return {
    status: res.status,
    bytes: buf,
    text: () => Buffer.from(buf).toString('utf8'),
  };
}
