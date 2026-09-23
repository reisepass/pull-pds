import type { ResolverConfig } from '../config.js';
import type { PdsConfig } from './config.js';
import {
  resolveDidWeb,
  DidWebError,
  defaultResolverDeps,
  type ResolverDeps,
  type ResolvedDidWeb,
} from '../identity/didweb.js';
import { guardedFetch, type GuardedResponse, type HostResolver } from '../net/guarded-fetch.js';
import { parseFeed, FeedError } from './feed.js';
import { RepoManager } from '../repo/repo-manager.js';
import { FirehoseService } from '../firehose/service.js';
import type { PdsKey } from '../repo/signing-key.js';
import { log } from '../log.js';
import { trace, traceEnabled } from '../trace.js';

/**
 * The ingest pipeline - the security-critical core.
 *
 * Triggered by a WebSub publish ping or a poll tick with a topic URL. Every step
 * is the PDS's own logic; nothing here trusts the ping body beyond using
 * its topic URL to *re-derive* the origin, which is then pinned.
 *
 * The four binding checks (step 3) are the whole authority model: a record can
 * only enter did:web:X's repo if it is fetched from X's own HTTPS origin and
 * X's did.json delegates to this PDS with this PDS's key. See the
 * `#atproto_pds`, `#atproto`, `origin`, and `id` assertions below.
 */

export type IngestOutcome =
  | { status: 'committed'; rev: string; commitCid: string; seq: number; ops: number; feedBytes?: Uint8Array }
  | { status: 'no-change'; reason: 'etag' | 'empty-diff' }
  | { status: 'rejected'; code: IngestRejectCode; message: string };

export type IngestRejectCode =
  | DidWebError['code']
  | FeedError['code']
  | 'binding-endpoint'
  | 'binding-key'
  | 'binding-origin'
  | 'binding-id'
  | 'topic-not-https'
  | 'feed-fetch-failed'
  | 'feed-truncated'
  | 'denied'
  | 'delete-bound-exceeded'
  | 'internal';

/** Everything the pipeline needs, injected so it is unit-testable. */
export interface IngestDeps {
  resolverDeps: ResolverDeps;
  /** Guarded transport for the feed fetch. Defaults to guardedFetch. */
  feedTransport?: (
    url: string,
    opts: { timeoutMs: number; maxBytes: number; maxRedirects: number; resolver?: HostResolver },
  ) => Promise<GuardedResponse>;
  /** Look up / open the RepoManager for a DID. */
  repoFor: (did: string) => Promise<RepoManager>;
  firehose: FirehoseService;
  pdsKey: PdsKey;
  /** Persisted last-ingested ETag per DID (spec §5 step 4/10). */
  etagStore: EtagStore;
  /** Records whether a DID has been ingested before (first-ingest firehose). */
  seenStore: SeenStore;
  /** Optional admission gate; returns a reason string to reject, or null to admit. */
  admit?: (did: string, host: string, collection: string) => string | null;
  /**
   * Optional per-record lexicon predicate. null = valid, a
   * string = rejection reason. Passed straight into `parseFeed` so a record that
   * fails its committed lexicon is rejected batch-atomically before the MST.
   */
  validateRecord?: (collection: string, record: Record<string, unknown>) => string | null;
  /** Injected clock for the firehose timestamp. */
  nowIso: () => string;
  /** Max fraction of the repo that one commit may delete (guards F-D5). 1 = no limit. */
  maxDeleteRatio?: number;
  /**
   * Per-publisher signing-key lookup (spec §10 hardened mode). Returns the
   * `publicKeyMultibase` a given DID must advertise, or null if unknown. Only
   * consulted when `KEY_MODE=per-publisher`; shared mode ignores it.
   */
  perPublisherKey?: (did: string) => string | null;
  /**
   * Atomically reserve a new DID's per-registrable-domain cap slot (F-5).
   * Returns false if the cap is already reached. Called once, for a new DID's
   * first ingest, after binding checks pass. Idempotent for retries.
   */
  reserveNewDid?: (did: string) => boolean;
}

