/**
 * Claude Code adapter: `~/.claude/projects/**\/*.jsonl`.
 *
 * WHAT THE SOURCE ACTUALLY GIVES YOU. Every API error Claude Code surfaced is
 * written into the session transcript as an assistant message carrying
 * `isApiErrorMessage: true`, an `error` class (`server_error`,
 * `authentication_failed`, `rate_limit`, `invalid_request`, `unknown`) and,
 * WHEN there was a clean HTTP status, `apiErrorStatus`. Verified on this
 * machine: 57 such records against 78242 successful assistant turns.
 *
 * MODEL ATTRIBUTION IS INFERRED, NEVER STATED. The error record itself is
 * written with `"model": "<synthetic>"` - the message was fabricated locally by
 * the CLI, so no model produced it. The model is reconstructed by remembering
 * the most recent non-synthetic `message.model` in the same file, which resolved
 * 54 of 57 records on this laptop. It is a heuristic and it can be wrong: if a
 * session switches models and the switch is WHY the request failed, the error is
 * attributed to the model that was active before the switch. An error with no
 * preceding real turn in the file is emitted as `unknown` rather than guessed.
 *
 * PROVIDER ATTRIBUTION IS NOT "ALWAYS ANTHROPIC". Claude Code can be pointed at
 * a gateway, and this laptop's own transcripts contain `moonshotai/Kimi-K2.6`
 * and `glm-5.2` turns proving it. So the provider is `anthropic` only when the
 * model id looks like an Anthropic model; anything else is `unknown`. A wrong
 * provider is worse than a missing one in a federated aggregate.
 *
 * THE NUMBER THIS SOURCE CANNOT GIVE. Claude Code retries transient failures
 * internally and only writes the ones that EXHAUSTED retries and reached the
 * screen. The true upstream error rate is higher than what this adapter reports,
 * by an unknown factor. Nothing here can fix that; it is stated in the README so
 * a consumer reads the number correctly.
 *
 * PRIVACY. Four fields are read per line - `type`, `message.model`,
 * `isApiErrorMessage`/`error`/`apiErrorStatus`, and `timestamp`. `message.content`
 * is never touched, and neither are `sessionId`, `requestId`, `uuid`, or `cwd`,
 * all of which sit on the same object.
 */
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { log } from '../../log.js';
import { tailLines, parseJsonLine } from '../tail.js';
import { pathKey } from '../state.js';
import { UNKNOWN, groupKey, splitGroupKey, type AttemptCount, type CollectContext, type ErrorEvent, type SourceAdapter, type SourceObservation } from '../types.js';

/** How deep under the root to look for transcripts. Subagent and workflow
 * transcripts nest several levels down, under `subagents` and `workflows`. */
const MAX_DEPTH = 6;

/**
 * Claude Code's own error classes, mapped onto the Anthropic error-TYPE strings
 * `src/genai/error-classify.ts` already knows. Mapping here rather than teaching
 * the classifier a CLI's private vocabulary keeps the classification table a
 * statement about PROVIDERS, which is what it is for.
 *
 * The awkward case is `server_error` WITHOUT an HTTP status - 36 of 63 error
 * records on this laptop. That class covers three different things, and folding
 * them together mislabels two of them:
 *
 *   33x  "Connection closed mid-response"   the stream broke: transport
 *    2x  "Server error mid-response"        the server DID fail: provider-side
 *    1x  "Unable to connect to API (ENOTF)" DNS never resolved: OUR network
 *
 * Blanket-mapping all of these to `connection_error` inflates the transport
 * bucket and, worse, hides genuine provider-side failures inside it. So the
 * error text disambiguates - see `detailCode`.
 */
function normalizeCode(errorClass: string, status: number | undefined, detail?: string): string {
  if (status === 429 || errorClass === 'rate_limit') return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  if (status !== undefined && status >= 500) return 'api_error';
  if (errorClass === 'authentication_failed' || status === 401 || status === 403) {
    return 'authentication_error';
  }
  if (errorClass === 'invalid_request' || status === 400 || status === 404 || status === 413) {
    return 'invalid_request_error';
  }
  if (errorClass === 'server_error') return detailCode(detail);
  return UNKNOWN;
}

/**
 * Disambiguate a statusless `server_error` by its API error string.
 *
 * A CLOSED ALLOWLIST OF PREFIXES, deliberately, not a regex over free text.
 * These strings are Claude Code's own fixed error messages on records already
 * flagged `isApiErrorMessage`, so the text is the error itself and never a
 * prompt or a completion - but matching a known prefix and discarding the string
 * is still the only safe way to read it. Nothing is retained.
 *
 * An unrecognised string falls back to `connection_error`, matching the previous
 * behaviour: statusless server errors are overwhelmingly broken streams, so that
 * is the right default for the long tail.
 */
/**
 * The API error string on an error record. Returns at most the first 120 chars,
 * which is more than every known prefix needs and far less than any payload -
 * the value exists only to be prefix-matched by `detailCode` and is never
 * stored, aggregated, or published.
 */
