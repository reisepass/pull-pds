import { createHmac, randomBytes } from 'node:crypto';
import { log } from '../log.js';

/**
 * A WebSub hub (pull-pds-spec.md §4), REC-complete (REDESIGN-TASK §5). Two
 * responsibilities:
 *
 *  1. **Publish** (`hub.mode=publish`): a publisher pings "come read me" with the
 *     topic URL. The hub debounces per origin (`minPingIntervalSec`) and hands
 *     the topic to the ingest pipeline. The ping carries no data and no
 *     authority - the ingest pipeline re-derives and pins the origin itself.
 *     This is the ONLY thing a publisher ever does; every REC handshake below is
 *     strictly hub<->subscriber and adds ZERO publisher round-trips.
 *
 *  2. **Subscribe/unsubscribe/denied** (`hub.mode=subscribe|unsubscribe|denied`):
 *     real downstream subscribers who want the raw feed fanned out. The hub
 *     verifies intent asynchronously (the HTTP layer answers 202 immediately,
 *     A2) by GETting the callback with a crypto-random `hub.challenge` (A6) and
 *     expects it echoed, then stores a lease PERSISTED in the hub's sqlite (A8)
 *     so subscriptions survive a restart. `hub.secret` is length-checked (A7).
 *     A subscriber that did not ask for a subscription confirms `hub.mode=denied`
 *     (A3), which drops any stored lease for that (callback, topic).
 *
 * This module is transport-agnostic: it takes parsed params and returns actions
 * / results. The HTTP server wires it to real requests, and injects the
 * intent-verification GET + the ingest trigger so this stays unit-testable.
 */

export interface Subscription {
  callback: string;
  topic: string;
  secret?: string;
  /** Epoch ms when this lease expires. */
  expiresAt: number;
}

/** Persistence seam for subscriptions (A8). MetaStore implements it. */
export interface SubscriptionStore {
  upsert(sub: Subscription): void;
  remove(callback: string, topic: string): void;
  all(): Subscription[];
}

/** Injected side effects, so the hub logic is pure and testable. */
export interface HubDeps {
  /** Perform the intent-verification GET; resolve true iff challenge echoed. */
  verifyIntent: (
    callback: string,
    params: { mode: string; topic: string; challenge: string; leaseSeconds: number },
  ) => Promise<boolean>;
  /** Trigger an ingest for a topic URL (fire-and-forget from the hub's view). */
  triggerIngest: (topicUrl: string) => Promise<void>;
  /** Distribute fetched content to a subscriber callback (with X-Hub-Signature). */
  distribute?: (sub: Subscription, body: Uint8Array, headers: Record<string, string>) => Promise<void>;
  now: () => number;
  /** Test hook: deterministic challenge source. Production uses crypto.randomBytes. */
  challenge?: () => string;
}

export interface PublishResult {
  accepted: boolean;
  debounced: boolean;
  reason?: string;
}

/**
 * subscribe/unsubscribe are ASYNC per the REC (A2): the HTTP layer answers
 * 202 the moment the request is well-formed, and the hub verifies intent in the
 * background. So the synchronous result is only "accepted for verification" or
 * "malformed"; verification-failed is only ever logged (the subscriber learns
 * via the absence of the confirmed lease / via hub.mode=denied).
 */
export type SubscribeResult =
  | { status: 'accepted' }
  | { status: 'invalid'; message: string };

const DEFAULT_LEASE_SEC = 10 * 24 * 60 * 60; // 10 days, per WebSub guidance
const MAX_LEASE_SEC = 30 * 24 * 60 * 60;
/** A7: hub.secret shorter than this is rejected as cryptographically useless. */
const MIN_SECRET_BYTES = 16;
/** A7: absurdly long secrets are rejected (abuse / log noise). */
const MAX_SECRET_BYTES = 256;

/**
 * A9 (deliberate, documented REC deviation - FINDINGS F-A9). The REC §8 registers
 * four `X-Hub-Signature` algorithms (`sha1`, `sha256`, `sha384`, `sha512`); we
 * offer exactly ONE, `sha256`. sha1 is broken; sha384/sha512 buy nothing for a
 * small JSON body and add a negotiation surface. This is the single algorithm we
 * both advertise and sign with, so a signature is never mislabeled.
 *
 * WebSub has no standard subscriber-side "requested algorithm" parameter (the hub
 * chooses), but some clients send a hint. If a subscriber explicitly asks for an
 * algorithm we do not offer, we reject the subscription up front with a clear
 * error rather than accept it and then deliver sha256-labeled signatures the
 * subscriber may reject or, worse, treat as a different algorithm.
 */
export const SUPPORTED_SIGNATURE_ALGO = 'sha256';
/** Non-standard-but-seen param names a client might use to request an algorithm. */
const ALGO_HINT_PARAMS = ['hub.algorithm', 'hub.signature_method', 'hub.signature_algorithm'];