export interface EtagStore {
  get(did: string): string | null;
  set(did: string, etag: string): void;
}

export interface SeenStore {
  has(did: string): boolean;
  add(did: string): void;
}

const MAX_REDIRECTS = 3;

export class IngestPipeline {
  constructor(
    private readonly pds: PdsConfig,
    private readonly resolverConfig: ResolverConfig,
    private readonly deps: IngestDeps,
  ) {}

  /** Run the full pipeline for a topic URL. Never throws; returns an outcome. */
  async ingest(topicUrl: string): Promise<IngestOutcome> {
    try {
      const outcome = await this.run(topicUrl);
      if (outcome.status === 'rejected') {
        // Log every rejection so the live server record shows the binding /
        // SSRF / feed-abuse defenses firing (experiment §7).
        log.warn('ingest rejected', { topicUrl, code: outcome.code, message: outcome.message });
        trace({ hop: 't_rejected', topicUrl, code: outcome.code });
      } else if (outcome.status === 'no-change') {
        log.debug('ingest no-change', { topicUrl, reason: outcome.reason });
      }
      return outcome;
    } catch (err) {
      log.error('ingest crashed', { topicUrl, err: (err as Error).message });
      return { status: 'rejected', code: 'internal', message: (err as Error).message };
    }
  }

