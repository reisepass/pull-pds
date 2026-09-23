/**
 * Prober configuration: one small JSON file describing which endpoints to probe
 * and where to write the resulting records.
 *
 * SETUP FRICTION IS THE PRODUCT. Everything that can have a defensible default
 * has one, so a working config is a DID, a publish target, and a list of
 * endpoints - roughly ten lines. Nothing here reads the environment implicitly
 * at call time except credential *names*; the parse is a pure function over a
 * parsed JSON value so tests construct their own input (the `src/config.ts`
 * convention).
 *
 * CREDENTIALS ARE NEVER IN THIS FILE. An endpoint names an environment variable
 * (`apiKeyEnv`) or a file path (`apiKeyFile`); the key itself is read at probe
 * time by `resolveCredential` and never logged, never stored on the config
 * object, and never written to a record. A config that inlines a literal key is
 * rejected outright rather than quietly working, because a working shortcut is
 * how keys end up in git.
 */
import { readFileSync } from 'node:fs';
import { ensureValidRecordKey } from '@atproto/syntax';

/** A config the operator must fix. Never thrown for a probe failure. */
export class ProberConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProberConfigError';
  }
}

/**
 * The request dialect to speak. Only two, because they cover the field: every
 * OpenAI-compatible gateway (vLLM, Groq, Together, OpenRouter, LiteLLM, xAI,
 * Mistral, Ollama's compat route, and Gemini's own OpenAI-compat endpoint)
 * takes `openai`, and Anthropic's native Messages API takes `anthropic`.
 * Adding a third dialect is a case in `src/prober/probe.ts`, not a redesign.
 */
export type WireProtocol = 'openai' | 'anthropic';

/** One endpoint to probe, fully defaulted. */
export interface EndpointConfig {
  /**
   * OTel `gen_ai.provider.name`. Also the classification key - it selects the
   * per-provider table in `src/genai/error-classify.ts`, so use the well-known
   * value (`openai`, `anthropic`, `aws.bedrock`, `gcp.gemini`, ...) when the
   * provider has one, or an alias the classifier knows.
   */
  provider: string;
  /** OTel `gen_ai.request.model`. Omitted for providers with no model dimension. */
  model?: string;
  /** Base URL the probe request is built against. HTTPS only. */
  baseUrl: string;
  /** Path appended to `baseUrl`; defaults per wire protocol. */
  path: string;
  wire: WireProtocol;
  /** Env var holding the API key. Mutually exclusive with `apiKeyFile`. */
  apiKeyEnv?: string;
  /** File holding the API key (trimmed). Mutually exclusive with `apiKeyEnv`. */
  apiKeyFile?: string;
  /** Record key for this endpoint's record. Derived unless set explicitly. */
  rkey: string;
  /** Probes per run. 1 by default - the cheapest thing that still tells you something. */
  attempts: number;
  /** Hard per-probe timeout in ms. */
  timeoutMs: number;
  /** `serviceType` on the emitted record (open vocab; `llm` here). */
  serviceType: string;
}

/**
 * Where records go. The daemon only ever sees the {@link Publisher} interface,
 * so a new destination is a new case here plus a class in `publish.ts`.
 *
 * `bluesky` writes straight into an atproto repo with an app password. The open
 * question it was blocked on is now answered against a real Bluesky-hosted PDS:
 * an app-password session (scope `com.atproto.appPass`, the reduced one) is
 * allowed to write, a record under a custom lexicon is accepted (the PDS cannot
 * resolve the schema, so it stores it with `validationStatus: "unknown"`), and
 * the commit reaches the firehose. See `publish.ts`.
 */
export type PublishTarget =
  | { kind: 'file'; path: string }
  | { kind: 'dryrun' }
  | {
      kind: 'bluesky';
      /** PDS or entryway base URL. HTTPS only. Defaults to `https://bsky.social`. */
      service: string;
      /** Handle or DID to authenticate as, e.g. `node.example.social`. */
      identifier: string;
      /** Env var holding the APP PASSWORD. Never the password itself. */
      passwordEnv: string;
    };

