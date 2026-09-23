/**
 * AGY (`antigravity-cli`) adapter: `~/.gemini/antigravity-cli/log/cli-*.log`.
 *
 * THE BEST OF THE THREE SOURCES, and not for the reason the research suggested.
 * AGY logs every model HTTP request in glog format with the FULL Vertex AI URL,
 * which carries the model in its path:
 *
 *   I0801 ... URL: https://aiplatform.googleapis.com/v1/projects/<p>/locations/
 *             global/publishers/google/models/gemini-3.6-flash:streamGenerateContent
 *             ?alt=sse ResponseID: <id>
 *
 * So unlike Claude Code, AGY needs no inference at all: provider comes from the
 * HOST and model from the URL path, both stated. It logs SUCCESSES at `I` and
 * failures at `E`, which means this is also the only source that yields a real
 * denominator from the same file as the numerator. It even logs
 * `Encountered retryable api error. retrying in 1s` at `I`, so RETRIED failures
 * are visible here - the number Claude Code's transcripts structurally cannot
 * give.
 *
 * THE TRAP, WHICH IS LARGE. 2829 of the ~3000 `E` lines on this laptop are
 *
 *   Post "https://play.googleapis.com/log": dial tcp: lookup
 *   play.googleapis.com: no such host
 *
 * That is AGY's OWN analytics upload failing, not a model call. Counting glog
 * `E` lines as model errors - which the obvious `grep -c " E[0-9]"` does - would
 * report ~3000 provider failures where there are about 40. Only lines naming a
 * host on {@link MODEL_HOSTS} are counted, and the model must be present in the
 * URL; everything else is ignored entirely.
 *
 * THE SECOND TRAP. `context canceled by user` (11 lines here) is the user
 * pressing escape. It is a local interruption, not a provider failure, and it is
 * dropped rather than classified.
 *
 * PRIVACY. These lines contain the local LAN IP and the remote Google IP of
 * every failed connection (`read tcp 192.168.x.y:59316->142.250.181.234:443`).
 * Nothing of the sort is extracted: the adapter pulls the model out of the URL
 * path, matches the failure against a fixed phrase table, and discards the line.
 *
 * RETENTION. AGY prunes nothing, so this source keeps growing. That is good for
 * history and is exactly why the cursor matters here.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tailLines } from '../tail.js';
import { pathKey } from '../state.js';
import { toAttempts } from './claude-code.js';
import { UNKNOWN, groupKey, type CollectContext, type ErrorEvent, type SourceAdapter, type SourceObservation } from '../types.js';

/**
 * Hosts whose requests are model inference. Everything else AGY talks to
 * (`play.googleapis.com` analytics, `cloudcode-pa.googleapis.com` experiments,
 * driver downloads) is not a provider signal and must not become one.
 */
const MODEL_HOSTS: Record<string, string> = {
  'aiplatform.googleapis.com': 'gcp.vertex_ai',
  'generativelanguage.googleapis.com': 'gcp.gemini',
};

