import { lookup as dnsLookup } from 'node:dns/promises';
import { formatDidKey, parseMultikey } from '@atproto/crypto';
import type { ResolverConfig } from '../config.js';
import {
  guardedFetch,
  GuardedFetchError,
  type GuardedResponse,
  type HostResolver,
} from '../net/guarded-fetch.js';
import { isBlockedAddress } from '../net/ssrf.js';

// Re-export the shared SSRF predicate so existing importers keep working.
export { isBlockedAddress };

/** A did:web resolution or validation failure. `code` is stable for tests/callers. */
export class DidWebError extends Error {
  constructor(
    readonly code: DidWebErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DidWebError';
  }
}

export type DidWebErrorCode =
  | 'not-did-web'
  | 'path-components'
  | 'port-not-allowed'
  | 'empty-host'
  | 'blocked-address'
  | 'dns-failure'
  | 'https-only'
  | 'cross-host-redirect'
  | 'too-many-redirects'
  | 'response-too-large'
  | 'http-status'
  | 'invalid-json'
  | 'invalid-document'
  | 'wrong-service-endpoint'
  | 'timeout';

/** The atproto signing key advertised by a did.json, in the forms callers need. */
export interface AtprotoKey {
  /** The `publicKeyMultibase` string from the `#atproto` verification method. */
  multikey: string;
  /** The same key as a `did:key`, ready for `@atproto/crypto` verification. */
  didKey: string;
  /** JWT alg, e.g. `ES256K` / `ES256`. */
  jwtAlg: string;
}

/** A validated did:web identity. */
export interface ResolvedDidWeb {
  did: string;
  host: string;
  atprotoKey: AtprotoKey;
  pdsEndpoint: string;
  alsoKnownAs: string[];
  document: DidDocument;
}

/** The subset of the DID document we read. */
export interface DidDocument {
  id?: unknown;
  alsoKnownAs?: unknown;
  verificationMethod?: unknown;
  service?: unknown;
}

/**
 * A guarded transport: given a URL and the guard options, resolve-and-pin the
 * host and return the fetched, size-capped bytes. The production implementation
 * is {@link guardedFetch}; tests inject a fake to drive rebinding and redirect
 * scenarios deterministically.
 */
export type GuardedTransport = (
  url: string,
  opts: {
    timeoutMs: number;
    maxBytes: number;
    maxRedirects: number;
    allowHosts?: Set<string>;
    resolver?: HostResolver;
  },
) => Promise<GuardedResponse>;

/** Injected side-effecting dependencies, so the core logic stays testable. */
export interface ResolverDeps {
  /**
   * Resolve a hostname to one or more IP address strings. This is the *single*
   * DNS resolution per fetch - the guarded transport validates these addresses
   * and pins the chosen one as the dial target, so there is no second lookup a
   * hostile origin could answer differently (DNS-rebinding fix).
   */
  resolver: HostResolver;
  /** The guarded transport. Defaults to {@link guardedFetch}. */
  transport: GuardedTransport;
}

const DID_WEB_PREFIX = 'did:web:';
const MAX_REDIRECTS = 3;

// ---------------------------------------------------------------------------
// Pure: parse a did:web into the URL we would fetch.
// ---------------------------------------------------------------------------

export interface ParsedDidWeb {
  host: string;
  /** host with :port if a port survived (only possible for localhost in test mode). */
  authority: string;
  url: string;
}

/**
 * Parse `did:web:host[%3Aport]` into the did.json URL.
 *
 * atproto supports hostname-only did:web, so any additional colon-separated
 * path segments are rejected. Ports are
 * rejected unless the host is `localhost` and the config allows it.
 */
