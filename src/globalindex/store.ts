import { DatabaseSync } from 'node:sqlite';

/**
 * The global-firehose index (FIREHOSE-INDEXER-TASK). A SQLite store of every
 * error-metrics op (current `org.peertelemetry.errorMetrics` or, via dual-read,
 * legacy `app.omniroute.errorReport`) seen on the *global* relay firehose
 * (`wss://bsky.network/xrpc/com.atproto.sync.subscribeRepos`) — NOT on our own
 * aggregators. This is the round-trip proof store: a record only lands here if
 * it went publisher -> our aggregator -> bsky.network -> back out the merged
 * global stream into this consumer.
 *
 * Deliberately separate from the AppView's `IndexStore` (which reads p2/p3
 * directly). Nothing is ever copied from the local index into this one; every
 * row carries the relay's own global `seq` plus the full commit CID / op CID /
 * rev / DID, untruncated, and whether the commit signature verified against the
 * publisher's did:web document.
 */
export interface GlobalRecord {
  /** Relay-global sequence number of the #commit frame (bsky.network's seq). */
  seq: number;
  /** Full commit CID from the frame header. */
  commitCid: string;
  did: string;
  rev: string;
  opAction: string;
  collection: string;
  rkey: string;
  /** Full per-op record CID (null for deletes). */
  opCid: string | null;
  /** Decoded record JSON (null for deletes / missing blocks). */
  recordJson: string | null;
  sigOk: boolean;
  /** Frame `time` as stamped by the relay. */
  frameTime: string;
  indexedAt: string;
  /**
   * Wall-clock instant WE received this frame (stamped at socket receipt,
   * before async DID-resolution/signature work). Unlike `indexedAt` this is
   * never inflated by verification queueing; unlike `frameTime` it reflects
   * real delivery to this consumer. Latency uses frameTime / arrivedAt, never
   * indexedAt.
   */
  arrivedAt: string;
  /** In-band publisher correlation seq from the SIGNED record (null if absent). */
  publisherSeq: number | null;
  /** In-band publisher emittedAt from the SIGNED record (null if absent). */
  publisherEmittedAt: string | null;
}

export class GlobalStore {
  private readonly db: DatabaseSync;

