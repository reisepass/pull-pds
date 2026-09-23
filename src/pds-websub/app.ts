import { join } from 'node:path';
import { SqliteRepoStorage } from '../storage/sqlite-repo-store.js';
import { SqliteSequencerStore } from '../storage/sqlite-sequencer-store.js';
import { RepoManager } from '../repo/repo-manager.js';
import { Sequencer } from '../firehose/sequencer.js';
import { FirehoseService } from '../firehose/service.js';
import { loadSharedPdsKey, type PdsKey } from '../repo/signing-key.js';
import { IngestPipeline } from './ingest.js';
import { buildRecordValidator } from './lexicon-validate.js';
import { validatePdsConfig, type PdsConfig } from './config.js';
import { MetaStore } from './meta-store.js';
import { admitWrite } from '../policy/admission.js';
import { registrableDomain } from '../identity/registrable.js';
import { DEFAULT_ADMISSION_CONFIG, type ResolverConfig, DEFAULT_RESOLVER_CONFIG } from '../config.js';
import { defaultResolverDeps } from '../identity/didweb.js';
import { log } from '../log.js';
import { startRetentionPruner, type PrunableStore } from '../retention.js';

/**
 * The wired PDS: owns the shared sequencer/firehose, the per-repo manager
 * cache, the metadata store, and the ingest pipeline. Everything the HTTP + WS
 * server needs hangs off this. Constructed once at boot.
 *
 * Per-DID ingest is serialised through a promise chain (`ingestLocks`) so two
 * simultaneous pings for the same DID cannot interleave into a corrupt repo or a
 * duplicate rev (the concurrency requirement in OVERNIGHT §3). Different DIDs
 * proceed in parallel.
 */
/** One entry in the recent-ingest ring buffer (for the /ingest-log UI). */
export interface IngestLogEntry {
  at: string;
  topicUrl: string;
  did: string;
  status: string;
  code?: string;
  message?: string;
  rev?: string;
  ops?: number;
}

export class Pds {
  private readonly managers = new Map<string, RepoManager>();
  private readonly ingestLocks = new Map<string, Promise<unknown>>();
  /** Bounded most-recent-first log of ingest attempts, incl. rejections. */
  private readonly ingestLog: IngestLogEntry[] = [];
  private static readonly INGEST_LOG_MAX = 200;
  /** Wall-clock boot time (for uptime). Set in create(). */
  bootedAtMs = 0;
  /** Count of commits ever emitted (cheap; the firehose seq is authoritative). */
  private commitCount = 0;

  /** Most-recent-first snapshot of the ingest log. */
  recentIngests(): IngestLogEntry[] {
    return this.ingestLog.slice();
  }

  totalCommits(): number {
    return this.commitCount;
  }

  lastIngestAt(): string | null {
    return this.ingestLog[0]?.at ?? null;
  }

  private constructor(
    readonly config: PdsConfig,
    readonly resolverConfig: ResolverConfig,
    readonly pdsKey: PdsKey,
    readonly sequencer: Sequencer,
    readonly firehose: FirehoseService,
    readonly meta: MetaStore,
    readonly pipeline: IngestPipeline,
  ) {}

  static async create(config: PdsConfig): Promise<Pds> {
    validatePdsConfig(config);
    if (config.dataDir !== ':memory:' && !process.env.PDS_SIGNING_KEY?.trim() && !process.env.AGG_SIGNING_KEY?.trim()) {
      throw new Error('Persistent storage requires PDS_SIGNING_KEY; generate and save a key before starting.');
    }
    const pdsKey = await loadSharedPdsKey();
    const inMemory = config.dataDir === ':memory:';
    const seqStore = new SqliteSequencerStore(inMemory ? ':memory:' : join(config.dataDir, 'sequencer.sqlite'));
    const sequencer = new Sequencer(seqStore);
    const firehose = new FirehoseService(sequencer);
    const meta = new MetaStore(inMemory ? ':memory:' : join(config.dataDir, 'meta.sqlite'));
    const resolverConfig: ResolverConfig = {
      ...DEFAULT_RESOLVER_CONFIG,
      serviceEndpoint: config.selfEndpoint,
      fetchTimeoutMs: config.fetchTimeoutMs,
      allowLocalhost: process.env.ALLOW_LOCALHOST === '1',
    };

    const pds = new Pds(
      config,
      resolverConfig,
      pdsKey,
      sequencer,
      firehose,
      meta,
      undefined as unknown as IngestPipeline,
    );

    const pipeline = new IngestPipeline(config, resolverConfig, {
      resolverDeps: defaultResolverDeps(),
      repoFor: (did) => pds.repoFor(did),
      firehose,
      pdsKey,
      etagStore: meta,
      seenStore: meta,
      admit: (did, host, collection) => {
        // A deactivated repo stops accepting ingest (spec §9). Denylist is
        // handled inside admitWrite; deactivation is a separate soft state.
        if (meta.has(did) && !meta.isActive(did)) {
          return `DID ${did} is deactivated`;
        }
        const decision = admitWrite(
          { did, host, collection },
          { ...DEFAULT_ADMISSION_CONFIG, collectionAllowlist: config.allowedCollections },
          meta,
          { now: () => Date.now() },
        );
        return decision.admit ? null : decision.message;
      },
      reserveNewDid: (did) => {
        const reg = registrableDomain(didHost(did));
        if (reg == null) return false; // no registrable domain -> refuse (matches admit)
        return meta.reserveNewDid(did, reg, DEFAULT_ADMISSION_CONFIG.maxDidsPerRegistrableDomain);
      },
      // Validate before any repository writes; a bad record rejects the snapshot.
      validateRecord: buildRecordValidator(),
      nowIso: () => new Date().toISOString(),
    });
    // Late-bind the pipeline (it needs `pds.repoFor`).
    (pds as { pipeline: IngestPipeline }).pipeline = pipeline;
    pds.bootedAtMs = Date.now();
    // Periodic retention pruning (6 months / 0.5 GB, whichever
    // first). Runs every few minutes OFF the write path; enumerates the open
    // repo stores lazily so repos created after boot are covered. Cheap batched
    // DELETEs; logs what it prunes.
    startRetentionPruner(() => {
      const stores: PrunableStore[] = [seqStore];
      for (const mgr of pds.managers.values()) stores.push(mgr.storage);
      return stores;
    });
    log.info('PDS ready', {
      did: config.pdsDid,
      selfEndpoint: config.selfEndpoint,
      keyMode: config.keyMode,
      pdsKey: pdsKey.didKey,
    });
    return pds;
  }

