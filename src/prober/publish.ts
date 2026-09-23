/**
 * Where records go, behind one interface.
 *
 * The daemon builds records and hands them to a {@link Publisher}; it knows
 * nothing about files, HTTP, or atproto sessions. Three implementations ship:
 * a local file, a no-op, and {@link BlueskyPublisher}, which writes into a real
 * atproto repo with an app password.
 *
 * `publish()` takes the WHOLE run's records at once rather than one at a time.
 * That is not a convenience: the pull-PDS feed is a SNAPSHOT of complete desired
 * state, so anything absent from it is deleted on the next ingest. A
 * one-record-at-a-time interface would make a correct file publisher impossible.
 * The atproto path has no such constraint, so it loops inside the one call.
 */
import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { log } from '../log.js';
import { guardedFetch, GuardedFetchError } from '../net/guarded-fetch.js';
import type { PublishTarget } from './config.js';

/** One record to publish, in the shape the pull-PDS feed uses. */
export interface TelemetryRecord {
  collection: string;
  rkey: string;
  record: Record<string, unknown>;
}

export interface PublishResult {
  /** How many records were accepted by the destination. */
  published: number;
  /** Human-readable destination for the log line (a path, a URL, or "dry-run"). */
  destination: string;
}

export interface Publisher {
  /** Stable identifier for logs and tests. */
  readonly kind: string;
  publish(records: readonly TelemetryRecord[]): Promise<PublishResult>;
}

/**
 * One XRPC round trip. The single seam between a publisher and the network -
 * injected everywhere, so no test in the suite opens a socket and no fixture
 * ever holds a real credential. Mirrors `ProbeTransport` in `probe.ts`.
 */
export interface XrpcRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  /** JSON request body. Absent for a GET. */
  body?: Uint8Array;
}

export interface XrpcResponse {
  status: number;
  /** Lower-cased response headers. Carries the `ratelimit-*` budget. */
  headers: Map<string, string>;
  body: Uint8Array;
}

export type XrpcTransport = (req: XrpcRequest) => Promise<XrpcResponse>;

/** What a destination needs beyond its own config. */
export interface PublisherContext {
  /** The publisher's DID, required by any destination that claims authorship. */
  publisherDid: string;
  /** Process env, read by NAME for credentials. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Outbound HTTP. Defaults to {@link guardedXrpcTransport}. */
  transport?: XrpcTransport;
}

const FEED_TYPE = 'app.pullpds.feed';

/**
 * Write an `app.pullpds.feed` snapshot to a local path. Point a static web
 * server at that file and the existing pull-PDS ingests it - no new protocol,
 * no credential, and the operator can read exactly what would be published.
 *
 * CONCURRENCY. Two runs overlapping (a slow probe still running when the timer
 * fires again) must not produce a torn file, so the write is
 * write-temp-then-rename: `rename(2)` within a directory is atomic, and a reader
 * sees either the old complete feed or the new complete feed, never a partial
 * one. Last writer wins, which is correct here - each run is a complete snapshot
 * of the same endpoints, so the newest is the one worth keeping.
 */
export class FilePublisher implements Publisher {
  readonly kind = 'file';

  constructor(
    private readonly path: string,
    private readonly ctx: PublisherContext,
  ) {}

  async publish(records: readonly TelemetryRecord[]): Promise<PublishResult> {
    const feed = {
      $type: FEED_TYPE,
      did: this.ctx.publisherDid,
      records: records.map((r) => ({
        collection: r.collection,
        rkey: r.rkey,
        record: r.record,
      })),
    };
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${basename(this.path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    try {
      writeFileSync(tmp, `${JSON.stringify(feed, null, 2)}\n`, { mode: 0o644 });
      renameSync(tmp, this.path);
    } catch (err) {
      // Best-effort cleanup of the temp file; the original error is what matters.
      try {
        unlinkSync(tmp);
      } catch {
        /* the temp file may never have been created */
      }
      throw err;
    }
    log.info('prober published feed snapshot', {
      path: this.path,
      records: records.length,
      did: this.ctx.publisherDid,
    });
    return { published: records.length, destination: this.path };
  }
}

/**
 * Build the records, validate them, log what WOULD go out, write nothing. The
 * default when a config names no publish target, so a first run can never
 * surprise an operator by publishing.
 */
export class DryRunPublisher implements Publisher {
  readonly kind = 'dryrun';

  async publish(records: readonly TelemetryRecord[]): Promise<PublishResult> {
    for (const r of records) {
      log.info('prober dry-run record', { collection: r.collection, rkey: r.rkey, record: r.record });
    }
    return { published: 0, destination: 'dry-run (nothing written)' };
  }
}

/** Raised when a declared publish target cannot be built at all. */
export class PublisherUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublisherUnavailableError';
  }
}

