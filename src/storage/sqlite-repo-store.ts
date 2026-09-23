import { DatabaseSync } from 'node:sqlite';
import { CID } from 'multiformats';
import { check } from '@atproto/common';
import type { RepoRecord } from '@atproto/lexicon';
import {
  BlockMap,
  ReadableBlockstore,
  cborToLexRecord,
} from '@atproto/repo';
import type { CommitData, RepoStorage } from '@atproto/repo';
import type { RepoStore, StoredBlock, StoredCommit } from './types.js';

/**
 * SQLite-backed per-repo storage (DESIGN.md open question 2: SQLite per repo).
 *
 * Extends `@atproto/repo`'s `ReadableBlockstore` so it inherits the typed read
 * helpers (`readObj`, `readRecord`, …) and satisfies the `RepoStorage`
 * interface `Repo` consumes - meaning the MST/commit machinery in `@atproto/repo`
 * writes straight through to SQLite with no adapter. We add the durable
 * commit-log rows and the root pointer on top.
 *
 * `:memory:` is used by tests; a file path is used in production. One database
 * per repo keeps the schema trivial and mirrors upstream's actor-store layout.
 */
export class SqliteRepoStorage extends ReadableBlockstore implements RepoStore {
  private readonly db: DatabaseSync;

  constructor(
    readonly did: string,
    location = ':memory:',
  ) {
    super();
    this.db = new DatabaseSync(location);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS block (
        cid   TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        rev   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS block_rev_idx ON block(rev);

      CREATE TABLE IF NOT EXISTS commit_log (
        rev             TEXT PRIMARY KEY,
        cid             TEXT NOT NULL,
        since           TEXT,
        bytes           BLOB NOT NULL,
        signing_did_key TEXT NOT NULL,
        created_seq     INTEGER,
        created_at      TEXT
      );

      CREATE TABLE IF NOT EXISTS repo_root (
        id   INTEGER PRIMARY KEY CHECK (id = 0),
        cid  TEXT NOT NULL,
        rev  TEXT NOT NULL
      );
    `);
    // Migration (REDESIGN-TASK §2): older DBs predate created_at on commit_log.
    const cols = this.db.prepare(`PRAGMA table_info(commit_log)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'created_at')) {
      this.db.exec(`ALTER TABLE commit_log ADD COLUMN created_at TEXT`);
    }
  }

  // --- root / rev -----------------------------------------------------------

  getRoot(): CID | null {
    const row = this.db.prepare('SELECT cid FROM repo_root WHERE id = 0').get() as
      | { cid: string }
      | undefined;
    return row ? CID.parse(row.cid) : null;
  }

  getRev(): string | null {
    const row = this.db.prepare('SELECT rev FROM repo_root WHERE id = 0').get() as
      | { rev: string }
      | undefined;
    return row ? row.rev : null;
  }

  // --- block reads (ReadableBlockstore contract) ----------------------------

  getBlockBytes(cid: CID): Uint8Array | null {
    const row = this.db.prepare('SELECT bytes FROM block WHERE cid = ?').get(cid.toString()) as
      | { bytes: Uint8Array }
      | undefined;
    return row ? new Uint8Array(row.bytes) : null;
  }

  override async getBytes(cid: CID): Promise<Uint8Array | null> {
    return this.getBlockBytes(cid);
  }

  hasBlock(cid: CID): boolean {
    const row = this.db.prepare('SELECT 1 FROM block WHERE cid = ?').get(cid.toString());
    return row !== undefined;
  }

  override async has(cid: CID): Promise<boolean> {
    return this.hasBlock(cid);
  }

  override async getBlocks(cids: CID[]): Promise<{ blocks: BlockMap; missing: CID[] }> {
    const blocks = new BlockMap();
    const missing: CID[] = [];
    for (const cid of cids) {
      const bytes = this.getBlockBytes(cid);
      if (bytes) blocks.set(cid, bytes);
      else missing.push(cid);
    }
    return { blocks, missing };
  }

  /**
   * Every live block in the repo. `putCommit` prunes `removedCids`, so the block
   * table holds exactly the set reachable from the current root - which is what
   * a full `getRepo` CAR export needs.
   */
  allBlocks(): BlockMap {
    const rows = this.db.prepare('SELECT cid, bytes FROM block').all() as Array<{
      cid: string;
      bytes: Uint8Array;
    }>;
    const blocks = new BlockMap();
    for (const r of rows) blocks.set(CID.parse(r.cid), new Uint8Array(r.bytes));
    return blocks;
  }

  /** Blocks written at a rev strictly greater than `sinceRev` (for getRepo since). */
  blocksSince(sinceRev: string): BlockMap {
    const rows = this.db
      .prepare('SELECT cid, bytes FROM block WHERE rev > ?')
      .all(sinceRev) as Array<{ cid: string; bytes: Uint8Array }>;
    const blocks = new BlockMap();
    for (const r of rows) blocks.set(CID.parse(r.cid), new Uint8Array(r.bytes));
    return blocks;
  }

  // --- writes ---------------------------------------------------------------

  putCommit(params: {
    root: CID;
    rev: string;
    since: string | null;
    commitCid: CID;
    signingDidKey: string;
    blocks: Iterable<StoredBlock>;
    removedCids?: Iterable<CID>;
  }): void {
    const insertBlock = this.db.prepare(
      'INSERT OR REPLACE INTO block (cid, bytes, rev) VALUES (?, ?, ?)',
    );
    const deleteBlock = this.db.prepare('DELETE FROM block WHERE cid = ?');
    const insertCommit = this.db.prepare(
      `INSERT OR REPLACE INTO commit_log (rev, cid, since, bytes, signing_did_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const upsertRoot = this.db.prepare(
      `INSERT INTO repo_root (id, cid, rev) VALUES (0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET cid = excluded.cid, rev = excluded.rev`,
    );

    this.db.exec('BEGIN');
    try {
      for (const cid of params.removedCids ?? []) {
        deleteBlock.run(cid.toString());
      }
      let commitBytes: Uint8Array | null = null;
      for (const b of params.blocks) {
        insertBlock.run(b.cid.toString(), toBuffer(b.bytes), b.rev);
        if (b.cid.equals(params.commitCid)) commitBytes = b.bytes;
      }
      if (!commitBytes) {
        // The commit block must be among the written blocks.
        throw new Error(`putCommit: commit block ${params.commitCid} not in blocks`);
      }
      insertCommit.run(
        params.rev,
        params.commitCid.toString(),
        params.since,
        toBuffer(commitBytes),
        params.signingDidKey,
        new Date().toISOString(),
      );
      upsertRoot.run(params.root.toString(), params.rev);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- commit log -----------------------------------------------------------

  getLatestCommit(): StoredCommit | null {
    const row = this.db
      .prepare(
        `SELECT rev, cid, since, bytes, signing_did_key
         FROM commit_log ORDER BY rev DESC LIMIT 1`,
      )
      .get() as unknown as CommitRow | undefined;
    return row ? rowToCommit(row) : null;
  }

  listCommits(opts: { sinceRev?: string | null } = {}): StoredCommit[] {
    const rows =
      opts.sinceRev != null
        ? (this.db
            .prepare(
              `SELECT rev, cid, since, bytes, signing_did_key
               FROM commit_log WHERE rev > ? ORDER BY rev ASC`,
            )
            .all(opts.sinceRev) as unknown as CommitRow[])
        : (this.db
            .prepare(
              `SELECT rev, cid, since, bytes, signing_did_key
               FROM commit_log ORDER BY rev ASC`,
            )
            .all() as unknown as CommitRow[]);
    return rows.map(rowToCommit);
  }

  sizeInBytes(): number {
    const row = this.db.prepare('SELECT COALESCE(SUM(LENGTH(bytes)), 0) AS n FROM block').get() as {
      n: number;
    };
    return Number(row.n);
  }

  // --- retention (REDESIGN-TASK §2) ------------------------------------------
  //
  // A repo's `block` table is the LIVE MST (blocks of superseded commits are
  // deleted on each putCommit), so it must never be retention-pruned — only the
  // append-only `commit_log` history grows unbounded and is prunable. Age uses
  // `created_at`; rows that predate the column count as old and are pruned
  // first. Size pruning drops the oldest commit-log rows until the whole DB
  // (blocks included) fits the budget.

  retentionLabel(): string {
    return `repo ${this.did}`;
  }

  pruneOlderThan(olderThanIso: string, batchCap: number): number {
    const info = this.db
      .prepare(
        `DELETE FROM commit_log WHERE rev IN (
           SELECT rev FROM commit_log
           WHERE created_at IS NULL OR created_at < ?
           ORDER BY rev ASC LIMIT ?)`,
      )
      .run(olderThanIso, batchCap);
    return Number(info.changes);
  }

  pruneToBytes(maxBytes: number, batchCap: number): number {
    let pruned = 0;
    // Bounded loop: delete oldest commit-log batches until the DB fits or the
    // log is empty. Blocks (the live repo) are never touched.
    while (this.dbSizeInBytes() > maxBytes) {
      const info = this.db
        .prepare(
          `DELETE FROM commit_log WHERE rev IN (
             SELECT rev FROM commit_log ORDER BY rev ASC LIMIT ?)`,
        )
        .run(batchCap);
      const n = Number(info.changes);
      pruned += n;
      if (n < batchCap) break; // log exhausted
    }
    return pruned;
  }

  /** Live blocks + retained commit history (what the 0.5 GB budget governs). */
  private dbSizeInBytes(): number {
    const row = this.db
      .prepare(
        `SELECT (SELECT COALESCE(SUM(LENGTH(bytes)), 0) FROM block)
              + (SELECT COALESCE(SUM(LENGTH(bytes)), 0) FROM commit_log) AS n`,
      )
      .get() as { n: number };
    return Number(row.n);
  }

  // --- @atproto/repo RepoStorage write surface ------------------------------
  // These let the SqliteRepoStorage be handed directly to Repo.create/load.

  async putBlock(cid: CID, block: Uint8Array, rev: string): Promise<void> {
    this.db
      .prepare('INSERT OR REPLACE INTO block (cid, bytes, rev) VALUES (?, ?, ?)')
      .run(cid.toString(), toBuffer(block), rev);
  }

  async putMany(blocks: BlockMap, rev: string): Promise<void> {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO block (cid, bytes, rev) VALUES (?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      blocks.forEach((bytes, cid) => {
        stmt.run(cid.toString(), toBuffer(bytes), rev);
      });
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  async updateRoot(cid: CID, rev: string): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO repo_root (id, cid, rev) VALUES (0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET cid = excluded.cid, rev = excluded.rev`,
      )
      .run(cid.toString(), rev);
  }

  async applyCommit(commit: CommitData): Promise<void> {
    const blocks: StoredBlock[] = [];
    commit.newBlocks.forEach((bytes, cid) => {
      blocks.push({ cid, bytes, rev: commit.rev });
    });
    // Fall back to did on the repo; the signing key is recorded by higher layers
    // when known. Here we only have the CommitData, so store the repo did:key
    // slot empty-safe via a sentinel the caller can overwrite through putCommit.
    this.putCommit({
      root: commit.cid,
      rev: commit.rev,
      since: commit.since,
      commitCid: commit.cid,
      signingDidKey: '',
      blocks,
      removedCids: commit.removedCids.toList(),
    });
  }

  // --- typed record reads ---------------------------------------------------

  override async attemptReadRecord(cid: CID): Promise<RepoRecord | null> {
    const bytes = this.getBlockBytes(cid);
    if (!bytes) return null;
    try {
      return cborToLexRecord(bytes);
    } catch {
      return null;
    }
  }

  override async readRecord(cid: CID): Promise<RepoRecord> {
    const rec = await this.attemptReadRecord(cid);
    if (!rec) throw new Error(`Record not found: ${cid.toString()}`);
    return rec;
  }

  /**
   * View this store as an `@atproto/repo` `RepoStorage`. The interfaces collide
   * only on `getRoot()`'s sync-vs-async return; at runtime awaiting a sync CID
   * is a no-op, and every write method already satisfies `RepoStorage`. This
   * accessor localises the one unavoidable cast rather than sprinkling it.
   */
  asRepoStorage(): RepoStorage {
    return this as unknown as RepoStorage;
  }

  close(): void {
    this.db.close();
  }

  /** Escape hatch for the check.Def typed reads inherited from ReadableBlockstore. */
  async readObjMaybe<T>(cid: CID, def: check.Def<T>): Promise<T | null> {
    const got = await this.attemptRead(cid, def);
    return got ? got.obj : null;
  }
}

interface CommitRow {
  rev: string;
  cid: string;
  since: string | null;
  bytes: Uint8Array;
  signing_did_key: string;
}

function rowToCommit(row: CommitRow): StoredCommit {
  return {
    rev: row.rev,
    cid: CID.parse(row.cid),
    since: row.since,
    bytes: new Uint8Array(row.bytes),
    signingDidKey: row.signing_did_key,
  };
}

/** node:sqlite wants a Buffer/Uint8Array for BLOB binds; normalize. */
function toBuffer(bytes: Uint8Array): Uint8Array {
  return bytes;
}