  constructor(location = ':memory:') {
    this.db = new DatabaseSync(location);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS global_record (
        seq         INTEGER NOT NULL,
        commit_cid  TEXT NOT NULL,
        did         TEXT NOT NULL,
        rev         TEXT NOT NULL,
        op_action   TEXT NOT NULL,
        collection  TEXT NOT NULL,
        rkey        TEXT NOT NULL,
        op_cid      TEXT,
        record_json TEXT,
        sig_ok      INTEGER NOT NULL,
        frame_time  TEXT NOT NULL,
        indexed_at  TEXT NOT NULL,
        arrived_at  TEXT,
        publisher_seq INTEGER,
        publisher_emitted_at TEXT,
        PRIMARY KEY (seq, commit_cid, collection, rkey)
      );
      CREATE INDEX IF NOT EXISTS global_record_did_idx ON global_record(did);
      CREATE INDEX IF NOT EXISTS global_record_seq_idx ON global_record(seq);

      -- Latest accepted seq per (did, collection, rkey): the live aggregate view.
      CREATE TABLE IF NOT EXISTS latest_record (
        did         TEXT NOT NULL,
        collection  TEXT NOT NULL,
        rkey        TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        commit_cid  TEXT NOT NULL,
        rev         TEXT NOT NULL,
        op_cid      TEXT,
        record_json TEXT,
        sig_ok      INTEGER NOT NULL,
        frame_time  TEXT NOT NULL,
        indexed_at  TEXT NOT NULL,
        publisher_seq INTEGER,
        publisher_emitted_at TEXT,
        PRIMARY KEY (did, collection, rkey)
      );

      -- Firehose resume cursor for the relay (host = 'bsky.network').
      CREATE TABLE IF NOT EXISTS relay_cursor (
        host   TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stat (
        key   TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );

      -- Commits that FAILED verification: counted and kept, never indexed.
      CREATE TABLE IF NOT EXISTS rejection (
        at         TEXT NOT NULL,
        did        TEXT NOT NULL,
        seq        INTEGER,
        rev        TEXT,
        commit_cid TEXT,
        reason     TEXT NOT NULL
      );
    `);
    // Migration: older DBs created before publisher_seq/publisher_emitted_at/arrived_at.
    for (const table of ['global_record', 'latest_record']) {
      const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('publisher_seq')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN publisher_seq INTEGER`);
      if (!names.has('publisher_emitted_at')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN publisher_emitted_at TEXT`);
      if (!names.has('arrived_at')) this.db.exec(`ALTER TABLE ${table} ADD COLUMN arrived_at TEXT`);
    }
  }

  // --- event log + latest view ---------------------------------------------

  putRecord(r: GlobalRecord): void {
    this.db
      .prepare(
        `INSERT INTO global_record
           (seq, commit_cid, did, rev, op_action, collection, rkey, op_cid, record_json, sig_ok, frame_time, indexed_at, arrived_at, publisher_seq, publisher_emitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(seq, commit_cid, collection, rkey) DO NOTHING`,
      )
      .run(
        r.seq,
        r.commitCid,
        r.did,
        r.rev,
        r.opAction,
        r.collection,
        r.rkey,
        r.opCid,
        r.recordJson,
        r.sigOk ? 1 : 0,
        r.frameTime,
        r.indexedAt,
        r.arrivedAt,
        r.publisherSeq,
        r.publisherEmittedAt,
      );
    if (r.opAction === 'delete') {
      this.db.prepare('DELETE FROM latest_record WHERE did = ? AND collection = ? AND rkey = ?').run(r.did, r.collection, r.rkey);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO latest_record
           (did, collection, rkey, seq, commit_cid, rev, op_cid, record_json, sig_ok, frame_time, indexed_at, arrived_at, publisher_seq, publisher_emitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(did, collection, rkey) DO UPDATE SET
           seq=excluded.seq, commit_cid=excluded.commit_cid, rev=excluded.rev,
           op_cid=excluded.op_cid, record_json=excluded.record_json, sig_ok=excluded.sig_ok,
           frame_time=excluded.frame_time, indexed_at=excluded.indexed_at, arrived_at=excluded.arrived_at,
           publisher_seq=excluded.publisher_seq, publisher_emitted_at=excluded.publisher_emitted_at
         WHERE excluded.seq >= latest_record.seq`,
      )
      .run(
        r.did,
        r.collection,
        r.rkey,
        r.seq,
        r.commitCid,
        r.rev,
        r.opCid,
        r.recordJson,
        r.sigOk ? 1 : 0,
        r.frameTime,
        r.indexedAt,
        r.arrivedAt,
        r.publisherSeq,
        r.publisherEmittedAt,
      );
  }

  latestRecords(): GlobalRecord[] {
    const rows = this.db
      .prepare(
        `SELECT did, collection, rkey, seq, commit_cid, rev, NULL AS op_action, op_cid, record_json, sig_ok, frame_time, indexed_at, arrived_at, publisher_seq, publisher_emitted_at
         FROM latest_record ORDER BY did, collection, rkey`,
      )
      .all() as unknown as GlobalRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Latency samples: one row per op that arrived back via the global firehose
   * carrying the in-band (did, seq, emittedAt) correlation fields. Two delays,
   * both relative to the publisher's signed `emittedAt`:
   *   - relayDelayMs  = frame_time  - emittedAt  (relay's own stamp: pub->relay hop)
   *   - arrivalDelayMs = arrived_at - emittedAt  (our wall clock: full round trip
   *     publisher -> aggregator -> relay -> this consumer, minus relay-side lag)
   * `indexedAt` is deliberately NOT used: it is inflated during catch-up replay.
   * `live` marks frames that arrived within `liveWindowMs` of the relay stamp —
   * backfill/replay rows have arrived_at minutes behind frame_time and are
   * excluded from the live latency distribution.
   * `since` (ISO timestamp) restricts samples to rows emitted at/after it —
   * used to measure a clean window without pre-fix rows polluting percentiles.
   */
  /** Count of rows carrying the in-band correlation fields (emittedAt). */
  correlationCount(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM global_record
         WHERE publisher_seq IS NOT NULL AND publisher_emitted_at IS NOT NULL`,
      )
      .get() as { n: number };
    return row.n;
  }

  /**
   * The single freshest correlation-carrying sample (by arrived_at). Used to
   * show the TRUE current lag — how far behind wall-clock the freshest data
   * this consumer has processed actually is — which the replay-excluded live
   * distribution structurally cannot represent.
   */
  freshestCorrelationSample(): {
    did: string;
    publisherSeq: number;
    emittedAt: string;
    frameTime: string;
    arrivedAt: string;
  } | null {
    const r = this.db
      .prepare(
        `SELECT did, publisher_seq, publisher_emitted_at, frame_time, arrived_at
         FROM global_record
         WHERE publisher_seq IS NOT NULL AND publisher_emitted_at IS NOT NULL
           AND arrived_at IS NOT NULL
         ORDER BY arrived_at DESC LIMIT 1`,
      )
      .get() as
      | {
          did: string;
          publisher_seq: number;
          publisher_emitted_at: string;
          frame_time: string;
          arrived_at: string;
        }
      | undefined;
    if (!r) return null;
    return {
      did: r.did,
      publisherSeq: Number(r.publisher_seq),
      emittedAt: r.publisher_emitted_at,
      frameTime: r.frame_time,
      arrivedAt: r.arrived_at,
    };
  }

  latencySamples(liveWindowMs = 60_000, since?: string): Array<{
    did: string;
    publisherSeq: number;
    relayDelayMs: number;
    arrivalDelayMs: number | null;
    frameTime: string;
    arrivedAt: string | null;
    live: boolean;
  }> {
    const rows = (
      since
        ? this.db
            .prepare(
              `SELECT did, publisher_seq, publisher_emitted_at, frame_time, arrived_at
               FROM global_record
               WHERE publisher_seq IS NOT NULL AND publisher_emitted_at IS NOT NULL
                 AND publisher_emitted_at >= ?
               ORDER BY did, publisher_seq`,
            )
            .all(since)
        : this.db
            .prepare(
              `SELECT did, publisher_seq, publisher_emitted_at, frame_time, arrived_at
               FROM global_record
               WHERE publisher_seq IS NOT NULL AND publisher_emitted_at IS NOT NULL
               ORDER BY did, publisher_seq`,
            )
            .all()
    ) as Array<{
        did: string;
        publisher_seq: number;
        publisher_emitted_at: string;
        frame_time: string;
        arrived_at: string | null;
      }>;
    const out: Array<{
      did: string;
      publisherSeq: number;
      relayDelayMs: number;
      arrivalDelayMs: number | null;
      frameTime: string;
      arrivedAt: string | null;
      live: boolean;
    }> = [];
    for (const r of rows) {
      const emitted = Date.parse(r.publisher_emitted_at);
      const frame = Date.parse(r.frame_time);
      if (Number.isNaN(emitted) || Number.isNaN(frame)) continue;
      const arrived = r.arrived_at == null ? null : Date.parse(r.arrived_at);
      const arrivalDelayMs = arrived == null || Number.isNaN(arrived) ? null : arrived - emitted;
      const live = arrived != null && !Number.isNaN(arrived) && arrived - frame <= liveWindowMs;
      out.push({
        did: r.did,
        publisherSeq: Number(r.publisher_seq),
        relayDelayMs: frame - emitted,
        arrivalDelayMs,
        frameTime: r.frame_time,
        arrivedAt: r.arrived_at,
        live,
      });
    }
    return out;
  }

  /**
   * Backfill publisher_seq / publisher_emitted_at by re-parsing record_json.
   * The correlation fields live INSIDE the decoded record as `seq`/`emittedAt`;
   * rows indexed before the extraction fix have NULL columns despite valid JSON.
   * Returns the number of rows updated. Idempotent.
   */
  backfillCorrelationFields(): number {
    const rows = this.db
      .prepare(
        `SELECT rowid, record_json FROM global_record
         WHERE (publisher_seq IS NULL OR publisher_emitted_at IS NULL) AND record_json IS NOT NULL`,
      )
      .all() as Array<{ rowid: number; record_json: string }>;
    const update = this.db.prepare(
      `UPDATE global_record SET publisher_seq = ?, publisher_emitted_at = ? WHERE rowid = ?`,
    );
    let n = 0;
    for (const r of rows) {
      try {
        const rec = JSON.parse(r.record_json) as Record<string, unknown>;
        const seq = typeof rec.seq === 'number' && Number.isFinite(rec.seq) ? rec.seq : null;
        const emittedAt = typeof rec.emittedAt === 'string' ? rec.emittedAt : null;
        if (seq != null || emittedAt != null) {
          update.run(seq, emittedAt, r.rowid);
          n += 1;
        }
      } catch {
        /* unparseable JSON: leave NULL */
      }
    }
    // Same for the latest-per-rkey view.
    const latest = this.db
      .prepare(
        `SELECT rowid, record_json FROM latest_record
         WHERE (publisher_seq IS NULL OR publisher_emitted_at IS NULL) AND record_json IS NOT NULL`,
      )
      .all() as Array<{ rowid: number; record_json: string }>;
    const updateLatest = this.db.prepare(
      `UPDATE latest_record SET publisher_seq = ?, publisher_emitted_at = ? WHERE rowid = ?`,
    );
    for (const r of latest) {
      try {
        const rec = JSON.parse(r.record_json) as Record<string, unknown>;
        const seq = typeof rec.seq === 'number' && Number.isFinite(rec.seq) ? rec.seq : null;
        const emittedAt = typeof rec.emittedAt === 'string' ? rec.emittedAt : null;
        if (seq != null || emittedAt != null) updateLatest.run(seq, emittedAt, r.rowid);
      } catch {
        /* leave NULL */
      }
    }
    return n;
  }

  recentEvents(limit = 200): GlobalRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM global_record ORDER BY seq DESC LIMIT ?')
      .all(limit) as unknown as GlobalRow[];
    return rows.map(rowToRecord);
  }

  eventCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM global_record').get() as { n: number };
    return Number(row.n);
  }

  distinctDids(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT did FROM latest_record ORDER BY did').all() as Array<{ did: string }>;
    return rows.map((r) => r.did);
  }

  /**
   * Reconciliation support (KILL-RAW-FIREHOSE §"Failure modes"): does the live
   * view already hold this (did, collection, rkey)? The sweep calls this to tell
   * whether a record that exists at the source PDS was ever notified+indexed via
   * Jetstream; a source record with no local row is a Jetstream drop-by-omission.
   */
  hasLatest(did: string, collection: string, rkey: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM latest_record WHERE did = ? AND collection = ? AND rkey = ? LIMIT 1')
      .get(did, collection, rkey) as { 1: number } | undefined;
    return row != null;
  }

  maxSeq(): number {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM global_record').get() as { m: number | null };
    return row.m == null ? 0 : Number(row.m);
  }

  // --- cursor ----------------------------------------------------------------

  /** -1 = never connected (first connect must be at the LIVE TIP: no cursor). */
  getCursor(host: string): number {
    const row = this.db.prepare('SELECT cursor FROM relay_cursor WHERE host = ?').get(host) as
      | { cursor: number }
      | undefined;
    return row ? Number(row.cursor) : -1;
  }

  setCursor(host: string, cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO relay_cursor (host, cursor) VALUES (?, ?)
         ON CONFLICT(host) DO UPDATE SET cursor = excluded.cursor`,
      )
      .run(host, cursor);
  }

  // --- stats + rejections ----------------------------------------------------

  bumpStat(key: string, by = 1): void {
    this.db
      .prepare(
        `INSERT INTO stat (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = value + ?`,
      )
      .run(key, by, by);
  }

  getStat(key: string): number {
    const row = this.db.prepare('SELECT value FROM stat WHERE key = ?').get(key) as { value: number } | undefined;
    return row ? Number(row.value) : 0;
  }

  recordRejection(r: { at: string; did: string; seq: number | null; rev: string | null; commitCid: string | null; reason: string }): void {
    this.db
      .prepare('INSERT INTO rejection (at, did, seq, rev, commit_cid, reason) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.at, r.did, r.seq, r.rev, r.commitCid, r.reason);
    this.bumpStat('commits_rejected');
  }

  recentRejections(limit = 100): Array<{ at: string; did: string; seq: number | null; rev: string | null; commitCid: string | null; reason: string }> {
    const rows = this.db
      .prepare('SELECT at, did, seq, rev, commit_cid, reason FROM rejection ORDER BY rowid DESC LIMIT ?')
      .all(limit) as Array<{ at: string; did: string; seq: number | null; rev: string | null; commit_cid: string | null; reason: string }>;
    return rows.map((r) => ({ at: r.at, did: r.did, seq: r.seq, rev: r.rev, commitCid: r.commit_cid, reason: r.reason }));
  }

  // --- retention (REDESIGN-TASK §2) ------------------------------------------
  //
  // `global_record` is the append-only event log (the unbounded grower);
  // `latest_record` is the bounded latest-per-rkey view; `rejection` is a log.
  // Age-prune global_record + rejection on indexed_at / at; size-prune
  // global_record oldest-first, then rejection. latest_record is never pruned
  // by size (it is the live view and stays small by construction).

  retentionLabel(): string {
    return 'global-index';
  }

  sizeInBytes(): number {
    const row = this.db
      .prepare(
        `SELECT (SELECT COALESCE(SUM(LENGTH(record_json)), 0) FROM global_record)
              + (SELECT COALESCE(SUM(LENGTH(record_json)), 0) FROM latest_record)
              + (SELECT COALESCE(SUM(LENGTH(reason)), 0) FROM rejection) AS n`,
      )
      .get() as { n: number };
    return Number(row.n);
  }

  pruneOlderThan(olderThanIso: string, batchCap: number): number {
    const ev = this.db
      .prepare(
        `DELETE FROM global_record WHERE rowid IN (
           SELECT rowid FROM global_record WHERE indexed_at < ? ORDER BY seq ASC LIMIT ?)`,
      )
      .run(olderThanIso, batchCap);
    const rej = this.db
      .prepare(
        `DELETE FROM rejection WHERE rowid IN (
           SELECT rowid FROM rejection WHERE at < ? ORDER BY rowid ASC LIMIT ?)`,
      )
      .run(olderThanIso, batchCap);
    return Number(ev.changes) + Number(rej.changes);
  }

  pruneToBytes(maxBytes: number, batchCap: number): number {
    let pruned = 0;
    while (this.sizeInBytes() > maxBytes) {
      const info = this.db
        .prepare(
          'DELETE FROM global_record WHERE rowid IN (SELECT rowid FROM global_record ORDER BY seq ASC LIMIT ?)',
        )
        .run(batchCap);
      const n = Number(info.changes);
      pruned += n;
      if (n < batchCap) {
        // Event log exhausted; trim the rejection log before giving up.
        const rej = this.db
          .prepare('DELETE FROM rejection WHERE rowid IN (SELECT rowid FROM rejection ORDER BY rowid ASC LIMIT ?)')
          .run(batchCap);
        const rn = Number(rej.changes);
        pruned += rn;
        if (rn < batchCap) break;
      }
    }
    return pruned;
  }

  close(): void {
    this.db.close();
  }
}

interface GlobalRow {
  seq: number;
  commit_cid: string;
  did: string;
  rev: string;
  op_action: string | null;
  collection: string;
  rkey: string;
  op_cid: string | null;
  record_json: string | null;
  sig_ok: number;
  frame_time: string;
  indexed_at: string;
  arrived_at: string | null;
  publisher_seq: number | null;
  publisher_emitted_at: string | null;
}

function rowToRecord(r: GlobalRow): GlobalRecord {
  return {
    seq: Number(r.seq),
    commitCid: r.commit_cid,
    did: r.did,
    rev: r.rev,
    opAction: r.op_action ?? 'latest',
    collection: r.collection,
    rkey: r.rkey,
    opCid: r.op_cid,
    recordJson: r.record_json,
    sigOk: r.sig_ok === 1,
    frameTime: r.frame_time,
    indexedAt: r.indexed_at,
    arrivedAt: r.arrived_at ?? '',
    publisherSeq: r.publisher_seq == null ? null : Number(r.publisher_seq),
    publisherEmittedAt: r.publisher_emitted_at,
  };
}
