import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lexicons, type LexiconDoc } from '@atproto/lexicon';
import { log } from '../log.js';

/**
* Per-record lexicon validation for the ingest path (SPEC-COMPLIANCE §4,
 * closing F-2 / Q6). The feed parser already enforces the collection allowlist,
 * NSID/rkey syntax, duplicate keys, and "is a JSON object" - but it does NOT
 * check that a record actually matches its committed lexicon. That gap is the
 * only place an unvalidated payload reaches a signed commit: a malformed
 * `org.peertelemetry.errorMetrics` (or legacy `app.omniroute.errorReport`) would
 * be signed and committed. This module closes it with a pure, in-process
 * predicate - no network, no round-trips.
 *
 * We use `@atproto/lexicon` (already resident via `@atproto/repo`; measured
 * marginal RSS to import it: 0.00 MB) for schema + type + required-field
 * checking. `@atproto/lexicon` is deliberately OPEN-world - it ignores unknown
 * extra properties - so on top of it we add a closed-world guard that rejects
 * any top-level key the lexicon does not declare. That makes a typo'd or
 * injected field a hard reject instead of silently-signed noise.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
/**
 * Committed lexicons live at repo-root `lexicons/`. This file may run from
 * `src/pds-websub/` (tests/tsx) or `dist/src/pds-websub/` (the built binary),
 * and the `lexicons/` tree is NOT copied into `dist/`, so a fixed `../../`
 * relative path is wrong for one of the two. Walk up from this file to the
 * first ancestor that actually contains a `lexicons/` directory.
 */
const LEXICON_DIR = findLexiconDir(__dirname);

/**
 * Locate the committed `lexicons/` directory at the repo root. Robust to being
 * run from `src/pds-websub/` (tests/tsx) or `dist/src/pds-websub/` (the built
 * binary): the `lexicons/` tree is NOT copied into `dist/`, so a fixed relative
 * path is wrong for one of the two. Walk up until an ancestor actually contains
 * a `lexicons/` directory. `NETREPORT_LEXICON_DIR` overrides it explicitly for
 * unusual layouts.
 */
function findLexiconDir(from: string): string {
  const override = process.env.NETREPORT_LEXICON_DIR?.trim();
  if (override) return override;
  let dir = from;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'lexicons');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Not found; return the conventional location so the error message points
  // somewhere sensible rather than at a half-walked path.
  return join(from, '..', '..', 'lexicons');
}

/** null = valid; a string = the human-readable rejection reason. */
export type RecordValidator = (collection: string, record: Record<string, unknown>) => string | null;

/**
 * Build a validator from the committed lexicon JSON files. Loaded ONCE at boot
 * and reused for every record. A collection with no committed lexicon is left
 * to the structural checks (returns valid) - we only tighten collections we
 * actually ship a schema for, so adding a new allowlisted collection never
 * silently starts rejecting until its lexicon lands.
 */
export function buildRecordValidator(lexiconDir: string = LEXICON_DIR): RecordValidator {
  const docs = loadLexiconDocs(lexiconDir);
  const lex = new Lexicons(docs);
// Precompute the declared top-level property names per NSID for the
  // closed-world unknown-field guard.
  const knownProps = new Map<string, Set<string>>();
  for (const doc of docs) {
    const props = topLevelRecordProps(doc);
    if (props) knownProps.set(doc.id, props);
  }
  const validatable = new Set(knownProps.keys());
  log.info('lexicon validator ready', { collections: [...validatable] });

  return (collection, record) => {
    if (!validatable.has(collection)) return null; // no committed schema -> structural only
// 1. Schema + type + required-field validation via @atproto/lexicon.
    const res = lex.validate(collection, record);
    if (!res.success) {
      return `record does not match lexicon ${collection}: ${res.error}`;
    }
// 2. Closed-world guard: reject any top-level field the lexicon does not
    // declare (@atproto/lexicon is open-world and would accept it).
    const allowed = knownProps.get(collection)!;
    for (const key of Object.keys(record)) {
      if (key === '$type') continue; // discriminator, not a declared property
      if (!allowed.has(key)) {
        return `record for ${collection} has unknown field "${key}" not declared in the lexicon`;
      }
    }
    return null;
  };
}

/** Read + parse every `*.json` lexicon doc under `dir` (recursively). */
function loadLexiconDocs(dir: string): LexiconDoc[] {
  const out: LexiconDoc[] = [];
  const walk = (d: string): void => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.json')) {
        try {
          out.push(JSON.parse(readFileSync(p, 'utf8')) as LexiconDoc);
        } catch (err) {
          log.warn('skipping unparseable lexicon file', { path: p, err: (err as Error).message });
        }
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * The declared top-level property names of a lexicon's `main` record def, if it
 * is a record whose value is an object. Returns null for docs whose `main` is
 * not an object-record (nothing to close-world guard).
 */
function topLevelRecordProps(doc: LexiconDoc): Set<string> | null {
  const main = (doc.defs as Record<string, unknown>)?.main as
    | { type?: string; record?: { type?: string; properties?: Record<string, unknown> } }
    | undefined;
  if (!main || main.type !== 'record') return null;
  const rec = main.record;
  if (!rec || rec.type !== 'object' || !rec.properties) return null;
  return new Set(Object.keys(rec.properties));
}
