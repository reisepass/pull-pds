/**
 * Codex adapter: `~/.codex/logs_2.sqlite` and `~/.codex/sessions/**\/*.jsonl`.
 *
 * WHERE THE ERRORS ACTUALLY ARE, WHICH IS NOT WHERE THE RESEARCH SAID. The
 * session rollout JSONL - the obvious source - has no error event type at all.
 * Across 97 rollout files and 6908 `event_msg` records on this machine the only
 * failure-shaped payload is `turn_aborted`, and all 30 of those carry
 * `reason: "interrupted"`, which is the user pressing escape. `token_count`
 * carries a `rate_limits` object but `rate_limit_reached_type` was absent on all
 * 2275 of them. The rollout files are therefore NOT an error source, and this
 * adapter reads them only for the provider name.
 *
 * The errors are in the structured log DB, in tracing spans:
 *
 *   WARN codex_core::responses_retry
 *   session_loop{...}:turn{... model=gpt-5.5 ...}:sampling_request{turn_id=...
 *   model=gpt-5.5 cwd=...}: stream disconnected - retrying sampling request (1/5 in 189ms)
 *
 * That row carries the model DIRECTLY in the span fields - no inference needed -
 * and it is a RETRY notice, so unlike Claude Code's transcripts this source sees
 * failures that were retried successfully. That is the more truthful number.
 *
 * THE LIMIT THAT MATTERS MOST. `logs_2.sqlite` is a small ring: 2000 rows
 * spanning about SIXTEEN MINUTES of active use on this laptop. A collector on a
 * 30-minute timer will miss most of what passes through it. Nothing in this
 * adapter can fix that - it is a property of how Codex prunes - and it is stated
 * in the README rather than papered over. The cursor is still kept on the
 * autoincrement `id` so that whatever survives between two runs is read exactly
 * once.
 *
 * PROVIDER ATTRIBUTION IS PARTIAL AND SAYS SO. The log rows carry `model=` but
 * never a provider. `session_meta.model_provider` in the rollout files says
 * `openai` for all 97 sessions here, but a rollout file cannot be joined to a
 * log row without the thread id, and thread ids are exactly the kind of
 * identifier this collector refuses to carry. So the provider is derived from
 * the model id against a conservative table of OpenAI model families; a model
 * this adapter does not recognise is emitted as `unknown` rather than assumed to
 * be OpenAI. On a Codex pointed at a non-OpenAI backend that is the correct
 * answer, and a missing attribution is cheaper than a wrong one.
 *
 * PRIVACY. The span text also contains `cwd=/Users/<user>/workspace/<project>`
 * and `thread_id`/`turn_id`. Only `model=` and the failure phrase are extracted;
 * the row is never retained and never logged.
 */
import { statSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { log } from '../../log.js';
import { toAttempts } from './claude-code.js';
import { UNKNOWN, groupKey, type CollectContext, type ErrorEvent, type SourceAdapter, type SourceObservation } from '../types.js';

/** The structured log DB. The `_2` is Codex's own schema generation. */
const LOG_DB = 'logs_2.sqlite';

/** Rows to read in one run. A ceiling, not a target: the ring holds ~2000. */
const MAX_ROWS = 20_000;

/** Cursor key for the log DB's autoincrement id. */
const ROWID_KEY = 'codex:logs_2.id';

/** `model=gpt-5.5` inside a tracing span. The only field taken from the span. */
const MODEL_IN_SPAN = /\bmodel=([A-Za-z0-9._\-]+)/;

/** `status=503`, as `codex_http_client::default_client` writes it. */
const STATUS_IN_BODY = /\bstatus=(\d{3})\b/;

/** `url=https://host/path`, same source. */
const URL_IN_BODY = /\burl=(https?:\/\/[^\s]+)/;

/**
 * URL paths that are an inference call. Codex talks to its own analytics
 * endpoint (`/backend-api/codex/analytics-events/events`) far more often than
 * to a model, and every one of those rows carries a `status=` that would
 * otherwise be counted as provider telemetry. Same class of trap as AGY's
 * `play.googleapis.com`.
 *
 * NOT VERIFIED ON THIS MACHINE: the retained 16-minute window held only
 * analytics rows, so the inference-path branch is written from the known API
 * shapes and has not been seen firing against real data. Said plainly here
 * because an unverified parser that silently produces nothing looks identical to
 * one that works.
 */
const INFERENCE_PATHS = [
  '/responses',
  '/chat/completions',
  '/completions',
  '/v1/messages',
];

/**
 * OpenAI model families, for the only attribution step this adapter makes.
 * Deliberately narrow: `gpt-*`, `o<digit>*`, `codex-*`, `text-*`. Anything else
 * is `unknown`.
 */
function providerFor(model: string): string {
  const m = model.toLowerCase();
  if (/^(gpt-|o\d|codex-|text-|davinci|chatgpt-)/.test(m)) return 'openai';
  return UNKNOWN;
}

/**
 * Failure phrases in Codex's retry/error log bodies -> classifier codes.
 * `stream disconnected` is the one verified against a real row on this machine.
 */
const FAILURE_PHRASES: readonly { readonly match: RegExp; readonly code: string }[] = [
  { match: /rate.?limit|429/i, code: '429' },
  { match: /stream disconnected|connection reset|broken pipe|EOF|connection closed|dial tcp/i, code: 'connection_error' },
  { match: /timed? ?out|timeout|deadline/i, code: 'timeout' },
  { match: /overload/i, code: 'overloaded_error' },
  { match: /unauthorized|401|invalid.?api.?key|authentication/i, code: 'invalid_api_key' },
  { match: /quota|insufficient/i, code: 'insufficient_quota' },
  { match: /server error|internal error|5\d\d/i, code: 'server_error' },
];

/** Phrases that mean the USER stopped it. Never a provider failure. */
const USER_CANCELLED = /interrupted|canceled by user|cancelled by user|user_interrupt/i;

/** One row of the log DB, reduced to what may be read from it. */
interface LogRow {
  id: number;
  tsMs: number;
  level: string;
  target: string;
  body: string;
}

/** Injectable so tests never open a real `~/.codex` and never need a driver. */
export type LogDbReader = (dbPath: string, afterId: number, limit: number) => LogRow[];

export const codexAdapter: SourceAdapter = {
  id: 'codex',

  defaultRoot(home: string): string {
    return join(home, '.codex');
  },

  detect(root: string): boolean {
    try {
      return statSync(root).isDirectory() && existsSync(join(root, LOG_DB));
    } catch {
      return false;
    }
  },

  async collect(ctx: CollectContext): Promise<SourceObservation> {
    return collectCodex(ctx, readLogDb);
  },
};

/** The adapter body, with the DB reader injected. Exported for tests. */
export async function collectCodex(
  ctx: CollectContext,
  readDb: LogDbReader,
): Promise<SourceObservation> {
  const events: ErrorEvent[] = [];
  const successes = new Map<string, number>();
  const warnings: string[] = [];
  const dbPath = join(ctx.root, LOG_DB);

  if (!existsSync(dbPath)) {
    return {
      sourceCli: codexAdapter.id,
      events,
      attempts: [],
      sourcesScanned: 0,
      bytesScanned: 0,
      warnings: [`codex: ${LOG_DB} is not present under the configured root`],
    };
  }

  const afterId = ctx.cursors.getRowId(ROWID_KEY);
  let rows: LogRow[];
  try {
    rows = readDb(dbPath, afterId, MAX_ROWS);
  } catch (err) {
    return {
      sourceCli: codexAdapter.id,
      events,
      attempts: [],
      sourcesScanned: 1,
      bytesScanned: 0,
      warnings: [`codex: ${LOG_DB} could not be read (${(err as Error).message})`],
    };
  }

  let maxId = afterId;
  let bytesScanned = 0;
  for (const row of rows) {
    if (row.id > maxId) maxId = row.id;
    bytesScanned += row.body.length;
    if (row.tsMs < ctx.minTimestampMs) continue;
    const model = MODEL_IN_SPAN.exec(row.body)?.[1] ?? UNKNOWN;
    const provider = model === UNKNOWN ? UNKNOWN : providerFor(model);

    // A completed HTTP request: the denominator, and the only place Codex
    // records a real status code.
    const url = URL_IN_BODY.exec(row.body)?.[1];
    if (url !== undefined) {
      if (!isInferenceUrl(url)) continue; // analytics, auth, experiments
      const status = Number(STATUS_IN_BODY.exec(row.body)?.[1] ?? '0');
      if (status >= 200 && status < 400) {
        const key = groupKey(provider, model);
        successes.set(key, (successes.get(key) ?? 0) + 1);
      } else if (status >= 400) {
        events.push({
          timestampMs: row.tsMs,
          provider,
          model,
          errorCode: String(status),
          httpStatus: status,
          sourceCli: codexAdapter.id,
        });
      }
      continue;
    }

    // Everything else is only interesting when Codex itself called it a problem.
    if (row.level !== 'WARN' && row.level !== 'ERROR') continue;
    if (USER_CANCELLED.test(row.body)) continue;
    const code = classifyBody(row.body) ?? UNKNOWN;
    events.push({
      timestampMs: row.tsMs,
      provider,
      model,
      errorCode: code,
      sourceCli: codexAdapter.id,
    });
  }

  ctx.cursors.setRowId(ROWID_KEY, maxId);
  if (rows.length >= MAX_ROWS) {
    warnings.push(
      `codex: hit the ${MAX_ROWS}-row read cap in one run; the log ring may have wrapped past unread rows`,
    );
  }
  // Rollout files are read for nothing but a sanity count - see the header.
  const rollouts = countRollouts(ctx.root);
  log.debug('collector read codex structured logs', {
    rows: rows.length,
    fromId: afterId,
    toId: maxId,
    rolloutFiles: rollouts,
  });

  return {
    sourceCli: codexAdapter.id,
    events,
    attempts: toAttempts(successes),
    sourcesScanned: 1,
    bytesScanned,
    warnings,
  };
}

function isInferenceUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  return INFERENCE_PATHS.some((p) => path.endsWith(p));
}

