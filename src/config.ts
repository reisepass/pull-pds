/**
 * Static configuration for the verification core.
 *
 * These values are injected into the pure logic below; nothing here reads the
 * environment implicitly at call time, so tests construct their own config.
 */
import { ALL_TELEMETRY_COLLECTIONS } from './collections.js';
export interface ResolverConfig {
  /**
   * The hostname this PDS answers to. Every accepted did.json must point its
   * `#atproto_pds` service at exactly this endpoint (DESIGN.md decision 6,
   * BRIEF "serviceEndpoint equals our configured hostname").
   *
   * The production value is DESIGN.md open question 5 and is deliberately NOT
   * decided here - see QUESTIONS.md.
   */
  serviceEndpoint: string;

  /** HTTPS fetch timeout in ms for did.json resolution. */
  fetchTimeoutMs: number;

  /** Hard cap on the did.json response body in bytes. */
  maxDocumentBytes: number;

  /**
   * Test-mode escape hatch. When true, `localhost` (and its loopback address)
   * is permitted as a did:web host and a port is allowed. Off by default; must
   * be set explicitly. Never enable in production (BRIEF SSRF section).
   */
  allowLocalhost: boolean;

  /**
   * When true, skip the `#atproto_pds == serviceEndpoint` binding check. A PDS
   * MUST NOT set this (the endpoint check is one of its four binding checks).
   * The AppView / indexer sets it: it is not a PDS, it resolves *any*
   * publisher's did:web doc to read the `#atproto` key regardless of which PDS
   * that publisher delegates to. Defaults to false.
   */
  skipEndpointCheck?: boolean;
}

export interface AdmissionConfig {
  /** Collections a commit may write. DESIGN.md decision 5. */
  collectionAllowlist: string[];

  /** Max distinct DIDs permitted per registrable domain (eTLD+1). DESIGN.md decision, abuse controls. */
  maxDidsPerRegistrableDomain: number;

  /** Rate limit on first-commit-from-a-new-DID, per registrable domain. */
  newDidRateLimit: {
    /** Max new DIDs admitted from one eTLD+1 within the window. */
    max: number;
    /** Sliding window length in ms. */
    windowMs: number;
  };

  /** Global rate limit on first-commit-from-a-new-DID across all domains. */
  globalNewDidRateLimit: {
    max: number;
    windowMs: number;
  };
}

/**
 * The canonical production self endpoint. DESIGN.md open question 5 is CLOSED
 * (REDESIGN-TASK §4): the canonical value is `https://p2.0rs.org`. It remains
 * env-overridable via `SELF_ENDPOINT` (p3's unit sets `SELF_ENDPOINT=https://p3.0rs.org`;
 * publishers already on p3 keep p3 as their `#atproto_pds`). The old fail-loud
 * `pds.example.invalid` placeholder is retired.
 */
export const PLACEHOLDER_SELF_ENDPOINT = 'https://p2.0rs.org';

/**
 * Read the aggregator/PDS self endpoint from the environment. Defaults to the
 * canonical production endpoint above (QUESTIONS.md Q5, closed = p2.0rs.org);
 * `SELF_ENDPOINT` overrides it per deployment.
 */
export function selfEndpointFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SELF_ENDPOINT?.trim();
  return raw && raw.length > 0 ? raw : PLACEHOLDER_SELF_ENDPOINT;
}

/**
 * Build the resolver config, reading `SELF_ENDPOINT` from the environment.
 * Overrides let tests and callers pin any field without touching the env.
 */
export function resolverConfigFromEnv(
  overrides: Partial<ResolverConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolverConfig {
  return {
    serviceEndpoint: selfEndpointFromEnv(env),
    fetchTimeoutMs: 5_000,
    maxDocumentBytes: 64 * 1024,
    allowLocalhost: false,
    ...overrides,
  };
}

export const DEFAULT_RESOLVER_CONFIG: ResolverConfig = {
  // Placeholder unless SELF_ENDPOINT overrides it via resolverConfigFromEnv().
  // DESIGN.md open question 5 - permanent once an operator publishes a document.
  serviceEndpoint: PLACEHOLDER_SELF_ENDPOINT,
  fetchTimeoutMs: 5_000,
  maxDocumentBytes: 64 * 1024,
  allowLocalhost: false,
};

export const DEFAULT_ADMISSION_CONFIG: AdmissionConfig = {
  // Accept both telemetry signals (error-metrics incl. legacy dual-read, and
  // usage-metrics). Publishers opt into whichever they write.
  collectionAllowlist: [...ALL_TELEMETRY_COLLECTIONS],
  maxDidsPerRegistrableDomain: 8,
  newDidRateLimit: { max: 4, windowMs: 60 * 60 * 1000 },
  globalNewDidRateLimit: { max: 240, windowMs: 60 * 60 * 1000 },
};