  /** Open (or reuse) the RepoManager for a DID, materialising its SQLite store. */
  async repoFor(did: string): Promise<RepoManager> {
    let mgr = this.managers.get(did);
    if (!mgr) {
      const location =
        this.config.dataDir === ':memory:'
          ? ':memory:'
          : join(this.config.dataDir, `repo-${didToFilename(did)}.sqlite`);
      mgr = new RepoManager(new SqliteRepoStorage(did, location), this.pdsKey.signer);
      this.managers.set(did, mgr);
    }
    return mgr;
  }

  /**
   * Deactivate a publisher (spec §9): stop honoring its pings, mark it
   * deactivated, and emit `#account{active:false}` on the firehose. Blocks are
   * retained (atproto deactivation semantics); the read surface stops serving it
   * live via `getRepoStatus`/`listRepos` reporting active:false.
   */
  deactivate(did: string, opts: { deny?: boolean } = {}): number {
    this.meta.deactivate(did);
    if (opts.deny) this.meta.deny(did);
    return this.firehose.emitDeactivation(did, new Date().toISOString());
  }

  /**
   * Ingest a topic URL, serialised per DID. Two pings for the same DID run
   * strictly one-after-another; different DIDs run concurrently. A deactivated
   * (or denied) DID is refused here before any fetch.
   */
  async ingest(topicUrl: string): Promise<ReturnType<IngestPipeline['ingest']>> {
    const did = didForTopic(topicUrl);
    const prev = this.ingestLocks.get(did) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.pipeline.ingest(topicUrl));
    this.ingestLocks.set(did, next);
    try {
      const outcome = await next;
      this.recordIngest(topicUrl, did, outcome);
      return outcome;
    } finally {
      if (this.ingestLocks.get(did) === next) this.ingestLocks.delete(did);
    }
  }

  private recordIngest(
    topicUrl: string,
    did: string,
    outcome: Awaited<ReturnType<IngestPipeline['ingest']>>,
  ): void {
    const entry: IngestLogEntry = {
      at: new Date().toISOString(),
      topicUrl,
      did,
      status: outcome.status,
    };
    if (outcome.status === 'committed') {
      entry.rev = outcome.rev;
      entry.ops = outcome.ops;
      this.commitCount += 1;
    } else if (outcome.status === 'no-change') {
      entry.code = outcome.reason;
    } else if (outcome.status === 'rejected') {
      entry.code = outcome.code;
      entry.message = outcome.message;
    }
    this.ingestLog.unshift(entry);
    if (this.ingestLog.length > Pds.INGEST_LOG_MAX) this.ingestLog.length = Pds.INGEST_LOG_MAX;
  }
}

function didForTopic(topicUrl: string): string {
  try {
    return `did:web:${new URL(topicUrl).hostname}`;
  } catch {
    return `did:web:invalid`;
  }
}

/** Filesystem-safe filename fragment for a DID. */
function didToFilename(did: string): string {
  return did.replace(/[^a-zA-Z0-9.-]/g, '_');
}

/** did:web:host[%3Aport] -> host (decode a percent-encoded port if present). */
function didHost(did: string): string {
  const decoded = decodeURIComponent(did.slice('did:web:'.length));
  const colon = decoded.indexOf(':');
  return colon === -1 ? decoded : decoded.slice(0, colon);
}