  private async run(topicUrl: string): Promise<IngestOutcome> {
    trace({ hop: 't_ingest_start', topicUrl });
    // Step 1: derive host + DID from the topic URL. The ping cannot name a host
    // other than via this URL, and we re-derive the origin ourselves.
    let topic: URL;
    try {
      topic = new URL(topicUrl);
    } catch {
      return reject('topic-not-https', `topic is not a URL: ${topicUrl}`);
    }
    if (topic.protocol !== 'https:') {
      return reject('topic-not-https', `topic must be https: ${topicUrl}`);
    }
    const host = topic.hostname;
    const did = `did:web:${hostToDidWebId(host, topic)}`;

    // Step 2: resolve + validate did.json over the guarded transport. The
    // resolver already enforces HTTPS-only, SSRF/rebinding pinning, no
    // cross-origin redirects, and the #atproto_pds == SELF_ENDPOINT check.
    let identity: ResolvedDidWeb;
    try {
      identity = await resolveDidWeb(did, this.resolverConfig, this.deps.resolverDeps);
    } catch (err) {
      if (err instanceof DidWebError) {
        // wrong-service-endpoint is binding check #1 surfacing from the resolver.
        const code = err.code === 'wrong-service-endpoint' ? 'binding-endpoint' : err.code;
        return reject(code as IngestRejectCode, err.message);
      }
      return reject('internal', (err as Error).message);
    }

    // Step 3: BINDING CHECKS. resolveDidWeb already asserted #atproto_pds ==
    // SELF_ENDPOINT and doc.id == did (inside validateDidDocument). We add the
    // two PA-specific checks the self-sign resolver does not make:
    //   - #atproto key must be THIS AGGREGATOR's key (expected_key(did)),
    //   - the topic origin must be the DID's own origin.
    if (!keyEquals(identity.atprotoKey.multikey, this.expectedKey(did))) {
      return reject(
        'binding-key',
        `#atproto key is not the PDS's expected key for ${did}`,
      );
    }
    if (topic.hostname !== identity.host) {
      return reject(
        'binding-origin',
        `topic origin ${topic.hostname} is not the DID origin ${identity.host}`,
      );
    }
    // doc.id == did is enforced in validateDidDocument; assert defensively.
    if (identity.did !== did) {
      return reject('binding-id', `doc id ${identity.did} != ${did}`);
    }

    // Optional admission gate (denylist / caps / rate limit) - checked before we
    // fetch the (attacker-controlled) feed body, using the first collection as a
    // proxy is not enough, so we admit per-DID here and re-check per collection
    // during validation below.
    const denyReason = this.deps.admit?.(did, host, this.pds.allowedCollections[0] ?? '');
    if (denyReason) return reject('denied', denyReason);

    // Step 4: fetch the feed from the DID's own origin, guarded + size-capped.
    let feedRes: GuardedResponse;
    const feedTransport = this.deps.feedTransport ?? guardedFetch;
    try {
      feedRes = await feedTransport(topicUrl, {
        timeoutMs: this.pds.fetchTimeoutMs,
        maxBytes: this.pds.maxFeedBytes,
        maxRedirects: MAX_REDIRECTS,
        resolver: this.deps.resolverDeps.resolver,
      });
    } catch (err) {
      return reject('feed-fetch-failed', `feed fetch failed: ${(err as Error).message}`);
    }
    if (feedRes.status !== 200) {
      return reject('feed-fetch-failed', `feed returned status ${feedRes.status}`);
    }

    // F-D5 guard: a feed truncated at the cap, or whose Content-Length disagrees
    // with the received length, must NOT be treated as "the publisher deleted
    // everything." The guarded transport already rejects over-cap bodies, but a
    // declared length mismatch is caught here.
    const declared = feedRes.headers.get('content-length');
    if (declared && Number(declared) !== feedRes.body.length) {
      return reject(
        'feed-truncated',
        `feed length ${feedRes.body.length} != declared Content-Length ${declared}`,
      );
    }

    // ETag short-circuit (spec §5 step 4) - an OPTIMIZATION only (D4). The diff
    // is still the source of truth; if the ETag matches we skip, else we proceed
    // and let the diff decide.
    const etag = feedRes.headers.get('etag');
    if (etag && this.deps.etagStore.get(did) === etag) {
      trace({ hop: 't_no_change', did, reason: 'etag' });
      return { status: 'no-change', reason: 'etag' };
    }

    // Step 5: parse + validate the feed (collection allowlist, dup keys, atomic).
    let parsed;
    try {
      parsed = parseFeed(feedRes.body, {
        expectedDid: did,
        allowedCollections: this.pds.allowedCollections,
        maxRecords: this.pds.maxRecordsPerRepo,
        ...(this.deps.validateRecord ? { validateRecord: this.deps.validateRecord } : {}),
      });
    } catch (err) {
      if (err instanceof FeedError) return reject(err.code, err.message);
      return reject('internal', (err as Error).message);
    }

    // Correlation: pull the (seq, emittedAt) each record carries in-band so the
    // trace can be tied back to the exact ping without a side channel.
    const feedSeqs = traceEnabled() ? extractSeqs(parsed.records) : [];
    trace({ hop: 't_fetch_done', did, seqs: feedSeqs });

    // Step 6: diff against the current repo.
    const mgr = await this.deps.repoFor(did);
    const diff = await mgr.diffAgainstFeed(parsed.records);

    // Step 7: empty diff -> no commit, no firehose, no rev bump (204).
    if (diff.writes.length === 0) {
      if (etag) this.deps.etagStore.set(did, etag);
      trace({ hop: 't_no_change', did, reason: 'empty-diff', seqs: feedSeqs });
      return { status: 'no-change', reason: 'empty-diff' };
    }

    // F-D5 guard #2: bound the delete count per commit. A snapshot that would
    // delete more than `maxDeleteRatio` of the repo is treated as suspicious
    // (e.g. a wrong-but-smaller snapshot) and rejected unless the feed is
    // genuinely, explicitly empty.
    const ratio = this.deps.maxDeleteRatio ?? 1;
    if (ratio < 1 && parsed.records.length > 0) {
      const before = (await mgr.currentState()).size;
      if (before > 0 && diff.deletes / before > ratio) {
        return reject(
          'delete-bound-exceeded',
          `commit would delete ${diff.deletes}/${before} records (> ${ratio})`,
        );
      }
    }

    // Atomic per-domain cap reservation (F-5). For a DID that has not committed
    // before, claim its registrable-domain slot in a single transaction here -
    // AFTER the binding checks pass (so unbound DIDs can't exhaust the cap) and
    // BEFORE the commit is persisted. Two new DIDs on one domain racing their
    // first ingest can both pass the optimistic `admit` check above, but only
    // one wins this reservation. Idempotent for retries of an already-seen DID.
    const firstIngest = !this.deps.seenStore.has(did);
    if (firstIngest && this.deps.reserveNewDid) {
      const granted = this.deps.reserveNewDid(did);
      if (!granted) {
        return reject('denied', `registrable-domain DID cap reached for ${did}`);
      }
    }

    // Step 8: build + sign + persist the commit.
    const result = await mgr.commitWrites(diff.writes, diff.prevCids);
    trace({ hop: 't_commit', did, rev: result.commit.rev, seqs: feedSeqs });

    // Step 9: firehose.
    const handle = hostAsHandle(identity);
    const { commitSeq } = await this.deps.firehose.emitCommit(mgr, result, {
      firstIngest,
      nowIso: this.deps.nowIso(),
      ...(handle ? { handle } : {}),
    });
    if (firstIngest) this.deps.seenStore.add(did);
    trace({ hop: 't_emit', did, rev: result.commit.rev, firehoseSeq: commitSeq, seqs: feedSeqs });

    // Step 10: record the ETag.
    if (etag) this.deps.etagStore.set(did, etag);

    log.info('ingest committed', {
      did,
      rev: result.commit.rev,
      ops: result.ops.length,
      seq: commitSeq,
    });
    return {
      status: 'committed',
      rev: result.commit.rev,
      commitCid: result.commit.cid.toString(),
      seq: commitSeq,
      ops: result.ops.length,
      feedBytes: feedRes.body,
    };
  }