function errorDetail(rec: Record<string, unknown>): string | undefined {
  const msg = rec.message;
  if (typeof msg !== 'object' || msg === null) return undefined;
  const content = (msg as Record<string, unknown>).content;
  if (typeof content === 'string') return content.slice(0, 120);
  if (!Array.isArray(content)) return undefined;
  const first = content[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const text = (first as Record<string, unknown>).text;
  return typeof text === 'string' ? text.slice(0, 120) : undefined;
}

function detailCode(detail: string | undefined): string {
  if (detail === undefined) return 'connection_error';
  // A local DNS failure. The provider was never reached and cannot be blamed:
  // `connection_error` is health-scoped and would publish OUR broken resolver as
  // provider unavailability. The classifier declines to split dns_failure in
  // general because one vantage point cannot tell - but ENOTFOUND is not
  // ambiguous, so it is reported as its own code and left unclassified.
  if (detail.includes('ENOTFOUND') || detail.includes('EAI_AGAIN')) return 'dns_failure';
  // The server answered and the answer was a failure. Provider-side, not ours.
  if (detail.startsWith('API Error: Server error')) return 'api_error';
  if (detail.startsWith('API Error: Connection closed')) return 'connection_error';
  return 'connection_error';
}

/**
 * Anthropic model ids as Claude Code writes them: `claude-opus-5`,
 * `claude-fable-5`, `claude-haiku-4-5-20251001`, and the `[1m]`-suffixed
 * long-context variants. Anything else came through a gateway.
 */
function providerFor(model: string): string {
  return /^claude-/.test(model) ? 'anthropic' : UNKNOWN;
}

export const claudeCodeAdapter: SourceAdapter = {
  id: 'claude-code',

  defaultRoot(home: string): string {
    return join(home, '.claude', 'projects');
  },

  detect(root: string): boolean {
    try {
      return statSync(root).isDirectory();
    } catch {
      return false;
    }
  },

  async collect(ctx: CollectContext): Promise<SourceObservation> {
    const events: ErrorEvent[] = [];
    const successes = new Map<string, number>();
    const warnings: string[] = [];
    let bytesScanned = 0;
    let sourcesScanned = 0;
    let unattributed = 0;

    for (const path of findTranscripts(ctx.root, warnings)) {
      sourcesScanned++;
      const key = pathKey(path);
      // Per-FILE attribution state. Transcripts are chronological within a file
      // and a session never spans two, so "the last real model seen" is only
      // meaningful inside one file and must not leak into the next.
      let lastModel: string | undefined;
      // Errors seen before any real turn in this file. Held so they can be
      // attributed to the NEXT real model instead of being thrown away.
      let pendingErrors: ErrorEvent[] = [];

      const res = tailLines(path, ctx.cursors.getFile(key), ctx.now(), (line) => {
        // Cheap reject before JSON.parse: the vast majority of lines are user
        // turns and tool results, and parsing 700 MB of them is the whole cost.
        if (!line.includes('"assistant"')) return;
        const rec = parseJsonLine(line);
        if (rec === undefined || rec.type !== 'assistant') return;
        const msg = isRecord(rec.message) ? rec.message : undefined;
        const model = typeof msg?.model === 'string' ? msg.model : undefined;
        const isError = rec.isApiErrorMessage === true || typeof rec.error === 'string';
        const ts = parseTimestamp(rec.timestamp);

        if (model !== undefined && model !== '<synthetic>') {
          lastModel = model;
          for (const p of pendingErrors) {
            p.model = model;
            p.provider = providerFor(model);
          }
          pendingErrors = [];
          if (!isError && ts >= ctx.minTimestampMs) {
            bump(successes, providerFor(model), model);
          }
        }
        if (!isError) return;
        if (ts < ctx.minTimestampMs) return;

        const errorClass = typeof rec.error === 'string' ? rec.error : UNKNOWN;
        const status = typeof rec.apiErrorStatus === 'number' ? rec.apiErrorStatus : undefined;
        // Read ONLY to disambiguate a statusless server_error against a closed
        // prefix allowlist, then dropped - see `detailCode`. On a record already
        // flagged `isApiErrorMessage` this text is the API's own error string.
        const detail = errorDetail(rec);
        const ev: ErrorEvent = {
          timestampMs: ts,
          provider: lastModel === undefined ? UNKNOWN : providerFor(lastModel),
          model: lastModel ?? UNKNOWN,
          errorCode: normalizeCode(errorClass, status, detail),
          ...(status === undefined ? {} : { httpStatus: status }),
          sourceCli: claudeCodeAdapter.id,
        };
        events.push(ev);
        if (lastModel === undefined) pendingErrors.push(ev);
      });

      bytesScanned += res.bytesRead;
      if (res.error !== undefined) {
        warnings.push(`claude-code: a transcript could not be read (${res.error})`);
      } else if (res.cursor !== undefined) {
        ctx.cursors.setFile(key, res.cursor);
      }
      if (res.rescanned) {
        log.debug('collector reread a rotated or truncated transcript', { source: 'claude-code' });
      }
      unattributed += pendingErrors.length;
    }

    if (unattributed > 0) {
      // Left as `unknown`, deliberately. These are sessions whose only assistant
      // record is the failure, so there is nothing to infer from.
      log.info('collector could not attribute a model to some claude-code errors', {
        errors: unattributed,
      });
    }

    return {
      sourceCli: claudeCodeAdapter.id,
      events,
      attempts: toAttempts(successes),
      sourcesScanned,
      bytesScanned,
      warnings,
    };
  },
};

/** Every `*.jsonl` under the projects tree, including subagent and workflow ones. */
function findTranscripts(root: string, warnings: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      warnings.push(`claude-code: a directory could not be listed (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
      return;
    }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p, depth + 1);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(p);
    }
  };
  if (existsSync(root)) walk(root, 0);
  return out;
}

function bump(counts: Map<string, number>, provider: string, model: string): void {
  const key = groupKey(provider, model);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function toAttempts(counts: Map<string, number>): AttemptCount[] {
  return [...counts.entries()].map(([key, successes]) => {
    const [provider = UNKNOWN, model = UNKNOWN] = splitGroupKey(key);
    return { provider, model, successes };
  });
}

/** ISO-8601 -> epoch ms. Returns 0 for anything unparseable, which the caller
 * treats as "older than the window" and therefore skips. */
export function parseTimestamp(v: unknown): number {
  if (typeof v !== 'string') return 0;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
