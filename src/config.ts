/**
 * Static configuration for the verification core.
 *
 * These values are injected into the pure logic below; nothing here reads the
 * environment implicitly at call time, so tests construct their own config.
 */
import { DEFAULT_ALLOWED_COLLECTIONS } from './collections.js';
export interface ResolverConfig {
  /**
   * The hostname this PDS answers to. Every accepted did.json must point its
   * `#atproto_pds` service at exactly this endpoint.
   */
  serviceEndpoint: string;

  /** HTTPS fetch timeout in ms for did.json resolution. */
  fetchTimeoutMs: number;

  /** Hard cap on the did.json response body in bytes. */
  maxDocumentBytes: number;

  /**
   * Test-mode escape hatch. When true, `localhost` (and its loopback address)
   * is permitted as a did:web host and a port is allowed. Off by default; must
   * be set explicitly. Never enable in production.
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
  /** Collections a commit may write. */
  collectionAllowlist: string[];

  /** Max distinct DIDs permitted per registrable domain (eTLD+1); an abuse control. */
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
 * Placeholder self endpoint used when SELF_ENDPOINT is unset. The `.invalid`
 * top-level domain never resolves, so a deployment that forgets to configure
 * its endpoint cannot accidentally accept publishers for someone else's host.
 */
export const PLACEHOLDER_SELF_ENDPOINT = 'https://pds.example.invalid';

/** Read the PDS self endpoint from SELF_ENDPOINT, or the placeholder above. */
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
  serviceEndpoint: PLACEHOLDER_SELF_ENDPOINT,
  fetchTimeoutMs: 5_000,
  maxDocumentBytes: 64 * 1024,
  allowLocalhost: false,
};

export const DEFAULT_ADMISSION_CONFIG: AdmissionConfig = {
  collectionAllowlist: [...DEFAULT_ALLOWED_COLLECTIONS],
  maxDidsPerRegistrableDomain: 8,
  newDidRateLimit: { max: 4, windowMs: 60 * 60 * 1000 },
  globalNewDidRateLimit: { max: 240, windowMs: 60 * 60 * 1000 },
};
