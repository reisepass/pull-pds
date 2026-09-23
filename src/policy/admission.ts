import type { AdmissionConfig } from '../config.js';
import { registrableDomain } from '../identity/registrable.js';

/** A clock, injected so tests are deterministic. Returns epoch millis. */
export interface Clock {
  now(): number;
}

/**
 * Persistent state the admission check reads and writes. Kept as an interface so
 * the storage backend (DESIGN.md open question 2) is not decided here - a caller
 * supplies SQLite, memory, or anything else. All methods are synchronous to keep
 * the policy functions pure and easy to reason about; a real async store can be
 * adapted by the caller or this interface widened later.
 */
export interface AdmissionStore {
  /** True if this DID has committed before (i.e. it is not new). */
  isKnownDid(did: string): boolean;
  /** The set of distinct DIDs already bound to a registrable domain. */
  didsForRegistrableDomain(domain: string): Set<string>;
  /** True if the DID is on the denylist / kill switch (DESIGN.md decision, abuse controls). */
  isDenied(did: string): boolean;
  /**
   * Timestamps (epoch ms) of recent first-commits from new DIDs on this
   * registrable domain, for the sliding-window rate limit.
   */
  recentNewDidTimestamps(domain: string): number[];
  /** Timestamps (epoch ms) of recent first-commits from new DIDs, globally. */
  recentNewDidTimestampsGlobal(): number[];
}

/** Everything the caller knows about the write being admitted. */
export interface AdmissionRequest {
  did: string;
  host: string;
  collection: string;
}

export type AdmissionDecision =
  | { admit: true }
  | { admit: false; reason: AdmissionDenyReason; message: string };

export type AdmissionDenyReason =
  | 'denied-did'
  | 'collection-not-allowed'
  | 'no-registrable-domain'
  | 'domain-cap-exceeded'
  | 'domain-rate-limited'
  | 'global-rate-limited';

/**
 * Decide whether to admit a write. Pure: all side-effecting state comes in
 * through `store` and `clock`. Ordering runs cheapest / hardest-stop first:
 *
 *   1. DID denylist   - the kill switch (DESIGN.md abuse controls).
 *   2. Collection allowlist (DESIGN.md decision 5).
 *   3. Registrable domain must exist at all.
 *   4. Per-domain distinct-DID cap.        } only enforced for a *new* DID;
 *   5. Per-domain new-DID rate limit.      } a DID that already committed is
 *   6. Global new-DID rate limit.          } past these gates.
 *
 * The caller is responsible for recording the eTLD+1 -> DID binding and the
 * new-DID timestamp *after* a first commit is accepted; this function only
 * reads the store.
 */
export function admitWrite(
  req: AdmissionRequest,
  config: AdmissionConfig,
  store: AdmissionStore,
  clock: Clock,
): AdmissionDecision {
  if (store.isDenied(req.did)) {
    return deny('denied-did', `DID ${req.did} is denylisted`);
  }

  if (!config.collectionAllowlist.includes(req.collection)) {
    return deny(
      'collection-not-allowed',
      `Collection ${req.collection} is not in the allowlist`,
    );
  }

  const domain = registrableDomain(req.host);
  if (domain == null) {
    return deny(
      'no-registrable-domain',
      `Host ${req.host} has no registrable domain (eTLD+1)`,
    );
  }

  // A DID that has already committed is established; caps and rate limits are
  // about admitting *new* identities, so let it straight through.
  if (store.isKnownDid(req.did)) {
    return { admit: true };
  }

  // Per-domain distinct-DID cap. A DID already counted toward the domain does
  // not re-consume a slot (guarded above by isKnownDid, but stay defensive).
  const existing = store.didsForRegistrableDomain(domain);
  if (!existing.has(req.did) && existing.size >= config.maxDidsPerRegistrableDomain) {
    return deny(
      'domain-cap-exceeded',
      `Registrable domain ${domain} already has ${existing.size} DIDs (cap ${config.maxDidsPerRegistrableDomain})`,
    );
  }

  const now = clock.now();

  // Per-domain new-DID sliding-window rate limit.
  const domainWindow = config.newDidRateLimit;
  const domainHits = countWithinWindow(
    store.recentNewDidTimestamps(domain),
    now,
    domainWindow.windowMs,
  );
  if (domainHits >= domainWindow.max) {
    return deny(
      'domain-rate-limited',
      `Registrable domain ${domain} exceeded new-DID rate limit (${domainWindow.max}/${domainWindow.windowMs}ms)`,
    );
  }

  // Global new-DID sliding-window rate limit.
  const globalWindow = config.globalNewDidRateLimit;
  const globalHits = countWithinWindow(
    store.recentNewDidTimestampsGlobal(),
    now,
    globalWindow.windowMs,
  );
  if (globalHits >= globalWindow.max) {
    return deny(
      'global-rate-limited',
      `Global new-DID rate limit exceeded (${globalWindow.max}/${globalWindow.windowMs}ms)`,
    );
  }

  return { admit: true };
}

function countWithinWindow(timestamps: number[], now: number, windowMs: number): number {
  const cutoff = now - windowMs;
  let count = 0;
  for (const t of timestamps) {
    if (t > cutoff) count++;
  }
  return count;
}

function deny(reason: AdmissionDenyReason, message: string): AdmissionDecision {
  return { admit: false, reason, message };
}
