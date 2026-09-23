/**
 * OmniRoute as a telemetry source. THIS ADAPTER COLLECTS NOTHING, DELIBERATELY.
 *
 * OmniRoute is where this project started - `lexicons/app/omniroute/errorReport.json`
 * is the original published lexicon and is dual-read forever
 * (`LEGACY_ERROR_REPORT_NSID`). It was investigated against the live deployment
 * on 2026-08-03 and it cannot currently be collected FROM. The negative is
 * recorded here rather than left as an absence, and every run reports it through
 * `limitations` so it stays visible instead of decaying into "we never got round
 * to it".
 *
 * WHAT WAS FOUND, against the live instance (v3.8.48):
 *
 * 1. IT IS UP. `GET /api/health/ping` is public and returns 200. Reachability
 *    is not the problem, which is why {@link OmniRouteCollector} still probes it
 *    - "the gateway is down" and "the gateway will not tell us" are different
 *    facts and an operator should be able to tell them apart.
 *
 * 2. THE TELEMETRY ROUTES EXIST BUT ARE NOT AUTHORISED BY EITHER CREDENTIAL.
 *    `/api/provider-metrics`, `/api/usage/requests-by-provider-date`,
 *    `/api/usage/call-logs` and `/api/telemetry/summary` all answer 401 without
 *    a bearer and 403 "Invalid management token" with one. Both credentials in
 *    the environment are valid INFERENCE keys - each returns 200 on
 *    `GET /api/v1/models` - but neither carries the `manage` scope that
 *    OmniRoute's route guard requires (`src/server/authz/policies/management.ts`
 *    accepts an `oma_` scoped access token, or an API key whose metadata has the
 *    manage scope; nothing else). This is a CREDENTIAL gap, not an API gap.
 *
 * 3. EVEN AUTHORISED, `/api/provider-metrics` IS THE WRONG SHAPE. Reading its
 *    source: it returns cumulative all-time per-provider
 *    {totalRequests, totalSuccesses, avgLatencyMs, lastStatus, lastErrorStatus}.
 *    No time window, no per-error-code counts, and only the LAST error status
 *    rather than a distribution - so it cannot fill `errors[]`.
 *    `/api/usage/requests-by-provider-date` does take a range and does break
 *    down by provider and date, and `/api/usage/call-logs` has per-call rows;
 *    those are where a real implementation should start. Their response shapes
 *    were NOT verified (403), so nothing here is written against them - guessing
 *    at a schema is how a collector silently reports zeros.
 *
 * 4. THE PUBLIC SURFACE IS UNUSABLE AND UNSAFE TO SCRAPE. `/api/monitoring/health`
 *    needs no auth and does carry provider state, but it is a point-in-time
 *    circuit-breaker snapshot (`{provider, state, failureCount, lastFailure}`)
 *    with no window, no model dimension and no error codes; a breaker state is
 *    not an error count. It also returns live session ids, connection ids and
 *    per-key data that this project has no business ingesting.
 *
 * 5. OMNIROUTE'S OWN INTEGRATION IS A PUSH, NOT A PULL. `src/lib/peerTelemetry.ts`
 *    in the OmniRoute tree keeps in-process `{healthErrors, accountErrors}`
 *    counters, serves them at `/atproto/feed.json`, and pings the pull-PDS
 *    WebSub hub every 5 minutes - the publisher-hosted-feed model this PDS is
 *    built around. So a gateway COLLECTOR is architecturally the wrong shape for
 *    OmniRoute: it is meant to publish, not be scraped. (That route is also not
 *    in the deployed build - `/atproto/feed.json` 404s on v3.8.48 - so the
 *    integration is present in source and not yet live.)
 *
 * WHAT WOULD MAKE THIS COLLECTABLE, in preference order:
 *   a. Finish the push path: land `/atproto/feed.json` in the deployed build and
 *    point the existing pull-PDS ingest at it. No collector needed at all, and
 *    the record is emitted by the node that actually observed the errors.
 *   b. Failing that, issue an `oma_` access token or a manage-scoped API key,
 *    verify the shape of `/api/usage/requests-by-provider-date` and
 *    `/api/usage/call-logs`, and implement against them here.
 */
import { log } from '../log.js';
import type {
  CollectOptions,
  CollectResult,
  CollectStats,
  GatewayCollector,
} from './types.js';

export const OMNIROUTER_SOURCE = 'omnirouter';

const DEFAULT_TIMEOUT_MS = 15_000;

/** Public, unauthenticated, and the only thing this adapter is allowed to call. */
const PING_PATH = '/api/health/ping';

export interface OmniRouteCollectorOptions {
  /** Instance base URL. A bare hostname is upgraded to https. */
  baseUrl: string;
}

const NOT_COLLECTABLE =
  'omnirouter emits no records: its telemetry routes (/api/provider-metrics, ' +
  '/api/usage/requests-by-provider-date, /api/usage/call-logs, /api/telemetry/summary) require ' +
  'a manage-scoped credential that is not configured, and OmniRoute\'s own peer-telemetry ' +
  'integration is a publisher-hosted /atproto/feed.json push rather than a pull API. See the ' +
  'header of src/gateway/omnirouter.ts';

/**
 * Probes reachability and reports the negative. Emits no records under any
 * circumstance - an adapter that cannot distinguish "no errors" from "no access"
 * must never emit the record that says "no errors".
 */
export class OmniRouteCollector implements GatewayCollector {
  readonly source = OMNIROUTER_SOURCE;

  constructor(private readonly opts: OmniRouteCollectorOptions) {}

  async collect(collectOpts: CollectOptions): Promise<CollectResult> {
    const limitations = [NOT_COLLECTABLE];
    const base = normalizeBaseUrl(this.opts.baseUrl);

    // Reachability only. Worth the one request so an operator can tell a gateway
    // that is DOWN from one that is merely closed to us.
    try {
      const res = await collectOpts.transport({
        url: `${base}${PING_PATH}`,
        method: 'GET',
        headers: {},
        timeoutMs: collectOpts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      if (res.status !== 200) {
        limitations.push(`the instance answered HTTP ${res.status} on ${PING_PATH}`);
      }
    } catch (err) {
      limitations.push(`the instance was unreachable: ${(err as Error).message}`);
    }

    log.info('omnirouter collect is a documented no-op', { source: this.source, limitations });
    return { source: this.source, records: [], stats: emptyStats(), limitations };
  }
}

/** `omniroute.example.com` -> `https://omniroute.example.com`, trailing slash off. */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/$/, '');
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function emptyStats(): CollectStats {
  return {
    totalCalls: 0,
    healthErrors: 0,
    accountErrors: 0,
    modelErrors: 0,
    gatewayErrors: 0,
    unclassifiedErrors: 0,
    providerObserved: 0,
    providerInferred: 0,
    providerUnknown: 0,
  };
}