/** `.../publishers/google/models/<model>:<method>` or `/models/<model>:<method>`. */
const MODEL_IN_URL = /\/models\/([^/:?"\s]+):/;
const HOST_IN_URL = /https?:\/\/([^/"\s]+)/;

/**
 * glog line prefix: `E0730 17:34:05.354991      37 client.go:68] <message>`.
 * The severity letter, month/day, and time are all we take from it; the PID and
 * source location are ignored.
 */
const GLOG = /\b([IWE])(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{6})\s+\d+\s+(?:[^\s:]+:\d+\]\s+)?(.*)$/;

/** Filename stamp `cli-20260730_160704.log`, the only place the YEAR appears. */
const FILENAME_STAMP = /^cli-(\d{4})(\d{2})(\d{2})_\d{6}\.log$/;

/**
 * Failure phrases -> the provider error-code strings the classifier knows.
 * Ordered: the first match wins, so the specific gRPC statuses are tested
 * before the generic transport phrases.
 *
 * `resource_exhausted` is emitted deliberately UNMAPPED in the classifier's
 * gcp table: Google's RESOURCE_EXHAUSTED conflates provider throttling (health)
 * with account quota (account) and the status string alone cannot tell them
 * apart, so it lands in the visible `unclassified[]` bucket rather than being
 * asserted as either.
 */
const FAILURE_PHRASES: readonly { readonly match: RegExp; readonly code: string }[] = [
  { match: /RESOURCE_EXHAUSTED/i, code: 'resource_exhausted' },
  { match: /DEADLINE_EXCEEDED/i, code: 'deadline_exceeded' },
  { match: /UNAVAILABLE/i, code: 'unavailable' },
  { match: /\bINTERNAL\b/, code: 'internal' },
  { match: /PERMISSION_DENIED|not logged into/i, code: 'permission_denied' },
  { match: /UNAUTHENTICATED|token source/i, code: 'unauthenticated' },
  { match: /INVALID_ARGUMENT/i, code: 'invalid_argument' },
  { match: /\bNOT_FOUND\b/i, code: 'not_found' },
  { match: /i\/o timeout|Client\.Timeout|deadline exceeded/i, code: 'timeout' },
  {
    match: /connection reset|broken pipe|no such host|EOF|connection refused|TLS|dial tcp/i,
    code: 'connection_error',
  },
];

/** Phrases that mean the USER stopped it. Never a provider failure. */
const USER_CANCELLED = /context canceled|canceled by user|cancelled by user/i;

/**
 * The info line AGY writes once per COMPLETED model request. This is the
 * denominator, and it is verified against real logs on this machine
 * (1187 + 186 + 130 + ... such lines across the retained corpus).
 */
const COMPLETED_REQUEST = /\bResponseID:/;

/** A `(code NNN)` or `HTTP NNN` in the message, when AGY recorded one. */
const STATUS_IN_MESSAGE = /\bcode (\d{3})\b|\bHTTP (\d{3})\b|\bstatus:? (\d{3})\b/;

export const agyAdapter: SourceAdapter = {
  id: 'agy',

  defaultRoot(home: string): string {
    return join(home, '.gemini', 'antigravity-cli', 'log');
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

    let names: string[];
    try {
      names = readdirSync(ctx.root).filter((n) => FILENAME_STAMP.test(n)).sort();
    } catch (err) {
      return {
        sourceCli: agyAdapter.id,
        events,
        attempts: [],
        sourcesScanned: 0,
        bytesScanned: 0,
        warnings: [`agy: log directory could not be listed (${(err as NodeJS.ErrnoException).code ?? 'error'})`],
      };
    }

    for (const name of names) {
      sourcesScanned++;
      const path = join(ctx.root, name);
      const year = Number(FILENAME_STAMP.exec(name)?.[1] ?? '0');
      const key = pathKey(path);
      const res = tailLines(path, ctx.cursors.getFile(key), ctx.now(), (line) => {
        const parsed = parseGlogLine(line, year);
        if (parsed === undefined) return;
        if (parsed.timestampMs < ctx.minTimestampMs) return;
        const host = HOST_IN_URL.exec(parsed.message)?.[1];
        const provider = host === undefined ? undefined : MODEL_HOSTS[host];
        if (provider === undefined) return; // analytics, experiments, driver downloads
        const model = MODEL_IN_URL.exec(parsed.message)?.[1];
        if (model === undefined) return; // a model call we cannot attribute a model to

        if (parsed.severity === 'I' && COMPLETED_REQUEST.test(parsed.message)) {
          // `URL: <model url> ResponseID: <id>` - one completed request. Matched
          // POSITIVELY: an "everything at I that does not say error" rule would
          // silently under-count the denominator the day AGY adds an info line.
          const key = groupKey(provider, model);
          successes.set(key, (successes.get(key) ?? 0) + 1);
          return;
        }
        if (USER_CANCELLED.test(parsed.message)) return;
        // An `I` line on a model host that is neither a completed request nor a
        // retry notice is not a failure - AGY logs plenty of them.
        if (parsed.severity === 'I' && !/retry/i.test(parsed.message)) return;

        // A model call that failed in a way this table does not recognise is
        // emitted as `unknown`, not dropped: it surfaces in the record's visible
        // `unclassified[]` bucket, which is where a changed upstream message
        // should show up rather than vanishing from the health signal.
        const code = classifyPhrase(parsed.message) ?? UNKNOWN;
        const statusMatch = STATUS_IN_MESSAGE.exec(parsed.message);
        const status = statusMatch
          ? Number(statusMatch[1] ?? statusMatch[2] ?? statusMatch[3])
          : undefined;
        events.push({
          timestampMs: parsed.timestampMs,
          provider,
          model,
          errorCode: code,
          ...(status === undefined ? {} : { httpStatus: status }),
          sourceCli: agyAdapter.id,
        });
      });

      bytesScanned += res.bytesRead;
      if (res.error !== undefined) warnings.push(`agy: a log file could not be read (${res.error})`);
      else if (res.cursor !== undefined) ctx.cursors.setFile(key, res.cursor);
    }

    return {
      sourceCli: agyAdapter.id,
      events,
      attempts: toAttempts(successes),
      sourcesScanned,
      bytesScanned,
      warnings,
    };
  },
};

export interface GlogLine {
  severity: 'I' | 'W' | 'E';
  timestampMs: number;
  message: string;
}

/**
 * Parse one glog line. glog omits the YEAR, so it comes from the filename -
 * without it every log would be dated to the current year and a January scan of
 * a December log would land twelve months in the future.
 */
export function parseGlogLine(line: string, year: number): GlogLine | undefined {
  const m = GLOG.exec(line);
  if (m === undefined || m === null) return undefined;
  const [, sev, mon, day, hh, mm, ss, micros, message] = m;
  if (sev === undefined || message === undefined || year === 0) return undefined;
  // glog timestamps are LOCAL time with no zone, which is what `Date` with
  // separate components gives us. A wrong zone here would only shift an event
  // between adjacent windows, never lose it.
  const ms = new Date(
    year,
    Number(mon) - 1,
    Number(day),
    Number(hh),
    Number(mm),
    Number(ss),
    Math.floor(Number(micros) / 1000),
  ).getTime();
  if (!Number.isFinite(ms)) return undefined;
  return { severity: sev as 'I' | 'W' | 'E', timestampMs: ms, message };
}

/** First matching failure phrase, or undefined when none matches. */
export function classifyPhrase(message: string): string | undefined {
  for (const { match, code } of FAILURE_PHRASES) {
    if (match.test(message)) return code;
  }
  return undefined;
}
