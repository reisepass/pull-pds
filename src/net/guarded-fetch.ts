import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isBlockedAddress } from './ssrf.js';

/** A guarded-fetch failure. `code` is stable for callers and tests. */
export class GuardedFetchError extends Error {
  constructor(
    readonly code: GuardedFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GuardedFetchError';
  }
}

export type GuardedFetchErrorCode =
  | 'https-only'
  | 'dns-failure'
  | 'blocked-address'
  | 'cross-host-redirect'
  | 'too-many-redirects'
  | 'response-too-large'
  | 'http-status'
  | 'timeout';

/**
 * Resolve a hostname to candidate IP address strings. Injected so tests can
 * drive rebinding scenarios deterministically. The *same* resolver is used for
 * validation and for the pinned dial, so there is exactly one lookup and no
 * time-of-check/time-of-use gap.
 */
export type HostResolver = (host: string) => Promise<string[]>;

/**
 * The low-level, already-pinned dial. Given the parsed URL and the single
 * validated IP address to connect to, perform the HTTPS request and return the
 * capped response. The production implementation ({@link dialPinned}) pins the
 * socket to `pinnedAddress` via the `lookup` hook; tests inject a fake to drive
 * the resolve/validate/redirect orchestration without a real TLS socket, while
 * still asserting the address that would have been dialled.
 */
export type Dialer = (
  parsed: URL,
  pinnedAddress: string,
  opts: GuardedFetchOptions,
) => Promise<GuardedResponse>;

export interface GuardedFetchOptions {
  /** Hard per-request timeout in ms (applies to the whole request, incl. body read). */
  timeoutMs: number;
  /** Hard cap on the response body in bytes. */
  maxBytes: number;
  /** Max redirects to follow. All redirects must stay same-host. */
  maxRedirects: number;
  /** HTTP method. Defaults to GET. */
  method?: 'GET' | 'POST';
  /** Request body (POST). The SSRF pin still applies to the dial. */
  body?: Uint8Array;
  /** Extra request headers (e.g. Content-Type, X-Hub-Signature for WebSub). */
  headers?: Record<string, string>;
  /**
   * Hosts allowed to resolve to otherwise-blocked addresses (e.g. `localhost`
   * in test mode). Off by default; must be passed explicitly. When a host is in
   * this set we still pin the resolved address, we just skip the block check.
   */
  allowHosts?: Set<string>;
  /** DNS resolver. Defaults to a real `dns.lookup`. Injected for tests. */
  resolver?: HostResolver;
  /**
   * Low-level pinned dialer. Defaults to the real {@link dialPinned}. Injected
   * for tests so the resolve/pin/redirect logic can be exercised without a
   * network, while still observing the pinned address.
   */
  dialer?: Dialer;
}

/** A fetched, size-capped response. */
export interface GuardedResponse {
  status: number;
  headers: Map<string, string>;
  body: Uint8Array;
  /** Final URL after any (same-host) redirects. */
  url: string;
  /** The exact IP address the socket connected to. */
  peerAddress: string;
}

const defaultResolver: HostResolver = async (host) => {
  const results = await dnsLookup(host, { all: true });
  return results.map((r) => r.address);
};

/**
 * Fetch a URL with SSRF + DNS-rebinding protection.
 *
 * The rebinding fix: we resolve the hostname **once**, validate every returned
 * address, choose one, and **pin that address** as the socket's connect target
 * via the `lookup` hook - while leaving SNI, the Host header, and TLS
 * certificate validation on the original hostname. There is therefore no second
 * DNS resolution between the check and the dial: the address that was validated
 * is the address that is connected to. A hostile origin cannot return a public
 * IP to the guard and a private IP to the socket.
 *
 * Redirects are followed only within the same host, and each redirect target is
 * itself resolved-and-pinned the same way.
 *
 * HTTPS only. This is the single choke point for every outbound fetch to an
 * attacker-chosen origin (did.json today, feed.json under the pull design).
 */
export async function guardedFetch(
  urlStr: string,
  opts: GuardedFetchOptions,
): Promise<GuardedResponse> {
  const resolver = opts.resolver ?? defaultResolver;
  const dialer = opts.dialer ?? dialPinned;
  const allowHosts = opts.allowHosts ?? new Set<string>();
  let url = urlStr;

  for (let hop = 0; hop <= opts.maxRedirects; hop++) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      throw new GuardedFetchError('https-only', `Refusing non-HTTPS URL: ${url}`);
    }

    const host = parsed.hostname;
    const pinnedAddress = await resolveAndPin(host, resolver, allowHosts);

    const res = await dialer(parsed, pinnedAddress, opts);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw new GuardedFetchError('http-status', `Redirect ${res.status} with no Location`);
      }
      const next = new URL(location, url);
      if (next.host !== parsed.host) {
        throw new GuardedFetchError(
          'cross-host-redirect',
          `Refusing cross-host redirect ${parsed.host} -> ${next.host}`,
        );
      }
      url = next.toString();
      continue;
    }

    return res;
  }

  throw new GuardedFetchError('too-many-redirects', `Exceeded ${opts.maxRedirects} redirects`);
}

