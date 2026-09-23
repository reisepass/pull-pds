import { selfEndpointFromEnv } from '../config.js';
import { DEFAULT_ALLOWED_COLLECTIONS, BLOCKED_NAMESPACES, isBlockedCollection } from '../collections.js';
import { log } from '../log.js';

/**
 * Pull-PDS configuration (SPEC.md). Read from the environment with defensible
 * defaults; `SELF_ENDPOINT` must be set for any real deployment.
 *
 * Env naming: `PDS_*` is canonical. The legacy `AGG_*` names
 * (`AGG_SIGNING_KEY`, `AGG_DID`) from before the pds-websub rename are still
 * honoured as deprecated aliases so live deployments keep booting; a one-line
 * deprecation warning is logged when an old name is used.
 */
export interface PdsConfig {
  /** The PDS's public https URL; must equal each doc's #atproto_pds. */
  selfEndpoint: string;
  /** The PDS's own DID (did:web on its own hostname). */
  pdsDid: string;
  /** NSIDs a feed record may use (spec §9 collection allowlist). */
  allowedCollections: string[];
  /** Only snapshot is implemented; other values are rejected. */
  ingestMode: 'snapshot' | 'oplog';
  /** Per-feed size cap in bytes (spec §5 step 4). */
  maxFeedBytes: number;
  /** Per-origin ping debounce in seconds (spec §4/§9). */
  minPingIntervalSec: number;
  /** Only shared signing is implemented; per-publisher is rejected. */
  keyMode: 'shared' | 'per-publisher';
  /** Must be zero: DID documents are resolved on every ingest. */
  didDocTtlSec: number;
  /** Must be empty: crawler registration is an explicit operator action. */
  pdsCrawlers: string[];
  /** HTTPS fetch timeout for feed + did.json (ms). */
  fetchTimeoutMs: number;
  /** Max records permitted in one repo (spec §9). */
  maxRecordsPerRepo: number;
  /** Directory for per-repo SQLite files; ':memory:' in tests. */
  dataDir: string;
}

export function pdsConfigFromEnv(
  overrides: Partial<PdsConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): PdsConfig {
  const selfEndpoint = selfEndpointFromEnv(env);
  const config: PdsConfig = {
    selfEndpoint,
    pdsDid: envAlias(env, 'PDS_DID', 'AGG_DID') ?? derivePdsDid(selfEndpoint),
    allowedCollections: splitList(env.ALLOWED_COLLECTIONS) ?? [...DEFAULT_ALLOWED_COLLECTIONS],
    ingestMode: (env.INGEST_MODE?.trim() as 'snapshot' | 'oplog') || 'snapshot',
    maxFeedBytes: numEnv(env.MAX_FEED_BYTES, 1_048_576),
    minPingIntervalSec: numEnv(env.MIN_PING_INTERVAL_SEC, 60),
    keyMode: (env.KEY_MODE?.trim() as 'shared' | 'per-publisher') || 'shared',
    didDocTtlSec: numEnv(env.DID_DOC_TTL_SEC, 0),
    pdsCrawlers: splitList(env.PDS_CRAWLERS) ?? [],
    fetchTimeoutMs: numEnv(env.FETCH_TIMEOUT_MS, 5_000),
    maxRecordsPerRepo: numEnv(env.MAX_RECORDS_PER_REPO, 10_000),
    dataDir: env.DATA_DIR?.trim() || ':memory:',
    ...overrides,
  };
  validatePdsConfig(config);
  return config;
}

/** did:web:<host> from an https endpoint (bare-host did:web, spec §2). */
function derivePdsDid(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    return `did:web:${u.host}`;
  } catch {
    return 'did:web:pds.example.invalid';
  }
}

/**
 * Read the canonical env name, falling back to the deprecated legacy name.
 * Logs a one-line deprecation warning when the legacy name is the one in use.
 */
function envAlias(env: NodeJS.ProcessEnv, canonical: string, legacy: string): string | undefined {
  const c = env[canonical]?.trim();
  if (c) return c;
  const l = env[legacy]?.trim();
  if (l) {
    log.warn(`${legacy} is deprecated - renamed to ${canonical}; the old name still works but will be removed in a future release`);
    return l;
  }
  return undefined;
}

function splitList(v?: string): string[] | undefined {
  if (!v) return undefined;
  const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : undefined;
}

function numEnv(v: string | undefined, dflt: number): number {
  if (!v) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('Numeric configuration must be a finite number.');
  return n;
}

/** Refuse advertised features that the server cannot actually provide. */
export function validatePdsConfig(config: PdsConfig): void {
  if (config.keyMode !== 'shared') throw new Error('Only KEY_MODE=shared is implemented.');
  if (config.ingestMode !== 'snapshot') throw new Error('Only INGEST_MODE=snapshot is implemented.');
  if (config.didDocTtlSec !== 0) throw new Error('DID_DOC_TTL_SEC must be 0; identity documents are resolved on every ingest.');
  if (config.pdsCrawlers.length) throw new Error('Automatic PDS_CRAWLERS registration is not implemented; request crawling explicitly.');
  for (const [name, value] of Object.entries({ maxFeedBytes: config.maxFeedBytes, fetchTimeoutMs: config.fetchTimeoutMs, maxRecordsPerRepo: config.maxRecordsPerRepo })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  }
  if (!Number.isFinite(config.minPingIntervalSec) || config.minPingIntervalSec < 0) throw new Error('minPingIntervalSec must be nonnegative.');
  const blocked = config.allowedCollections.filter(isBlockedCollection);
  if (blocked.length) {
    throw new Error(`ALLOWED_COLLECTIONS may not include ${blocked.join(', ')}: a Pull-PDS never accepts ${BLOCKED_NAMESPACES.join(' ')} records.`);
  }
}