export interface ProberConfig {
  /**
   * The publishing DID. The file publisher writes an `app.pullpds.feed`
   * snapshot claiming this DID, and the pull-PDS rejects a feed whose `did`
   * does not match the DID it is ingesting for, so this must be the real one.
   */
  publisherDid: string;
  /** OTel `telemetry.distro.name` - who produced the record. Required by the lexicon. */
  distroName: string;
  /** OTel `telemetry.distro.version`. */
  distroVersion?: string;
  publish: PublishTarget;
  /**
   * Permit endpoints that resolve to loopback/private addresses (a local vLLM
   * or Ollama). Off by default; the outbound guard blocks them otherwise. Still
   * HTTPS-only - see `probe.ts`.
   */
  allowLocalhost: boolean;
  endpoints: EndpointConfig[];
}

/** Default per-wire request path appended to `baseUrl`. */
const DEFAULT_PATHS: Record<WireProtocol, string> = {
  openai: '/chat/completions',
  anthropic: '/v1/messages',
};

/**
 * Wire protocol inferred from the provider name when the config does not say.
 * Anything not listed defaults to `openai`, which is the ecosystem default.
 */
const WIRE_BY_PROVIDER: Record<string, WireProtocol> = {
  anthropic: 'anthropic',
};

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_DISTRO_NAME = 'peertelemetry-prober';

