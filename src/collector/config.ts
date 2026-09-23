/**
 * Collector configuration. Same shape and same rules as the prober's config -
 * a DID, a destination, and everything else defaulted - because an operator who
 * has set one up should not have to learn a second dialect.
 *
 * CREDENTIALS ARE NEVER IN THIS FILE. The publish target names an environment
 * variable; an app password written into the config is rejected outright, by the
 * prober's own parser, which this module reuses rather than reimplements.
 *
 * THE ONE SETTING THAT IS NOT COSMETIC IS THE CADENCE, AND IT IS NOT HERE. This
 * process runs once and exits; the OS schedules it. The default unit files ship
 * a 30-minute interval, and that number is a hard constraint rather than a taste:
 * Bluesky caps `com.atproto.server.createSession` at 300 per DAY, and every run
 * is a separate process opening a separate session. A 5-minute cadence is 288
 * sessions/day against 300 - no headroom for a single manual run. See the README.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ProberConfigError, parsePublishTarget, type PublishTarget } from '../prober/config.js';
import { DEFAULT_DEDUPE_WINDOW_MS } from './dedupe.js';
import type { CadenceOptions } from './cadence.js';

export const DEFAULT_DISTRO_NAME = 'peertelemetry-collector';

/**
 * How far back a FIRST run looks. Not "everything on disk": a laptop carries
 * five weeks of Claude Code transcripts and AGY prunes nothing at all, so an
 * unbounded first run would publish months of history stamped with today's
 * window and misrepresent every one of those failures as current.
 */
export const DEFAULT_BACKFILL_MS = 24 * 60 * 60 * 1000;

/** Adapter ids this build knows. Config may enable a subset. */
export const KNOWN_SOURCES = ['claude-code', 'codex', 'agy'] as const;
export type SourceId = (typeof KNOWN_SOURCES)[number];

export interface SourceConfig {
  id: SourceId;
  /** Override the adapter's default root. Mostly for tests and odd installs. */
  root?: string;
  enabled: boolean;
}

export interface CollectorConfig {
  publisherDid: string;
  distroName: string;
  distroVersion?: string;
  publish: PublishTarget;
  /** Where cursors and the run lock live. Never holds log content. */
  stateDir: string;
  sources: SourceConfig[];
  /** Burst-collapse window in ms. 0 disables collapsing. */
  dedupeWindowMs: number;
  backfillMs: number;
  serviceType: string;
  /** Publish groups whose source recorded no successful request. See `aggregate.ts`. */
  publishWithoutSuccesses: boolean;
  /**
   * Optional cadence overrides. Anything omitted takes the default, and anything
   * that would breach the session budget is clamped with a warning rather than
   * honoured - see `cadence.ts`. Scanning intervals are advisory to the OS timer;
   * the cooldown and the daily publish allowance are enforced here.
   */
  cadence?: Partial<CadenceOptions>;
}

export function defaultStateDir(home: string = homedir()): string {
  return join(home, '.peertelemetry', 'collector');
}

/** Read and parse a config file. The only impure entry point. */
export function loadCollectorConfig(path: string): CollectorConfig {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new ProberConfigError(`cannot read collector config ${path}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ProberConfigError(
      `collector config ${path} is not valid JSON: ${(err as Error).message}`,
    );
  }
  return parseCollectorConfig(json);
}

/** Validate and default a parsed config value. Pure. */
export function parseCollectorConfig(json: unknown, home: string = homedir()): CollectorConfig {
  const obj = asObject(json, 'config');

  const publisherDid = requiredString(obj.publisherDid, 'publisherDid');
  if (!publisherDid.startsWith('did:')) {
    throw new ProberConfigError(`publisherDid must be a DID, got "${publisherDid}"`);
  }

  const distroVersion = optionalString(obj.distroVersion, 'distroVersion');
  const dedupeWindowMs = optionalNumber(obj.dedupeWindowMs, 'dedupeWindowMs') ?? DEFAULT_DEDUPE_WINDOW_MS;
  if (dedupeWindowMs < 0) {
    throw new ProberConfigError(`dedupeWindowMs must be >= 0, got ${dedupeWindowMs}`);
  }
  const backfillMs = optionalNumber(obj.backfillMs, 'backfillMs') ?? DEFAULT_BACKFILL_MS;
  if (backfillMs < 0) {
    throw new ProberConfigError(`backfillMs must be >= 0, got ${backfillMs}`);
  }
  const cadence = parseCadence(obj.cadence);

  return {
    publisherDid,
    distroName: optionalString(obj.distroName, 'distroName') ?? DEFAULT_DISTRO_NAME,
    ...(distroVersion === undefined ? {} : { distroVersion }),
    publish: parsePublishTarget(obj.publish),
    stateDir: optionalString(obj.stateDir, 'stateDir') ?? defaultStateDir(home),
    sources: parseSources(obj.sources),
    dedupeWindowMs,
    backfillMs,
    serviceType: optionalString(obj.serviceType, 'serviceType') ?? 'llm',
    publishWithoutSuccesses: obj.publishWithoutSuccesses === true,
    ...(cadence === undefined ? {} : { cadence }),
  };
}

/**
 * Cadence overrides. Deliberately NOT range-checked here: `clampCadence` is the
 * single place that decides what the session budget can afford, and duplicating
 * those limits in the parser is how the two drift apart. This only rejects
 * values that are not numbers at all.
 */
function parseCadence(value: unknown): Partial<CadenceOptions> | undefined {
  if (value === undefined || value === null) return undefined;
  const obj = asObject(value, 'cadence');
  const out: Partial<CadenceOptions> = {};
  const keys = [
    'idleScanMs',
    'alertScanMs',
    'alertWindowMs',
    'cooldownMs',
    'maxPublishesPerDay',
  ] as const;
  for (const k of keys) {
    const n = optionalNumber(obj[k], `cadence.${k}`);
    if (n !== undefined) out[k] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `sources` omitted means all known adapters, each of which then decides for
 * itself whether the CLI is installed. An explicit list is how you turn one off
 * without uninstalling anything.
 */
function parseSources(value: unknown): SourceConfig[] {
  if (value === undefined || value === null) {
    return KNOWN_SOURCES.map((id) => ({ id, enabled: true }));
  }
  if (!Array.isArray(value)) throw new ProberConfigError('sources must be an array');
  const seen = new Set<string>();
  return value.map((v, i) => {
    const where = `sources[${i}]`;
    const obj = asObject(v, where);
    const id = requiredString(obj.id, `${where}.id`);
    if (!(KNOWN_SOURCES as readonly string[]).includes(id)) {
      throw new ProberConfigError(
        `${where}.id "${id}" is not one of: ${KNOWN_SOURCES.join(', ')}`,
      );
    }
    if (seen.has(id)) throw new ProberConfigError(`${where}.id "${id}" is listed twice`);
    seen.add(id);
    const root = optionalString(obj.root, `${where}.root`);
    return {
      id: id as SourceId,
      ...(root === undefined ? {} : { root }),
      enabled: obj.enabled !== false,
    };
  });
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
