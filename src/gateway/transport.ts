/**
 * The production {@link GatewayTransport}: every gateway collector's outbound
 * HTTP, routed through `src/net/guarded-fetch.ts`.
 *
 * Collectors talk to third-party management APIs whose hostnames come out of
 * config, so they get the same SSRF/DNS-rebinding guard as every other outbound
 * fetch in this tree - resolve once, validate every returned address, pin the
 * validated address for the dial, HTTPS only, same-host redirects only. A
 * gateway URL is operator-supplied rather than attacker-supplied, but a
 * self-hosted LiteLLM or OmniRoute URL is exactly the kind of value that ends up
 * pointing at a metadata endpoint by accident, and there is no reason for this
 * path to be the one exception.
 *
 * `allowHosts` exists for self-hosted gateways on a private address: LiteLLM and
 * OmniRoute are routinely deployed behind a VPN or on localhost, which
 * `isBlockedAddress` rejects by default. It must be passed explicitly, per host,
 * and it only skips the block check - the resolved address is still pinned.
 */
import { guardedFetch, GuardedFetchError, type Dialer, type HostResolver } from '../net/guarded-fetch.js';
import type { GatewayHttpRequest, GatewayHttpResponse, GatewayTransport } from './types.js';

/**
 * Response cap. Analytics responses are counts, not payloads; the largest thing
 * a collector reads is a page of spend logs, which measured under 1 MB for a
 * 50-row page on the live LiteLLM deployment. 8 MB leaves an order of magnitude
 * of headroom while still bounding memory against a hostile or broken endpoint.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Management APIs redirect rarely; same-host only, and one hop is plenty. */
const MAX_REDIRECTS = 2;

export interface GuardedGatewayTransportOptions {
  /**
   * Hosts permitted to resolve to otherwise-blocked (private/loopback)
   * addresses. For self-hosted gateways only, and never a default.
   */
  allowHosts?: Set<string>;
  /**
   * DNS resolver and pinned dialer, forwarded to `guardedFetch`. Injected by
   * tests so this adapter's request/response mapping and its caps can be
   * asserted without a socket; the same seam `guarded-fetch.ts` documents.
   */
  resolver?: HostResolver;
  dialer?: Dialer;
}

export function guardedGatewayTransport(
  opts: GuardedGatewayTransportOptions = {},
): GatewayTransport {
  return async (req: GatewayHttpRequest): Promise<GatewayHttpResponse> => {
    const res = await guardedFetch(req.url, {
      timeoutMs: req.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      maxRedirects: MAX_REDIRECTS,
      method: req.method,
      ...(req.body === undefined ? {} : { body: req.body }),
      headers: req.headers,
      ...(opts.allowHosts === undefined ? {} : { allowHosts: opts.allowHosts }),
      ...(opts.resolver === undefined ? {} : { resolver: opts.resolver }),
      ...(opts.dialer === undefined ? {} : { dialer: opts.dialer }),
    });
    return { status: res.status, headers: res.headers, body: res.body };
  };
}

export { GuardedFetchError };