export function parseDidWeb(did: string, config: ResolverConfig): ParsedDidWeb {
  if (!did.startsWith(DID_WEB_PREFIX)) {
    throw new DidWebError('not-did-web', `Not a did:web: ${did}`);
  }
  const msid = did.slice(DID_WEB_PREFIX.length);
  const segments = msid.split(':');
  // did:web:example.com:foo -> path components. Reject.
  if (segments.length > 1) {
    throw new DidWebError(
      'path-components',
      `Path components are not supported (hostname-only): ${did}`,
    );
  }
  const first = segments[0] ?? '';
  // Colon in the host is percent-encoded per the did:web spec.
  const authority = decodeURIComponent(first);
  if (authority.length === 0) {
    throw new DidWebError('empty-host', `Empty host: ${did}`);
  }

  let host = authority;
  let hasPort = false;
  const colon = authority.indexOf(':');
  if (colon !== -1) {
    host = authority.slice(0, colon);
    hasPort = true;
  }
  if (host.length === 0) {
    throw new DidWebError('empty-host', `Empty host: ${did}`);
  }

  if (hasPort) {
    const localhostAllowed = config.allowLocalhost && host === 'localhost';
    if (!localhostAllowed) {
      throw new DidWebError(
        'port-not-allowed',
        `Ports are not allowed (except localhost in test mode): ${did}`,
      );
    }
  }

  return {
    host,
    authority,
    url: `https://${authority}/.well-known/did.json`,
  };
}

// ---------------------------------------------------------------------------
// Pure: validate a parsed did.json against our requirements.
// ---------------------------------------------------------------------------

interface VerificationMethod {
  id: string;
  type: string;
  publicKeyMultibase?: string;
}

interface Service {
  id: string;
  type: string;
  serviceEndpoint: string;
}

/**
 * Validate the DID document's structure and extract the atproto key + PDS
 * endpoint. Enforces the `#atproto` Multikey, the `#atproto_pds`
 * AtprotoPersonalDataServer service, an `at://` alsoKnownAs, and that the
 * service endpoint is exactly our configured hostname.
 */
export function validateDidDocument(
  did: string,
  doc: DidDocument,
  config: ResolverConfig,
): { atprotoKey: AtprotoKey; pdsEndpoint: string; alsoKnownAs: string[] } {
  // The DID document's `id` MUST be present and exactly equal to the DID (W3C
  // DID core + atproto). A missing or non-string `id` was previously skipped by
  // a `typeof === 'string' &&` guard, so a doc with no `id`, `id: 123`, or
  // `id: ["did:web:x"]` slipped through the identity check (F-7). Require it.
  if (typeof doc.id !== 'string') {
    throw new DidWebError('invalid-document', 'Document id is missing or not a string');
  }
  if (doc.id !== did) {
    throw new DidWebError(
      'invalid-document',
      `Document id ${doc.id} does not match ${did}`,
    );
  }

  const alsoKnownAs = Array.isArray(doc.alsoKnownAs)
    ? doc.alsoKnownAs.filter((v): v is string => typeof v === 'string')
    : [];
  if (!alsoKnownAs.some((aka) => aka.startsWith('at://'))) {
    throw new DidWebError(
      'invalid-document',
      'No alsoKnownAs entry prefixed at://',
    );
  }

  const methods = Array.isArray(doc.verificationMethod)
    ? (doc.verificationMethod as unknown[])
    : [];
  const atproto = methods.find(
    (m): m is VerificationMethod =>
      isObject(m) &&
      typeof m.id === 'string' &&
      m.id.endsWith('#atproto') &&
      m.type === 'Multikey',
  );
  if (!atproto) {
    throw new DidWebError(
      'invalid-document',
      'No verificationMethod with id ending #atproto and type Multikey',
    );
  }
  if (typeof atproto.publicKeyMultibase !== 'string') {
    throw new DidWebError(
      'invalid-document',
      '#atproto verification method has no publicKeyMultibase',
    );
  }

  let atprotoKey: AtprotoKey;
  try {
    const parsed = parseMultikey(atproto.publicKeyMultibase);
    atprotoKey = {
      multikey: atproto.publicKeyMultibase,
      didKey: formatDidKey(parsed.jwtAlg, parsed.keyBytes),
      jwtAlg: parsed.jwtAlg,
    };
  } catch (err) {
    throw new DidWebError(
      'invalid-document',
      `#atproto key is not a valid Multikey: ${(err as Error).message}`,
    );
  }

  const services = Array.isArray(doc.service) ? (doc.service as unknown[]) : [];
  const pds = services.find(
    (s): s is Service =>
      isObject(s) &&
      typeof s.id === 'string' &&
      s.id.endsWith('#atproto_pds') &&
      s.type === 'AtprotoPersonalDataServer',
  );
  if (!pds) {
    throw new DidWebError(
      'invalid-document',
      'No service with id ending #atproto_pds and type AtprotoPersonalDataServer',
    );
  }
  if (typeof pds.serviceEndpoint !== 'string') {
    throw new DidWebError('invalid-document', 'PDS serviceEndpoint is not a string');
  }

  // The endpoint must be exactly the hostname we serve.
  // The AppView/indexer sets skipEndpointCheck: it is not a PDS and resolves any
  // publisher's doc just to read the #atproto key.
  if (!config.skipEndpointCheck && !endpointsEqual(pds.serviceEndpoint, config.serviceEndpoint)) {
    throw new DidWebError(
      'wrong-service-endpoint',
      `serviceEndpoint ${pds.serviceEndpoint} is not ${config.serviceEndpoint}`,
    );
  }

  return { atprotoKey, pdsEndpoint: pds.serviceEndpoint, alsoKnownAs };
}

