import { DatabaseSync } from 'node:sqlite';
import type { SequencedEvent, SequencerStore } from './types.js';

/**
 * SQLite-backed durable firehose cursor (NEXT-TASK step 4: durable, monotonic,
 * cursor-resumable). `seq` is an AUTOINCREMENT integer primary key, so it is
 * monotonic across restarts and never reused even after deletes - exactly the
 * guarantee `subscribeRepos` consumers rely on for resumption.
 *
 * This is the shared, cross-repo event log (the firehose is per-server, not
 * per-repo), so it lives in its own database.
 */
export class SqliteSequencerStore implements SequencerStore {
  private readonly db: DatabaseSync;

  constructor(location = ':memory:') {
    this.db = new DatabaseSync(location);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event (
        seq     INTEGER PRIMARY KEY AUTOINCREMENT,
        did     TEXT NOT NULL,
        type    TEXT NOT NULL,
        payload BLOB NOT NULL
      );
    `);
    // Migration (REDESIGN-TASK §2): older DBs predate created_at on event.
    const cols = this.db.prepare(`PRAGMA table_info(event)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'created_at')) {
      this.db.exec(`ALTER TABLE event ADD COLUMN created_at TEXT`);
    }
  }

  append(evt: { did: string; type: string; payload: Uint8Array }): number {
    const info = this.db
      .prepare('INSERT INTO event (did, type, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(evt.did, evt.type, evt.payload, new Date().toISOString());
    return Number(info.lastInsertRowid);
  }

  currentSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS n FROM event').get() as {
      n: number;
    };
    return Number(row.n);
  }

  readSince(cursor: number, limit: number): SequencedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT seq, did, type, payload FROM event
         WHERE seq > ? ORDER BY seq ASC LIMIT ?`,
      )
      .all(cursor, limit) as Array<{
      seq: number;
      did: string;
      type: string;
      payload: Uint8Array;
    }>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      did: r.did,
      type: r.type,
      payload: new Uint8Array(r.payload),
    }));
  }

  /**
   * Filtered read (REDESIGN-TASK §3): only frames whose CBOR payload mentions
   * one of the wanted collections. The filter runs in SQL over the (small,
   * per-aggregator) event table, so a filtered subscriber never scans the full
   * stream — this is the cheap alternative to one VM consuming the raw global
   * firehose.
   */
  readSinceFiltered(cursor: number, limit: number, wantedCollections: string[]): SequencedEvent[] {
    if (wantedCollections.length === 0) return [];
    // `instr(payload, ?) > 0` is a BINARY substring match on the DAG-CBOR frame:
    // the collection NSID is encoded as a contiguous definite-length text string
    // inside the ops path ("<collection>/<rkey>"), so it appears as raw bytes.
    const clauses = wantedCollections.map(() => `instr(payload, ?) > 0`).join(' OR ');
    const params = wantedCollections.map((c) => Buffer.from(`${c}/`, 'utf8'));
    const rows = this.db
      .prepare(
        `SELECT seq, did, type, payload FROM event
         WHERE seq > ? AND (${clauses}) ORDER BY seq ASC LIMIT ?`,
      )
      .all(cursor, ...params, limit) as Array<{
      seq: number;
      did: string;
      type: string;
      payload: Uint8Array;
    }>;
    return rows.map((r) => ({
      seq: Number(r.seq),
      did: r.did,
      type: r.type,
      payload: new Uint8Array(r.payload),
    }));
  }

  // --- retention (REDESIGN-TASK §2) ------------------------------------------
  //
  // The event table is the durable firehose backfill log — replayable history,
  // not live state — so both age and size pruning are safe: consumers behind the
  // prune horizon simply resync at the live tip. Age uses `created_at`; rows
  // that predate the column count as old.

  retentionLabel(): string {
    return 'sequencer';
  }

  sizeInBytes(): number {
    const row = this.db
      .prepare('SELECT COALESCE(SUM(LENGTH(payload)), 0) AS n FROM event')
      .get() as { n: number };
    return Number(row.n);
  }

  pruneOlderThan(olderThanIso: string, batchCap: number): number {
    const info = this.db
      .prepare(
        `DELETE FROM event WHERE seq IN (
           SELECT seq FROM event
           WHERE created_at IS NULL OR created_at < ?
           ORDER BY seq ASC LIMIT ?)`,
      )
      .run(olderThanIso, batchCap);
    return Number(info.changes);
  }

  pruneToBytes(maxBytes: number, batchCap: number): number {
    let pruned = 0;
    while (this.sizeInBytes() > maxBytes) {
      const info = this.db
        .prepare('DELETE FROM event WHERE seq IN (SELECT seq FROM event ORDER BY seq ASC LIMIT ?)')
        .run(batchCap);
      const n = Number(info.changes);
      pruned += n;
      if (n < batchCap) break;
    }
    return pruned;
  }

  close(): void {
    this.db.close();
  }
}