/** Raised when a destination accepted nothing. Fails the run (exit 1). */
export class PublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishError';
  }
}

/** Session state. Held in memory for one run only, never written anywhere. */
interface Session {
  did: string;
  accessJwt: string;
  refreshJwt: string;
}

/** Cap on an XRPC response body. Session and putRecord envelopes are tiny. */
const MAX_XRPC_BYTES = 64 * 1024;
const XRPC_TIMEOUT_MS = 15_000;

/**
 * Write each record into a real atproto repo with an app password.
 *
 * THE QUESTION THIS WAS BLOCKED ON, ANSWERED. Verified live against a
 * Bluesky-hosted PDS (`stropharia.us-west.host.bsky.network`) with a real app
 * password, minted for the test and revoked after:
 *
 *   - An app-password session carries scope `com.atproto.appPass` - the
 *     REDUCED scope, not the `com.atproto.access` a full account password
 *     issues. It is nonetheless sufficient for `createRecord`, `putRecord` and
 *     `deleteRecord`; the restrictions app passwords carry are elsewhere.
 *   - `createRecord` under `org.peertelemetry.errorMetrics` - an NSID the PDS
 *     has never heard of - returns 200. The PDS cannot resolve a lexicon it
 *     does not host, so it stores the record with `validationStatus:
 *     "unknown"` rather than rejecting it.
 *   - The commit reaches the firehose: every create, update and delete showed up
 *     on `jetstream1.us-east.bsky.network` filtered to our collection, which is
 *     what `src/globalindex/indexer.ts` consumes.
 *
 * SESSION BUDGET IS THE BINDING LIMIT, NOT THE WRITE BUDGET. Bluesky allows
 * 35,000 write points per day (an update costs 2), which a prober cannot get
 * near - but `com.atproto.server.createSession` is capped at **300 per day**.
 * This process is run-once under a timer, so every run opens a fresh session:
 * at a 5-minute cadence that is 288 sessions/day against a limit of 300. Anyone
 * running tighter than ~10 minutes needs to either widen the interval or carry a
 * session between runs. See the README.
 *
 * SO THE SCHEMA CHECK IS ENTIRELY OURS. The PDS will happily sign and publish a
 * record missing required fields, carrying a bad enum, or holding an undeclared
 * extra field - all four were accepted with 200 in the live probe. `run.ts`
 * validates against the committed lexicon before we are ever called, and that is
 * the ONLY thing standing between a malformed record and a permanent, signed,
 * content-addressed commit.
 *
 * `validate: true` IS NOT AN OPTION. Asking the PDS to validate forces lexicon
 * resolution and fails closed: `400 InvalidRequest - Unknown lexicon type:
 * org.peertelemetry.errorMetrics`. The flag is therefore omitted, which also
 * means the day the schema is published on-network the PDS starts validating it
 * for free.
 */
export class BlueskyPublisher implements Publisher {
  readonly kind = 'bluesky';

  private session: Session | undefined;

  constructor(
    private readonly target: Extract<PublishTarget, { kind: 'bluesky' }>,
    /** The app password, resolved from the environment by {@link createPublisher}. */
    private readonly password: string,
    private readonly ctx: PublisherContext,
  ) {}

