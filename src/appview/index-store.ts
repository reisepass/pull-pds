import { DatabaseSync } from 'node:sqlite';

/**
 * The AppView's index (PHASE-3 B2). A plain SQLite store of records pulled from
 * the configured PDS hosts. Every row keeps the source PDS and whether the
 * commit that carried it verified against the publishing DID's key - the AppView
 * indexes nothing it could not itself verify.
 *
 * This is deliberately a *separate* store from any aggregator's: the AppView has
 * no privileged access, it sees exactly what any third party sees over the
 * public `com.atproto.sync.*` surface.
 */
export interface IndexedRecord {
  did: string;
  collection: string;
  rkey: string;
  cid: string;
  recordJson: string;
  rev: string;
  sourcePds: string;
  sigVerified: boolean;
  indexedAt: string;
}

export class IndexStore {
  private readonly db: DatabaseSync;

  constructor(location = ':memory:') {
    this.db = new DatabaseSync(location);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS record (
        did         TEXT NOT NULL,
        collection  TEXT NOT NULL,
        rkey        TEXT NOT NULL,
        cid         TEXT NOT NULL,
        record_json TEXT NOT NULL,
        rev         TEXT NOT NULL,
        source_pds  TEXT NOT NULL,
        sig_ok      INTEGER NOT NULL,
        indexed_at  TEXT NOT NULL,
        PRIMARY KEY (did, collection, rkey)
      );
      CREATE INDEX IF NOT EXISTS record_collection_idx ON record(collection);
      CREATE INDEX IF NOT EXISTS record_source_idx ON record(source_pds);

      -- Firehose resume cursor, one row per PDS host.
      CREATE TABLE IF NOT EXISTS pds_cursor (
        host   TEXT PRIMARY KEY,
        cursor INTEGER NOT NULL
      );

      -- Counters for observability (rejected = failed signature verification).
      CREATE TABLE IF NOT EXISTS stat (
        key   TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );

      -- A log of rejected (unverifiable) commits, for the UI + the experiment.
      CREATE TABLE IF NOT EXISTS rejection (
        at         TEXT NOT NULL,
        did        TEXT NOT NULL,
        source_pds TEXT NOT NULL,
        rev        TEXT,
        reason     TEXT NOT NULL
      );
    `);
  }

  // --- records --------------------------------------------------------------

  putRecord(r: IndexedRecord): void {
    this.db
      .prepare(
        `INSERT INTO record (did, collection, rkey, cid, record_json, rev, source_pds, sig_ok, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(did, collection, rkey) DO UPDATE SET
           cid=excluded.cid, record_json=excluded.record_json, rev=excluded.rev,
           source_pds=excluded.source_pds, sig_ok=excluded.sig_ok, indexed_at=excluded.indexed_at`,
      )
      .run(r.did, r.collection, r.rkey, r.cid, r.recordJson, r.rev, r.sourcePds, r.sigVerified ? 1 : 0, r.indexedAt);
  }

  deleteRecord(did: string, collection: string, rkey: string): void {
    this.db.prepare('DELETE FROM record WHERE did = ? AND collection = ? AND rkey = ?').run(did, collection, rkey);
  }

  allRecords(): IndexedRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM record ORDER BY collection, did, rkey')
      .all() as unknown as RecordRow[];
    return rows.map(rowToRecord);
  }

  recordsForCollection(collection: string): IndexedRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM record WHERE collection = ? ORDER BY did, rkey')
      .all(collection) as unknown as RecordRow[];
    return rows.map(rowToRecord);
  }

  recordsForDid(did: string): IndexedRecord[] {
    const rows = this.db.prepare('SELECT * FROM record WHERE did = ? ORDER BY collection, rkey').all(did) as unknown as RecordRow[];
    return rows.map(rowToRecord);
  }

  getRecord(did: string, collection: string, rkey: string): IndexedRecord | null {
    const row = this.db
      .prepare('SELECT * FROM record WHERE did = ? AND collection = ? AND rkey = ?')
      .get(did, collection, rkey) as unknown as RecordRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  distinctDids(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT did FROM record ORDER BY did').all() as Array<{ did: string }>;
    return rows.map((r) => r.did);
  }

  recordCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM record').get() as { n: number };
    return Number(row.n);
  }

  // --- cursors --------------------------------------------------------------

  getCursor(host: string): number {
    const row = this.db.prepare('SELECT cursor FROM pds_cursor WHERE host = ?').get(host) as
      | { cursor: number }
      | undefined;
    return row ? Number(row.cursor) : 0;
  }

  setCursor(host: string, cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO pds_cursor (host, cursor) VALUES (?, ?)
         ON CONFLICT(host) DO UPDATE SET cursor = excluded.cursor`,
      )
      .run(host, cursor);
  }