export class WebSubHub {
  /** callback+topic -> subscription, mirrors the persisted store in-process. */
  private readonly subs = new Map<string, Subscription>();
  /** topic origin -> last accepted publish epoch ms (debounce). */
  private readonly lastPublish = new Map<string, number>();

  constructor(
    private readonly deps: HubDeps,
    private readonly minPingIntervalSec: number,
    private readonly store?: SubscriptionStore,
    /**
     * Absolute hub URL for the `rel="hub"` link on distributed content (REC
     * §5.2). Defaults to the relative `websub` when unset (tests); the HTTP
     * server passes the deployment's `<SELF_ENDPOINT>/websub`.
     */
    private readonly hubUrl: string = 'websub',
  ) {
    // A8: reload persisted leases so subscriptions survive a restart. Expired
    // ones are dropped on load (and pruned from the store lazily on distribute).
    if (this.store) {
      const now = this.deps.now();
      for (const sub of this.store.all()) {
        if (sub.expiresAt > now) this.subs.set(subKey(sub.callback, sub.topic), sub);
        else this.store.remove(sub.callback, sub.topic);
      }
    }
  }

  /**
   * Handle a `hub.mode=publish` ping. Accepts both `hub.url` (PuSH 0.4) and
   * `hub.topic` (W3C WebSub) as the topic parameter. Debounces per origin.
   */
  async publish(params: URLSearchParams): Promise<PublishResult> {
    const topic = params.get('hub.url') ?? params.get('hub.topic');
    if (!topic) return { accepted: false, debounced: false, reason: 'missing hub.url/hub.topic' };

    let origin: string;
    try {
      origin = new URL(topic).origin;
    } catch {
      return { accepted: false, debounced: false, reason: 'topic is not a URL' };
    }

    const now = this.deps.now();
    const last = this.lastPublish.get(origin);
    if (last !== undefined && now - last < this.minPingIntervalSec * 1000) {
      log.debug('publish debounced', { origin });
      return { accepted: true, debounced: true };
    }
    this.lastPublish.set(origin, now);

    // Fire the ingest. The hub does not await the whole pipeline for its HTTP
    // response semantics, but we surface errors to the log.
    this.deps.triggerIngest(topic).catch((err) => {
      log.error('ingest trigger failed', { topic, err: (err as Error).message });
    });
    return { accepted: true, debounced: false };
  }

  /**
   * Handle `hub.mode=subscribe` (A2 async): validates synchronously and returns
   * `accepted` so the HTTP layer can answer 202, then verifies intent in the
   * background. Only after the callback echoes the crypto-random challenge is
   * the lease stored (persisted if a store is wired). A7: secret length is
   * checked up front.
   */
  async subscribe(params: URLSearchParams): Promise<SubscribeResult> {
    const callback = params.get('hub.callback');
    const topic = params.get('hub.topic') ?? params.get('hub.url');
    if (!callback || !topic) {
      return { status: 'invalid', message: 'missing hub.callback or hub.topic' };
    }
    if (!isHttpUrl(callback) || !isHttpUrl(topic)) {
      return { status: 'invalid', message: 'callback/topic must be http(s) URLs' };
    }
    const secret = params.get('hub.secret');
    if (secret != null) {
      // A7: the secret is an HMAC key; too short is brute-forceable, too long is abuse.
      const bytes = Buffer.byteLength(secret, 'utf8');
      if (bytes < MIN_SECRET_BYTES || bytes > MAX_SECRET_BYTES) {
        return {
          status: 'invalid',
          message: `hub.secret must be ${MIN_SECRET_BYTES}-${MAX_SECRET_BYTES} bytes (got ${bytes})`,
        };
      }
    }
    // A9: if the subscriber explicitly requests a signature algorithm we do not
    // offer, fail cleanly here rather than silently signing with sha256 under a
    // label the subscriber did not ask for. We advertise/sign sha256 only.
    const requestedAlgo = firstDefined(params, ALGO_HINT_PARAMS);
    if (requestedAlgo != null && requestedAlgo.toLowerCase() !== SUPPORTED_SIGNATURE_ALGO) {
      return {
        status: 'invalid',
        message: `unsupported signature algorithm ${requestedAlgo}; this hub offers ${SUPPORTED_SIGNATURE_ALGO} only`,
      };
    }
    const leaseSeconds = clampLease(Number(params.get('hub.lease_seconds')) || DEFAULT_LEASE_SEC);

    // A2: verify intent asynchronously; the caller has already returned 202.
    void this.verifySubscribe(callback, topic, leaseSeconds, secret ?? undefined).catch((err) => {
      log.error('subscribe verification crashed', { callback, topic, err: (err as Error).message });
    });
    return { status: 'accepted' };
  }