/**
 * Resolve `host`, validate every address, and return one address to pin.
 * Validating *all* returned addresses (not just the one we pick) means a
 * resolver that returns [public, private] is rejected outright rather than
 * gambling on which entry the dial would have used.
 */
async function resolveAndPin(
  host: string,
  resolver: HostResolver,
  allowHosts: Set<string>,
): Promise<string> {
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch (err) {
    throw new GuardedFetchError('dns-failure', `DNS lookup failed for ${host}: ${(err as Error).message}`);
  }
  if (addresses.length === 0) {
    throw new GuardedFetchError('dns-failure', `No addresses for ${host}`);
  }

  const exempt = allowHosts.has(host);
  if (!exempt) {
    for (const addr of addresses) {
      if (isBlockedAddress(addr)) {
        throw new GuardedFetchError(
          'blocked-address',
          `${host} resolves to a blocked address (${addr})`,
        );
      }
    }
  }

  // Pin the first validated address. Every address passed the check above, so
  // any choice is safe; first is deterministic.
  return addresses[0] as string;
}

/**
 * Perform one HTTPS request with the connect address pinned to `pinnedAddress`.
 * The `lookup` hook forces the socket to dial exactly that IP, so no second DNS
 * resolution can occur; `servername` and the `Host` header keep SNI/TLS/routing
 * bound to the real hostname.
 */
function dialPinned(
  parsed: URL,
  pinnedAddress: string,
  opts: GuardedFetchOptions,
): Promise<GuardedResponse> {
  return new Promise<GuardedResponse>((resolve, reject) => {
    const family = pinnedAddress.includes(':') ? 6 : 4;
    const req = https.request(
      {
        hostname: parsed.hostname,
        servername: parsed.hostname, // SNI + cert validation stay on the hostname
        port: parsed.port ? Number(parsed.port) : 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: opts.method ?? 'GET',
        headers: {
          host: parsed.host,
          accept: 'application/json,application/did+json',
          ...(opts.body ? { 'content-length': String(opts.body.length) } : {}),
          ...(opts.headers ?? {}),
        },
        // The pin: ignore the hostname, always dial the validated address.
        lookup: (_hostname, _options, cb) => {
          cb(null, [{ address: pinnedAddress, family }]);
        },
        timeout: opts.timeoutMs,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const headers = new Map<string, string>();
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') headers.set(k.toLowerCase(), v);
          else if (Array.isArray(v)) headers.set(k.toLowerCase(), v.join(', '));
        }
        const peerAddress = res.socket.remoteAddress ?? pinnedAddress;

        // Early reject on a declared over-cap length; never the sole guard.
        const declared = headers.get('content-length');
        if (declared && Number(declared) > opts.maxBytes) {
          res.destroy();
          reject(
            new GuardedFetchError(
              'response-too-large',
              `Response declares ${declared} bytes > ${opts.maxBytes}`,
            ),
          );
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.byteLength;
          if (total > opts.maxBytes) {
            res.destroy();
            reject(
              new GuardedFetchError('response-too-large', `Response exceeds ${opts.maxBytes} bytes`),
            );
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            status,
            headers,
            body: new Uint8Array(Buffer.concat(chunks)),
            url: parsed.toString(),
            peerAddress,
          });
        });
        res.on('error', (err) => {
          reject(new GuardedFetchError('dns-failure', `Response stream error: ${err.message}`));
        });
      },
    );

    req.on('timeout', () => {
      req.destroy();
      reject(new GuardedFetchError('timeout', `Timed out fetching ${parsed.toString()}`));
    });
    req.on('error', (err) => {
      // AbortError-style timeouts land here too on some paths.
      if ((err as NodeJS.ErrnoException).code === 'ECONNRESET' && req.destroyed) {
        reject(new GuardedFetchError('timeout', `Connection reset fetching ${parsed.toString()}`));
        return;
      }
      reject(new GuardedFetchError('dns-failure', `Fetch failed for ${parsed.toString()}: ${err.message}`));
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