  /**
   * The public key we expect a publisher's #atproto to advertise (spec §5,
   * `expected_key(did)`).
   *
   * Shared-key mode (default): every publisher advertises the one PDS
   * key. Per-publisher mode (spec §10) would resolve a DID-specific key here via
   * an injected lookup - the seam is `perPublisherKey`; until that lookup is
   * wired it falls back to the shared key, so a per-publisher deployment without
   * the lookup fails closed to shared behaviour rather than silently admitting.
   */
  private expectedKey(did: string): string {
    if (this.pds.keyMode === 'per-publisher' && this.deps.perPublisherKey) {
      return this.deps.perPublisherKey(did) ?? this.deps.pdsKey.publicKeyMultibase;
    }
    return this.deps.pdsKey.publicKeyMultibase;
  }
}

function reject(code: IngestRejectCode, message: string): IngestOutcome {
  return { status: 'rejected', code, message };
}

/** default resolver deps factory re-export for callers. */
export { defaultResolverDeps };

function keyEquals(a: string, b: string): boolean {
  return a === b;
}

/**
 * The did:web msid for a host. Bare hostname (spec §2). A port only survives in
 * localhost test mode; encode it per did:web (`host%3Aport`).
 */
function hostToDidWebId(host: string, topic: URL): string {
  if (topic.port && (host === 'localhost' || host === '127.0.0.1')) {
    return `${host}%3A${topic.port}`;
  }
  return host;
}

function hostAsHandle(identity: ResolvedDidWeb): string | undefined {
  const aka = identity.alsoKnownAs.find((a) => a.startsWith('at://'));
  return aka ? aka.slice('at://'.length) : undefined;
}

/** Pull the in-band `seq` correlation field out of each feed record. */
function extractSeqs(records: Array<{ record: Record<string, unknown> }>): number[] {
  const out: number[] = [];
  for (const r of records) {
    const s = r.record['seq'];
    if (typeof s === 'number') out.push(s);
  }
  return out;
}