  private async verifySubscribe(callback: string, topic: string, leaseSeconds: number, secret?: string): Promise<void> {
    const challenge = this.challenge();
    const ok = await this.deps.verifyIntent(callback, { mode: 'subscribe', topic, challenge, leaseSeconds });
    if (!ok) {
      // Verification failed: the lease is simply never stored. Loudly logged.
      log.warn('websub subscribe verification failed', { callback, topic });
      return;
    }
    const sub: Subscription = { callback, topic, expiresAt: this.deps.now() + leaseSeconds * 1000 };
    if (secret) sub.secret = secret;
    this.subs.set(subKey(callback, topic), sub);
    this.store?.upsert(sub); // A8
    log.info('websub subscription accepted', { callback, topic, leaseSeconds });
  }

  /** Handle `hub.mode=unsubscribe` (A2 async). Verifies intent, then drops the lease. */
  async unsubscribe(params: URLSearchParams): Promise<SubscribeResult> {
    const callback = params.get('hub.callback');
    const topic = params.get('hub.topic') ?? params.get('hub.url');
    if (!callback || !topic) {
      return { status: 'invalid', message: 'missing hub.callback or hub.topic' };
    }
    void this.verifyUnsubscribe(callback, topic).catch((err) => {
      log.error('unsubscribe verification crashed', { callback, topic, err: (err as Error).message });
    });
    return { status: 'accepted' };
  }

  private async verifyUnsubscribe(callback: string, topic: string): Promise<void> {
    const challenge = this.challenge();
    const ok = await this.deps.verifyIntent(callback, { mode: 'unsubscribe', topic, challenge, leaseSeconds: 0 });
    if (!ok) {
      log.warn('websub unsubscribe verification failed', { callback, topic });
      return;
    }
    this.subs.delete(subKey(callback, topic));
    this.store?.remove(callback, topic); // A8
    log.info('websub unsubscribed', { callback, topic });
  }

  /**
   * Handle `hub.mode=denied` (A3): a subscriber tells the hub it did NOT request
   * a subscription (e.g. it received a verification for something it never asked
   * for). The hub drops any stored lease for that (callback, topic) and must not
   * resubscribe. No intent verification is performed on a denial (the REC
   * requires the hub to accept it; there is nothing to confirm).
   */
  async denied(params: URLSearchParams): Promise<SubscribeResult> {
    const callback = params.get('hub.callback');
    const topic = params.get('hub.topic') ?? params.get('hub.url');
    if (!callback || !topic) {
      return { status: 'invalid', message: 'missing hub.callback or hub.topic' };
    }
    this.subs.delete(subKey(callback, topic));
    this.store?.remove(callback, topic); // A8
    log.info('websub subscription denied by subscriber - lease dropped', { callback, topic });
    return { status: 'accepted' };
  }

  /**
   * Distribute new content for a topic to all live subscribers (spec §4.4).
   *
   * Fan-out is CONCURRENT, not a sequential await loop (F-13): a single
   * subscriber whose callback hangs must not block delivery to the others until
   * its per-request timeout. Each delivery is independently `.catch`-guarded, so
   * one failing (or slow) subscriber never affects another. Expired leases are
   * pruned first, synchronously, so the concurrent deliveries see a stable set.
   */
  async distribute(topic: string, body: Uint8Array): Promise<void> {
    if (!this.deps.distribute) return;
    const distribute = this.deps.distribute;
    const now = this.deps.now();

    const targets: Subscription[] = [];
    for (const sub of this.subs.values()) {
      if (sub.topic !== topic) continue;
      if (sub.expiresAt <= now) {
        this.subs.delete(subKey(sub.callback, sub.topic));
        this.store?.remove(sub.callback, sub.topic); // A8: prune expired leases
        continue;
      }
      targets.push(sub);
    }

    await Promise.all(
      targets.map((sub) => {
        const headers: Record<string, string> = {
          Link: `<${topic}>; rel="self", <websub>; rel="hub"`,
          'Content-Type': 'application/json',
        };
        if (sub.secret) {
          headers['X-Hub-Signature'] = `sha256=${hmacSha256(sub.secret, body)}`;
        }
        return distribute(sub, body, headers).catch((err) => {
          log.error('websub distribute failed', { callback: sub.callback, err: (err as Error).message });
        });
      }),
    );
  }

  /** Active subscription count (excluding expired). Test/observability helper. */
  activeSubscriptions(): Subscription[] {
    const now = this.deps.now();
    return [...this.subs.values()].filter((s) => s.expiresAt > now);
  }

  /** A6: crypto-random challenge (CSPRNG), unguessable by a third party. */
  private challenge(): string {
    return this.deps.challenge?.() ?? randomBytes(32).toString('base64url');
  }
}

export function hmacSha256(secret: string, body: Uint8Array): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function subKey(callback: string, topic: string): string {
  return `${callback}\n${topic}`;
}

/** First non-null value among the given param names (A9 algorithm-hint lookup). */
function firstDefined(params: URLSearchParams, names: string[]): string | null {
  for (const n of names) {
    const v = params.get(n);
    if (v != null && v.trim() !== '') return v.trim();
  }
  return null;
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function clampLease(sec: number): number {
  if (!Number.isFinite(sec) || sec <= 0) return DEFAULT_LEASE_SEC;
  return Math.min(sec, MAX_LEASE_SEC);
}