  async publish(records: readonly TelemetryRecord[]): Promise<PublishResult> {
    const session = await this.ensureSession();

    // The config's DID and the session's DID must be the same repo. If they are
    // not, every record would be written under an identity the config does not
    // claim - silently, and permanently, because commits are immutable.
    if (session.did !== this.ctx.publisherDid) {
      throw new PublishError(
        `publisherDid ${this.ctx.publisherDid} does not match the account ${this.target.identifier} resolves to (${session.did}) - records would land in the wrong repo`,
      );
    }

    let published = 0;
    const failures: string[] = [];
    for (const r of records) {
      try {
        await this.putRecord(r);
        published++;
      } catch (err) {
        // One provider's record failing must not cost the rest of the run.
        const reason = (err as Error).message;
        log.error('prober record not published', { rkey: r.rkey, collection: r.collection, reason });
        failures.push(`${r.rkey}: ${reason}`);
      }
    }

    if (published === 0) {
      throw new PublishError(
        `no records accepted by ${this.target.service} - ${failures.join('; ')}`,
      );
    }
    const destination = `${this.target.service} (${session.did})`;
    log.info('prober published to atproto repo', {
      destination,
      records: records.length,
      published,
      failed: failures.length,
    });
    return { published, destination };
  }

  /**
   * `putRecord`, not `createRecord`: a run updates the SAME rkey per endpoint
   * every window, so create-or-overwrite is the semantics wanted and a second
   * run must not fail on a key that already exists.
   *
   * Retries exactly once on an auth failure, after refreshing. Once, not in a
   * loop: a credential the PDS keeps rejecting is an operator problem, and a
   * daemon that retries it forever under a cron timer is a way to get an account
   * rate-limited rather than a way to recover.
   */
  private async putRecord(r: TelemetryRecord): Promise<void> {
    const body = {
      repo: this.ctx.publisherDid,
      collection: r.collection,
      rkey: r.rkey,
      record: r.record,
      // `validate` deliberately omitted - see the class header.
    };
    let res = await this.call('com.atproto.repo.putRecord', body, (await this.ensureSession()).accessJwt);
    if (isAuthFailure(res.status, res.error)) {
      log.info('prober atproto session rejected, refreshing', { rkey: r.rkey, status: res.status, error: res.error });
      const refreshed = await this.refreshSession();
      res = await this.call('com.atproto.repo.putRecord', body, refreshed.accessJwt);
    }
    if (res.status !== 200) {
      throw new Error(`putRecord ${res.status} ${res.error ?? ''} ${res.message ?? ''}`.trim());
    }
  }

  private async ensureSession(): Promise<Session> {
    if (this.session) return this.session;
    const res = await this.call('com.atproto.server.createSession', {
      identifier: this.target.identifier,
      password: this.password,
    });
    if (res.status !== 200) {
      // Names the identifier and the env var, never the password.
      throw new PublishError(
        `createSession for ${this.target.identifier} at ${this.target.service} failed: ${res.status} ${res.error ?? ''} ${res.message ?? ''} (password came from $${this.target.passwordEnv})`.trim(),
      );
    }
    this.session = readSession(res.json);
    log.info('prober opened atproto session', {
      service: this.target.service,
      identifier: this.target.identifier,
      did: this.session.did,
    });
    return this.session;
  }

  /**
   * Trade the refresh token for a new access token, falling back to a fresh
   * `createSession`. The fallback matters: refresh tokens are single-use and
   * expire, so a run that only ever refreshed would eventually wedge with a
   * credential that is still perfectly valid.
   */
  private async refreshSession(): Promise<Session> {
    const current = this.session;
    if (current) {
      const res = await this.call('com.atproto.server.refreshSession', undefined, current.refreshJwt);
      if (res.status === 200) {
        this.session = readSession(res.json);
        return this.session;
      }
      log.warn('prober atproto refreshSession failed, re-authenticating', {
        status: res.status,
        error: res.error,
      });
    }
    this.session = undefined;
    return this.ensureSession();
  }

  /**
   * One XRPC call. Returns the parsed envelope rather than throwing on a
   * non-2xx, because the error NAME is what the retry decision keys on.
   *
   * NOTHING HERE LOGS A TOKEN. The bearer header is built at the call site and
   * never enters a log field or an error message; only the status, the error
   * name and the PDS's own message are ever surfaced.
   */
  private async call(
    nsid: string,
    body: unknown,
    token?: string,
  ): Promise<{ status: number; json: unknown; error?: string; message?: string }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token !== undefined) headers.authorization = `Bearer ${token}`;

    const transport = this.ctx.transport ?? guardedXrpcTransport;
    const res = await transport({
      url: `${this.target.service}/xrpc/${nsid}`,
      method: 'POST',
      headers,
      ...(body === undefined ? {} : { body: new TextEncoder().encode(JSON.stringify(body)) }),
    });

    logRateLimit(nsid, res.headers);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(res.body));
    } catch {
      json = undefined; // an HTML error page from something in front of the PDS
    }
    const env = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
    return {
      status: res.status,
      json,
      ...(typeof env.error === 'string' ? { error: env.error } : {}),
      ...(typeof env.message === 'string' ? { message: env.message } : {}),
    };
  }
}