// ---------------------------------------------------------------------------
// Orchestrator: parse -> DNS guard -> guarded fetch -> validate.
// ---------------------------------------------------------------------------

export function defaultResolverDeps(): ResolverDeps {
  return {
    resolver: async (host: string) => {
      const results = await dnsLookup(host, { all: true });
      return results.map((r) => r.address);
    },
    transport: guardedFetch,
  };
}

export async function resolveDidWeb(
  did: string,
  config: ResolverConfig,
  deps: ResolverDeps = defaultResolverDeps(),
): Promise<ResolvedDidWeb> {
  const parsed = parseDidWeb(did, config);

  const doc = await fetchDidDocument(parsed, config, deps);
  const { atprotoKey, pdsEndpoint, alsoKnownAs } = validateDidDocument(
    did,
    doc,
    config,
  );

  return {
    did,
    host: parsed.host,
    atprotoKey,
    pdsEndpoint,
    alsoKnownAs,
    document: doc,
  };
}

async function fetchDidDocument(
  parsed: ParsedDidWeb,
  config: ResolverConfig,
  deps: ResolverDeps,
): Promise<DidDocument> {
  // The localhost escape hatch: in test mode, exempt localhost from the
  // address-block check (it will resolve to loopback). The address is still
  // resolved and pinned; only the block predicate is skipped.
  const allowHosts =
    config.allowLocalhost && parsed.host === 'localhost'
      ? new Set(['localhost'])
      : undefined;

  let res: GuardedResponse;
  try {
    res = await deps.transport(parsed.url, {
      timeoutMs: config.fetchTimeoutMs,
      maxBytes: config.maxDocumentBytes,
      maxRedirects: MAX_REDIRECTS,
      ...(allowHosts ? { allowHosts } : {}),
      resolver: deps.resolver,
    });
  } catch (err) {
    throw mapGuardedError(err);
  }

  if (res.status !== 200) {
    throw new DidWebError('http-status', `Unexpected status ${res.status} for ${res.url}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(res.body));
  } catch (err) {
    throw new DidWebError('invalid-json', `did.json is not valid JSON: ${(err as Error).message}`);
  }
  if (!isObject(json)) {
    throw new DidWebError('invalid-json', 'did.json is not a JSON object');
  }
  return json as DidDocument;
}

/** Translate a guarded-transport error into the resolver's stable error codes. */
function mapGuardedError(err: unknown): DidWebError {
  if (err instanceof GuardedFetchError) {
    // The guarded-fetch codes are a superset that maps 1:1 onto ours.
    return new DidWebError(err.code as DidWebErrorCode, err.message);
  }
  return new DidWebError('dns-failure', `Fetch failed: ${(err as Error).message}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function endpointsEqual(a: string, b: string): boolean {
  return normalizeEndpoint(a) === normalizeEndpoint(b);
}

function normalizeEndpoint(endpoint: string): string {
  try {
    const u = new URL(endpoint);
    // Compare scheme + host (incl. port), ignore a trailing slash on the path.
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return endpoint.replace(/\/+$/, '');
  }
}