  // --- stats + rejections ---------------------------------------------------

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

  recordRejection(r: { at: string; did: string; sourcePds: string; rev: string | null; reason: string }): void {
    this.db
      .prepare('INSERT INTO rejection (at, did, source_pds, rev, reason) VALUES (?, ?, ?, ?, ?)')
      .run(r.at, r.did, r.sourcePds, r.rev, r.reason);
    this.bumpStat('commits_rejected');
  }

  recentRejections(limit = 100): Array<{ at: string; did: string; sourcePds: string; rev: string | null; reason: string }> {
    const rows = this.db
      .prepare('SELECT at, did, source_pds, rev, reason FROM rejection ORDER BY rowid DESC LIMIT ?')
      .all(limit) as Array<{ at: string; did: string; source_pds: string; rev: string | null; reason: string }>;
    return rows.map((r) => ({ at: r.at, did: r.did, sourcePds: r.source_pds, rev: r.rev, reason: r.reason }));
  }

  // --- retention (REDESIGN-TASK §2) ------------------------------------------
  //
  // `record` is the live latest-per-rkey view (upserted in place, so it barely
  // grows); the unbounded grower is the append-only `rejection` log. Age-prune
  // both on indexed_at / at; size-prune rejections oldest-first.

  retentionLabel(): string {
    return 'appview-index';
  }

  sizeInBytes(): number {
    const row = this.db
      .prepare(
        `SELECT (SELECT COALESCE(SUM(LENGTH(record_json)), 0) FROM record)
              + (SELECT COALESCE(SUM(LENGTH(reason)), 0) FROM rejection) AS n`,
      )
      .get() as { n: number };
    return Number(row.n);
  }

  pruneOlderThan(olderThanIso: string, batchCap: number): number {
    const rej = this.db
      .prepare(
        `DELETE FROM rejection WHERE rowid IN (
           SELECT rowid FROM rejection WHERE at < ? ORDER BY rowid ASC LIMIT ?)`,
      )
      .run(olderThanIso, batchCap);
    const rec = this.db
      .prepare(
        `DELETE FROM record WHERE rowid IN (
           SELECT rowid FROM record WHERE indexed_at < ? ORDER BY indexed_at ASC LIMIT ?)`,
      )
      .run(olderThanIso, batchCap);
    return Number(rej.changes) + Number(rec.changes);
  }

  pruneToBytes(maxBytes: number, batchCap: number): number {
    let pruned = 0;
    while (this.sizeInBytes() > maxBytes) {
      const info = this.db
        .prepare('DELETE FROM rejection WHERE rowid IN (SELECT rowid FROM rejection ORDER BY rowid ASC LIMIT ?)')
        .run(batchCap);
      const n = Number(info.changes);
      pruned += n;
      if (n < batchCap) break; // rejections exhausted; live records left alone
    }
    return pruned;
  }

  close(): void {
    this.db.close();
  }
}

interface RecordRow {
  did: string;
  collection: string;
  rkey: string;
  cid: string;
  record_json: string;
  rev: string;
  source_pds: string;
  sig_ok: number;
  indexed_at: string;
}

function rowToRecord(r: RecordRow): IndexedRecord {
  return {
    did: r.did,
    collection: r.collection,
    rkey: r.rkey,
    cid: r.cid,
    recordJson: r.record_json,
    rev: r.rev,
    sourcePds: r.source_pds,
    sigVerified: r.sig_ok === 1,
    indexedAt: r.indexed_at,
  };
}
