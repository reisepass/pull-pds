import { DatabaseSync } from 'node:sqlite';
import { registrableDomain } from '../identity/registrable.js';
import type { EtagStore, SeenStore } from './ingest.js';
import type { AdmissionStore } from '../policy/admission.js';
import type { SubscriptionStore } from '../websub/hub.js';

/**
 * Cross-repo PDS metadata (one small SQLite DB, separate from the
 * per-repo block stores). Holds everything the ingest path needs that is not
 * repo blocks:
 *   - last-ingested ETag per DID (spec §5 step 4/10),
 *   - which DIDs have been ingested before (first-ingest firehose),
 *   - the eTLD+1 -> DID bindings + new-DID timestamps (admission),
 *   - the DID denylist (kill switch, spec §9),
 *   - repo status (active/deactivated) for getRepoStatus + listRepos.
 *
 * Implements EtagStore, SeenStore, and AdmissionStore so it drops straight into
 * the pipeline and the admission policy.
 */
export class MetaStore implements EtagStore, SeenStore, AdmissionStore, SubscriptionStore {
  private readonly db: DatabaseSync;

  constructor(location = ':memory:') {
    this.db = new DatabaseSync(location);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS repo_meta (
        did          TEXT PRIMARY KEY,
        etag         TEXT,
        first_seen   INTEGER,
        active       INTEGER NOT NULL DEFAULT 1,
        status       TEXT,
        registrable  TEXT
      );
      CREATE INDEX IF NOT EXISTS repo_meta_reg_idx ON repo_meta(registrable);

      CREATE TABLE IF NOT EXISTS new_did_event (
        did          TEXT NOT NULL,
        registrable  TEXT NOT NULL,
        ts           INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS new_did_ts_idx ON new_did_event(ts);

      CREATE TABLE IF NOT EXISTS denylist (
        did TEXT PRIMARY KEY
      );

      -- WebSub subscription leases (A8): persisted so they survive a restart.
      CREATE TABLE IF NOT EXISTS websub_subscription (
        callback   TEXT NOT NULL,
        topic      TEXT NOT NULL,
        secret     TEXT,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (callback, topic)
      );
    `);
  }

  // --- SubscriptionStore (WebSub A8) ------------------------------------------

  upsert(sub: { callback: string; topic: string; secret?: string; expiresAt: number }): void {
    this.db
      .prepare(
        `INSERT INTO websub_subscription (callback, topic, secret, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(callback, topic) DO UPDATE SET secret = excluded.secret, expires_at = excluded.expires_at`,
      )
      .run(sub.callback, sub.topic, sub.secret ?? null, sub.expiresAt);
  }

  remove(callback: string, topic: string): void {
    this.db.prepare('DELETE FROM websub_subscription WHERE callback = ? AND topic = ?').run(callback, topic);
  }

  all(): Array<{ callback: string; topic: string; secret?: string; expiresAt: number }> {
    const rows = this.db
      .prepare('SELECT callback, topic, secret, expires_at FROM websub_subscription')
      .all() as Array<{ callback: string; topic: string; secret: string | null; expires_at: number }>;
    return rows.map((r) => {
      const sub: { callback: string; topic: string; secret?: string; expiresAt: number } = {
        callback: r.callback,
        topic: r.topic,
        expiresAt: Number(r.expires_at),
      };
      if (r.secret != null) sub.secret = r.secret;
      return sub;
    });
  }

  // --- EtagStore ------------------------------------------------------------

  get(did: string): string | null {
    const row = this.db.prepare('SELECT etag FROM repo_meta WHERE did = ?').get(did) as
      | { etag: string | null }
      | undefined;
    return row?.etag ?? null;
  }

  set(did: string, etag: string): void {
    this.db
      .prepare(
        `INSERT INTO repo_meta (did, etag) VALUES (?, ?)
         ON CONFLICT(did) DO UPDATE SET etag = excluded.etag`,
      )
      .run(did, etag);
  }

  // --- SeenStore ------------------------------------------------------------

  has(did: string): boolean {
    const row = this.db.prepare('SELECT first_seen FROM repo_meta WHERE did = ?').get(did) as
      | { first_seen: number | null }
      | undefined;
    return row?.first_seen != null;
  }

  add(did: string): void {
    const now = Date.now();
    const reg = registrableDomain(hostFromDid(did)) ?? '';
    // Was the DID already recorded (e.g. by reserveNewDid)? If so we only stamp
    // first_seen and must NOT insert a second rate-limit event (F-5: the reserve
    // already counted it). If it is brand new (no reservation path), we insert
    // the row and the rate event here.
    const existed = this.db.prepare('SELECT 1 FROM repo_meta WHERE did = ?').get(did) !== undefined;
    this.db
      .prepare(
        `INSERT INTO repo_meta (did, first_seen, registrable, active) VALUES (?, ?, ?, 1)
         ON CONFLICT(did) DO UPDATE SET first_seen = COALESCE(repo_meta.first_seen, excluded.first_seen),
                                        registrable = excluded.registrable`,
      )
      .run(did, now, reg);
    if (!existed) {
      this.db.prepare('INSERT INTO new_did_event (did, registrable, ts) VALUES (?, ?, ?)').run(did, reg, now);
    }
  }

  /**
   * Atomically reserve a slot for a *new* DID under its registrable domain's cap
   * (FINDINGS F-5). The read-only `admitWrite` cap check is optimistic and
   * TOCTOU-racy: two new DIDs on one domain can both pass it before either is
   * recorded. This method does the count-and-insert in a single SQLite
   * transaction, so the cap is enforced exactly. Returns true if the slot was
   * granted (or the DID was already recorded - idempotent for retries), false if
   * granting it would exceed `cap`.
   *
   * `first_seen` is left null here; `add()` (called after a successful first
   * commit) stamps it. Reservation only claims the domain slot + records the
   * rate-limit event, so a reserved-but-not-yet-committed DID still counts
   * against the cap and cannot be double-spent by a concurrent ingest.
   */
  reserveNewDid(did: string, registrable: string, cap: number): boolean {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const already = this.db.prepare('SELECT 1 FROM repo_meta WHERE did = ?').get(did);
      if (already) {
        this.db.exec('COMMIT');
        return true; // idempotent
      }
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM repo_meta WHERE registrable = ?')
        .get(registrable) as { n: number };
      if (Number(row.n) >= cap) {
        this.db.exec('ROLLBACK');
        return false;
      }
      this.db
        .prepare('INSERT INTO repo_meta (did, registrable, active) VALUES (?, ?, 1)')
        .run(did, registrable);
      this.db
        .prepare('INSERT INTO new_did_event (did, registrable, ts) VALUES (?, ?, ?)')
        .run(did, registrable, Date.now());
      this.db.exec('COMMIT');
      return true;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // --- AdmissionStore -------------------------------------------------------

  isKnownDid(did: string): boolean {
    return this.has(did);
  }

  didsForRegistrableDomain(domain: string): Set<string> {
    // Every DID bound to the domain occupies a slot, whether it has already
    // committed (first_seen set) or is merely reserved (F-5). The cap counts
    // both, so a reserved-but-uncommitted DID cannot be double-spent.
    const rows = this.db
      .prepare('SELECT did FROM repo_meta WHERE registrable = ?')
      .all(domain) as Array<{ did: string }>;
    return new Set(rows.map((r) => r.did));
  }

  isDenied(did: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM denylist WHERE did = ?').get(did);
    return row !== undefined;
  }

  recentNewDidTimestamps(domain: string): number[] {
    const rows = this.db
      .prepare('SELECT ts FROM new_did_event WHERE registrable = ? ORDER BY ts DESC LIMIT 1000')
      .all(domain) as Array<{ ts: number }>;
    return rows.map((r) => r.ts);
  }

  recentNewDidTimestampsGlobal(): number[] {
    const rows = this.db
      .prepare('SELECT ts FROM new_did_event ORDER BY ts DESC LIMIT 5000')
      .all() as Array<{ ts: number }>;
    return rows.map((r) => r.ts);
  }

  // --- denylist / status ----------------------------------------------------

  deny(did: string): void {
    this.db.prepare('INSERT OR IGNORE INTO denylist (did) VALUES (?)').run(did);
  }

  /** Mark a repo deactivated (spec §9). We keep the blocks; we stop serving it live. */
  deactivate(did: string, status = 'deactivated'): void {
    this.db
      .prepare(
        `INSERT INTO repo_meta (did, active, status) VALUES (?, 0, ?)
         ON CONFLICT(did) DO UPDATE SET active = 0, status = excluded.status`,
      )
      .run(did, status);
  }

  isActive(did: string): boolean {
    const row = this.db.prepare('SELECT active FROM repo_meta WHERE did = ?').get(did) as
      | { active: number }
      | undefined;
    return row ? row.active === 1 : true;
  }

  status(did: string): string | null {
    const row = this.db.prepare('SELECT status FROM repo_meta WHERE did = ?').get(did) as
      | { status: string | null }
      | undefined;
    return row?.status ?? null;
  }

  /** All DIDs that have been ingested at least once (for listRepos). */
  listDids(): string[] {
    const rows = this.db
      .prepare('SELECT did FROM repo_meta WHERE first_seen IS NOT NULL ORDER BY did')
      .all() as Array<{ did: string }>;
    return rows.map((r) => r.did);
  }

  close(): void {
    this.db.close();
  }
}

/** did:web:host -> host (decode a percent-encoded port if present). */
function hostFromDid(did: string): string {
  const msid = did.slice('did:web:'.length);
  const decoded = decodeURIComponent(msid);
  const colon = decoded.indexOf(':');
  return colon === -1 ? decoded : decoded.slice(0, colon);
}