export function classifyBody(body: string): string | undefined {
  for (const { match, code } of FAILURE_PHRASES) {
    if (match.test(body)) return code;
  }
  return undefined;
}

/**
 * Read new rows from Codex's log DB. `node:sqlite` is a core module on Node 22+
 * (unflagged from Node 23), so this adds no dependency - but on a Node 22 built
 * without it the import throws, and a missing structured log is a degraded
 * collector rather than a failed run.
 *
 * OPENED READ-ONLY. This process must never write to another tool's database.
 */
const readLogDb: LogDbReader = (dbPath, afterId, limit) => {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare(
      'SELECT id, ts, level, target, COALESCE(feedback_log_body, \'\') AS body FROM logs WHERE id > ? ORDER BY id ASC LIMIT ?',
    );
    return stmt.all(afterId, limit).map((r) => {
      const row = r as { id: number; ts: number; level: string; target: string; body: string };
      return {
        id: Number(row.id),
        // `ts` is unix SECONDS in Codex's schema.
        tsMs: Number(row.ts) * 1000,
        level: String(row.level),
        target: String(row.target),
        body: String(row.body),
      };
    });
  } finally {
    db.close();
  }
};

interface SqliteModule {
  DatabaseSync: new (path: string, opts?: { readOnly?: boolean }) => {
    prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
    close: () => void;
  };
}

function loadSqlite(): SqliteModule {
  // `createRequire` rather than a static import so a Node build without
  // `node:sqlite` degrades this ONE adapter instead of failing the whole CLI at
  // module load, before it has even read its config.
  const req = createRequire(import.meta.url);
  return req('node:sqlite') as SqliteModule;
}

/** Rollout file count, for the log line only. Their contents are not read. */
function countRollouts(root: string): number {
  const dir = join(root, 'sessions');
  let n = 0;
  const walk = (d: string, depth: number): void => {
    if (depth > 5) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) walk(join(d, ent.name), depth + 1);
      else if (ent.name.startsWith('rollout-') && ent.name.endsWith('.jsonl')) n++;
    }
  };
  if (existsSync(dir)) walk(dir, 0);
  return n;
}