/** Read and parse a config file. The only impure entry point. */
export function loadProberConfig(path: string, env: NodeJS.ProcessEnv = process.env): ProberConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ProberConfigError(`cannot read prober config ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ProberConfigError(`prober config ${path} is not valid JSON: ${(err as Error).message}`);
  }
  return parseProberConfig(json, env);
}

/**
 * Validate and default a parsed config value. Pure. Every rejection names the
 * offending field, because a config error at 03:00 under cron is only ever read
 * in a log line.
 */
export function parseProberConfig(json: unknown, env: NodeJS.ProcessEnv = process.env): ProberConfig {
  const obj = asObject(json, 'config');

  const publisherDid = requiredString(obj.publisherDid, 'publisherDid');
  if (!publisherDid.startsWith('did:')) {
    throw new ProberConfigError(`publisherDid must be a DID, got "${publisherDid}"`);
  }

  const publish = parsePublishTarget(obj.publish);
  const rawEndpoints = obj.endpoints;
  if (!Array.isArray(rawEndpoints) || rawEndpoints.length === 0) {
    throw new ProberConfigError('endpoints must be a non-empty array');
  }

  const defaultServiceType = optionalString(obj.serviceType, 'serviceType') ?? 'llm';
  const defaultTimeoutMs = optionalNumber(obj.timeoutMs, 'timeoutMs') ?? DEFAULT_TIMEOUT_MS;
  const defaultAttempts = optionalNumber(obj.attempts, 'attempts') ?? 1;

  const endpoints = rawEndpoints.map((e, i) =>
    parseEndpoint(e, i, { defaultServiceType, defaultTimeoutMs, defaultAttempts }),
  );

  // Two endpoints writing the same rkey would silently overwrite each other in
  // one feed snapshot; that is a data-loss bug, not a warning.
  const seen = new Set<string>();
  for (const ep of endpoints) {
    if (seen.has(ep.rkey)) {
      throw new ProberConfigError(
        `duplicate rkey "${ep.rkey}" - two endpoints would overwrite each other; set an explicit "rkey" on one`,
      );
    }
    seen.add(ep.rkey);
  }

  const distroVersion = optionalString(obj.distroVersion, 'distroVersion');
  return {
    publisherDid,
    distroName: optionalString(obj.distroName, 'distroName') ?? DEFAULT_DISTRO_NAME,
    ...(distroVersion === undefined ? {} : { distroVersion }),
    publish,
    allowLocalhost: obj.allowLocalhost === true,
    endpoints,
  };
}

/**
 * Exported so the local collector (`src/collector/config.ts`) parses a publish
 * target by exactly the same rules - including the rejection of an inlined app
 * password - rather than growing a second, subtly different copy.
 */
export function parsePublishTarget(value: unknown): PublishTarget {
  if (value === undefined) return { kind: 'dryrun' }; // safe default: emit nothing
  const obj = asObject(value, 'publish');
  const kind = requiredString(obj.kind, 'publish.kind');
  switch (kind) {
    case 'file':
      return { kind: 'file', path: requiredString(obj.path, 'publish.path') };
    case 'dryrun':
      return { kind: 'dryrun' };
    case 'bluesky':
      return parseBlueskyTarget(obj);
    default:
      throw new ProberConfigError(
        `publish.kind "${kind}" is not one of: file, dryrun, bluesky`,
      );
  }
}

/** Default entryway when a bluesky target names no service. */
export const DEFAULT_BLUESKY_SERVICE = 'https://bsky.social';

/**
 * The `bluesky` publish target. Same credential rule as an endpoint: the config
 * names an ENV VAR, never a password. An app password in a committed config
 * file is a full-repo write credential in git, so a literal is rejected outright
 * rather than accepted with a warning.
 */
function parseBlueskyTarget(obj: Record<string, unknown>): PublishTarget {
  for (const banned of ['password', 'appPassword', 'app_password', 'token', 'accessJwt']) {
    if (obj[banned] !== undefined) {
      throw new ProberConfigError(
        `publish.${banned} is not allowed - credentials never live in the config file; use "passwordEnv"`,
      );
    }
  }
  const service = optionalString(obj.service, 'publish.service') ?? DEFAULT_BLUESKY_SERVICE;
  let parsed: URL;
  try {
    parsed = new URL(service);
  } catch {
    throw new ProberConfigError(`publish.service is not a URL: "${service}"`);
  }
  if (parsed.protocol !== 'https:') {
    throw new ProberConfigError(
      `publish.service must be https (an app password over cleartext is not a thing to make easy), got "${service}"`,
    );
  }
  return {
    kind: 'bluesky',
    service: service.replace(/\/+$/, ''),
    identifier: requiredString(obj.identifier, 'publish.identifier'),
    passwordEnv: requiredString(obj.passwordEnv, 'publish.passwordEnv'),
  };
}

interface EndpointDefaults {
  defaultServiceType: string;
  defaultTimeoutMs: number;
  defaultAttempts: number;
}

function parseEndpoint(value: unknown, index: number, d: EndpointDefaults): EndpointConfig {
  const where = `endpoints[${index}]`;
  const obj = asObject(value, where);

  const provider = requiredString(obj.provider, `${where}.provider`);
  const model = optionalString(obj.model, `${where}.model`);
  const baseUrl = requiredString(obj.baseUrl, `${where}.baseUrl`).replace(/\/+$/, '');
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new ProberConfigError(`${where}.baseUrl is not a URL: "${baseUrl}"`);
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new ProberConfigError(
      `${where}.baseUrl must be https (the outbound guard is HTTPS-only), got "${baseUrl}"`,
    );
  }

  const wireRaw = optionalString(obj.wire, `${where}.wire`);
  if (wireRaw !== undefined && wireRaw !== 'openai' && wireRaw !== 'anthropic') {
    throw new ProberConfigError(`${where}.wire must be "openai" or "anthropic", got "${wireRaw}"`);
  }
  const wire: WireProtocol =
    wireRaw ?? WIRE_BY_PROVIDER[provider.trim().toLowerCase()] ?? 'openai';

  // A literal key in the config file is rejected, not accepted-with-a-warning:
  // the config is a file people commit, and a shortcut that works is how keys
  // reach git. Name an env var or a file instead.
  for (const banned of ['apiKey', 'api_key', 'key', 'token', 'authorization']) {
    if (obj[banned] !== undefined) {
      throw new ProberConfigError(
        `${where}.${banned} is not allowed - credentials never live in the config file; use "apiKeyEnv" or "apiKeyFile"`,
      );
    }
  }
  const apiKeyEnv = optionalString(obj.apiKeyEnv, `${where}.apiKeyEnv`);
  const apiKeyFile = optionalString(obj.apiKeyFile, `${where}.apiKeyFile`);
  if (apiKeyEnv !== undefined && apiKeyFile !== undefined) {
    throw new ProberConfigError(`${where}: set apiKeyEnv or apiKeyFile, not both`);
  }

  const attempts = optionalNumber(obj.attempts, `${where}.attempts`) ?? d.defaultAttempts;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) {
    // Cheap probes stay cheap. A prober is not a load generator.
    throw new ProberConfigError(`${where}.attempts must be an integer 1-10, got ${attempts}`);
  }
  const timeoutMs = optionalNumber(obj.timeoutMs, `${where}.timeoutMs`) ?? d.defaultTimeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100) {
    throw new ProberConfigError(`${where}.timeoutMs must be >= 100, got ${timeoutMs}`);
  }

  const rkey = optionalString(obj.rkey, `${where}.rkey`) ?? deriveRkey(provider, model);
  try {
    ensureValidRecordKey(rkey);
  } catch (err) {
    throw new ProberConfigError(
      `${where}: derived rkey "${rkey}" is not a valid atproto record key (${(err as Error).message}); set an explicit "rkey"`,
    );
  }

  return {
    provider,
    ...(model === undefined ? {} : { model }),
    baseUrl,
    path: optionalString(obj.path, `${where}.path`) ?? DEFAULT_PATHS[wire],
    wire,
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(apiKeyFile === undefined ? {} : { apiKeyFile }),
    rkey,
    attempts,
    timeoutMs,
    serviceType: optionalString(obj.serviceType, `${where}.serviceType`) ?? d.defaultServiceType,
  };
}

/**
 * `provider` alone when there is no model (the lexicon's documented convention:
 * "rkey is typically the provider name"), else `provider_model` with characters
 * atproto record keys forbid folded to `-`. Model ids routinely contain `/`
 * (`meta-llama/Llama-3-8b`), which is not a legal rkey character.
 */
export function deriveRkey(provider: string, model?: string): string {
  const clean = (s: string): string => s.replace(/[^A-Za-z0-9.\-_~]/g, '-');
  return model ? `${clean(provider)}_${clean(model)}` : clean(provider);
}

/**
 * Resolve an endpoint's credential at probe time. Returns undefined when the
 * endpoint declares none (a public or keyless endpoint is legitimate).
 *
 * The returned string is passed straight into a request header and is never
 * logged, stored on the config, or included in any record or error message -
 * note that the failure messages below name the env var or path, never a value.
 */
export function resolveCredential(
  ep: EndpointConfig,
  env: NodeJS.ProcessEnv = process.env,
  readFile: (p: string) => string = (p) => readFileSync(p, 'utf8'),
): string | undefined {
  if (ep.apiKeyEnv !== undefined) {
    const v = env[ep.apiKeyEnv]?.trim();
    if (!v) {
      throw new ProberConfigError(`${ep.rkey}: env var ${ep.apiKeyEnv} is unset or empty`);
    }
    return v;
  }
  if (ep.apiKeyFile !== undefined) {
    let v: string;
    try {
      v = readFile(ep.apiKeyFile).trim();
    } catch (err) {
      throw new ProberConfigError(
        `${ep.rkey}: cannot read apiKeyFile ${ep.apiKeyFile}: ${(err as Error).message}`,
      );
    }
    if (!v) throw new ProberConfigError(`${ep.rkey}: apiKeyFile ${ep.apiKeyFile} is empty`);
    return v;
  }
  return undefined;
}

function asObject(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ProberConfigError(`${where} must be a JSON object`);
  }
  return v as Record<string, unknown>;
}

function requiredString(v: unknown, where: string): string {
  const s = optionalString(v, where);
  if (s === undefined) throw new ProberConfigError(`${where} is required`);
  return s;
}

function optionalString(v: unknown, where: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ProberConfigError(`${where} must be a string`);
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

function optionalNumber(v: unknown, where: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new ProberConfigError(`${where} must be a finite number`);
  }
  return v;
}