/**
 * Does this response mean "that token is no good, get another one"?
 *
 * KEYING ON 401 ALONE IS WRONG. A bsky.social PDS answers a bad or expired
 * access token with HTTP **400** and an `ExpiredToken` / `InvalidToken` error
 * name - verified live, not inferred. A publisher that only watched for 401
 * would never refresh and would fail every run once its token aged out.
 */
function isAuthFailure(status: number, error: string | undefined): boolean {
  if (status === 401) return true;
  return (
    status === 400 &&
    (error === 'ExpiredToken' || error === 'InvalidToken' || error === 'AuthenticationRequired')
  );
}

/** Pull the session fields out of a `createSession`/`refreshSession` reply. */
function readSession(json: unknown): Session {
  const o = (typeof json === 'object' && json !== null ? json : {}) as Record<string, unknown>;
  if (
    typeof o.did !== 'string' ||
    typeof o.accessJwt !== 'string' ||
    typeof o.refreshJwt !== 'string'
  ) {
    // Deliberately does not echo the body: it holds the tokens.
    throw new PublishError('atproto session response is missing did/accessJwt/refreshJwt');
  }
  return { did: o.did, accessJwt: o.accessJwt, refreshJwt: o.refreshJwt };
}

/**
 * Surface the write budget. bsky.social advertises `3000;w=300` for repo writes
 * and `30;w=300` for `createSession`; a prober is nowhere near either, but the
 * operator who points fifty endpoints at one account should be able to see the
 * number falling before it hits zero.
 */
function logRateLimit(nsid: string, headers: Map<string, string>): void {
  const remaining = headers.get('ratelimit-remaining');
  if (remaining === undefined) return;
  const fields = {
    nsid,
    remaining,
    limit: headers.get('ratelimit-limit'),
    reset: headers.get('ratelimit-reset'),
    policy: headers.get('ratelimit-policy'),
  };
  if (Number(remaining) <= 0) log.warn('prober atproto rate limit exhausted', fields);
  else log.debug('prober atproto rate limit', fields);
}

/**
 * The production transport: the repo's guarded outbound path, same as the probe
 * uses. HTTPS-only, one-shot DNS with the socket pinned to the validated
 * address, a body cap, and a whole-request timeout. It does NOT throw on a
 * non-2xx, which is what lets the caller read the PDS's error envelope.
 */
export const guardedXrpcTransport: XrpcTransport = async (req) => {
  try {
    const res = await guardedFetch(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body === undefined ? {} : { body: req.body }),
      timeoutMs: XRPC_TIMEOUT_MS,
      maxBytes: MAX_XRPC_BYTES,
      maxRedirects: 2,
    });
    return { status: res.status, headers: res.headers, body: res.body };
  } catch (err) {
    // The guard names the host and the reason, never a header.
    const detail = err instanceof GuardedFetchError ? `${err.code}: ${err.message}` : (err as Error).message;
    throw new PublishError(`XRPC request to ${req.url} failed - ${detail}`);
  }
};

export function createPublisher(target: PublishTarget, ctx: PublisherContext): Publisher {
  switch (target.kind) {
    case 'file':
      return new FilePublisher(target.path, ctx);
    case 'dryrun':
      return new DryRunPublisher();
    case 'bluesky': {
      // Resolved here, before any endpoint is probed: a run that cannot possibly
      // publish should not spend money on completions first.
      const password = (ctx.env ?? process.env)[target.passwordEnv]?.trim();
      if (!password) {
        throw new PublisherUnavailableError(
          `publish.passwordEnv names $${target.passwordEnv}, which is unset or empty`,
        );
      }
      return new BlueskyPublisher(target, password, ctx);
    }
  }
}
