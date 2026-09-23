/**
 * The Claude Code adapter, against synthetic transcripts.
 *
 * The fixtures deliberately carry realistic-looking conversation text, project
 * paths, session ids and request ids, so the privacy assertions are testing
 * something: an adapter that scooped up the wrong field would be caught here
 * rather than in production against somebody's real logs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeAdapter } from '../src/collector/adapters/claude-code.js';
import { CollectorState } from '../src/collector/state.js';
import type { CollectContext } from '../src/collector/types.js';

let dir: string;
let stateDir: string;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pt-cc-'));
  stateDir = mkdtempSync(join(tmpdir(), 'pt-cc-state-'));
  mkdirSync(join(dir, '-Users-someone-workspace-acme-merger'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

/** A normal assistant turn, with content nothing may ever read. */
function turn(model: string, tsMs: number, text: string): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid: 'bf811591-4a86-462b-8606-3292a348a0cc',
    sessionId: '2d94c3ba-c440-420a-952f-8c2aa6ff9ddc',
    requestId: 'req_0123456789abcdef',
    cwd: '/Users/someone/workspace/acme-merger',
    timestamp: new Date(tsMs).toISOString(),
    message: { model, role: 'assistant', content: [{ type: 'text', text }] },
  })}\n`;
}

/** An API error record, exactly as Claude Code writes one. */
function errorRecord(
  tsMs: number,
  errorClass: string,
  status: number | undefined,
  text: string,
): string {
  return `${JSON.stringify({
    type: 'assistant',
    uuid: '772cf9b9-5082-4a24-9649-2603233a3e69',
    sessionId: '2d94c3ba-c440-420a-952f-8c2aa6ff9ddc',
    cwd: '/Users/someone/workspace/acme-merger',
    timestamp: new Date(tsMs).toISOString(),
    error: errorClass,
    isApiErrorMessage: true,
    ...(status === undefined ? {} : { apiErrorStatus: status }),
    message: { model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text }] },
  })}\n`;
}

function write(name: string, body: string): string {
  const path = join(dir, '-Users-someone-workspace-acme-merger', name);
  writeFileSync(path, body);
  return path;
}

function ctx(overrides: Partial<CollectContext> = {}): CollectContext {
  return {
    root: dir,
    cursors: CollectorState.load(stateDir),
    now: () => NOW,
    minTimestampMs: 0,
    ...overrides,
  };
}

describe('claude-code adapter', () => {
  it('detects only a directory that exists', () => {
    expect(claudeCodeAdapter.detect(dir)).toBe(true);
    expect(claudeCodeAdapter.detect(join(dir, 'nope'))).toBe(false);
    expect(claudeCodeAdapter.defaultRoot('/home/u')).toBe('/home/u/.claude/projects');
  });

  it('attributes an error to the preceding real turn and counts the successes', async () => {
    write(
      'a.jsonl',
      turn('claude-opus-5', NOW - 5000, 'the merger closes on the 14th') +
        turn('claude-opus-5', NOW - 4000, 'here is the draft') +
        errorRecord(NOW - 3000, 'rate_limit', 429, "You've hit your session limit"),
    );
    const obs = await claudeCodeAdapter.collect(ctx());
    expect(obs.events).toHaveLength(1);
    expect(obs.events[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5',
      errorCode: 'rate_limit_error',
      httpStatus: 429,
      sourceCli: 'claude-code',
    });
    expect(obs.attempts).toEqual([
      { provider: 'anthropic', model: 'claude-opus-5', successes: 2 },
    ]);
  });

  it('attributes a leading error to the NEXT real turn instead of dropping it', async () => {
    write(
      'b.jsonl',
      errorRecord(NOW - 5000, 'server_error', undefined, 'Connection closed mid-response') +
        turn('claude-fable-5', NOW - 4000, 'retrying'),
    );
    const obs = await claudeCodeAdapter.collect(ctx());
    expect(obs.events).toHaveLength(1);
    expect(obs.events[0]).toMatchObject({ provider: 'anthropic', model: 'claude-fable-5' });
  });

  it('emits unknown rather than guessing when a session has no real turn at all', async () => {
    write('c.jsonl', errorRecord(NOW - 5000, 'server_error', undefined, 'Connection closed'));
    const obs = await claudeCodeAdapter.collect(ctx());
    expect(obs.events[0]).toMatchObject({ provider: 'unknown', model: 'unknown' });
  });

  it('does not carry attribution across two transcript files', async () => {
    write('d1.jsonl', turn('claude-opus-5', NOW - 9000, 'ok'));
    write('d2.jsonl', errorRecord(NOW - 5000, 'server_error', undefined, 'Connection closed'));
    const obs = await claudeCodeAdapter.collect(ctx());
    expect(obs.events).toHaveLength(1);
    expect(obs.events[0]?.model).toBe('unknown');
  });

  it('calls a gateway-routed model unknown, not anthropic', async () => {
    // Verified on a real corpus: Claude Code transcripts on this machine carry
    // `moonshotai/Kimi-K2.6` and `glm-5.2` turns. Calling those anthropic would
    // put another vendor's failures on Anthropic's record.
    write(
      'e.jsonl',
      turn('moonshotai/Kimi-K2.6', NOW - 5000, 'hello') +
        errorRecord(NOW - 4000, 'server_error', 503, 'upstream failed'),
    );
    const obs = await claudeCodeAdapter.collect(ctx());
    expect(obs.events[0]).toMatchObject({ provider: 'unknown', model: 'moonshotai/Kimi-K2.6' });
    expect(obs.attempts[0]?.provider).toBe('unknown');
  });

  it('maps every observed error class onto a code the classifier knows', async () => {
    const cases: [string, number | undefined, string][] = [
      ['rate_limit', 429, 'rate_limit_error'],
      ['server_error', 529, 'overloaded_error'],
      ['server_error', 500, 'api_error'],
      ['server_error', undefined, 'connection_error'],
      ['authentication_failed', 403, 'authentication_error'],
      ['authentication_failed', undefined, 'authentication_error'],
      ['invalid_request', undefined, 'invalid_request_error'],
      ['unknown', 400, 'invalid_request_error'],
      ['unknown', undefined, 'unknown'],
    ];
    let body = turn('claude-opus-4-8', NOW - 100_000, 'x');
    for (const [cls, status] of cases) {
      body += errorRecord(NOW - 90_000, cls, status, 'whatever');
    }
    write('f.jsonl', body);
    const obs = await claudeCodeAdapter.collect(ctx());
    expect(obs.events.map((e) => e.errorCode)).toEqual(cases.map(([, , code]) => code));
  });

  it('ignores events older than the window', async () => {
    write(
      'g.jsonl',
      turn('claude-opus-5', NOW - 100_000, 'old') +
        errorRecord(NOW - 90_000, 'rate_limit', 429, 'old error') +
        errorRecord(NOW - 1000, 'rate_limit', 429, 'new error'),
    );
    const obs = await claudeCodeAdapter.collect(ctx({ minTimestampMs: NOW - 10_000 }));
    expect(obs.events).toHaveLength(1);
    expect(obs.attempts).toEqual([]); // the successful turn was outside the window too
  });

  it('does not re-report an error on a second run, and picks up new lines', async () => {
    const path = write(
      'h.jsonl',
      turn('claude-opus-5', NOW - 5000, 'ok') +
        errorRecord(NOW - 4000, 'rate_limit', 429, 'limit'),
    );
    const state = CollectorState.load(stateDir);
    const first = await claudeCodeAdapter.collect(ctx({ cursors: state }));
    expect(first.events).toHaveLength(1);

    const second = await claudeCodeAdapter.collect(ctx({ cursors: state }));
    expect(second.events).toHaveLength(0);
    expect(second.bytesScanned).toBe(0);

    appendFileSync(path, errorRecord(NOW - 3000, 'server_error', undefined, 'closed'));
    const third = await claudeCodeAdapter.collect(ctx({ cursors: state }));
    expect(third.events).toHaveLength(1);
    expect(third.events[0]?.errorCode).toBe('connection_error');
  });

  it('finds transcripts nested under subagents and workflows', async () => {
    const deep = join(dir, '-Users-someone-workspace-acme-merger', 'subagents', 'workflows', 'wf_1');
    mkdirSync(deep, { recursive: true });
    writeFileSync(
      join(deep, 'agent-1.jsonl'),
      turn('claude-opus-5', NOW - 5000, 'x') + errorRecord(NOW - 4000, 'rate_limit', 429, 'y'),
    );
    const obs = await claudeCodeAdapter.collect(ctx());
    expect(obs.events).toHaveLength(1);
  });

  it('carries no conversation text, path, session id or request id off the parse', async () => {
    write(
      'i.jsonl',
      turn('claude-opus-5', NOW - 5000, 'CANARY-PROMPT-TEXT about the acme merger') +
        errorRecord(NOW - 4000, 'rate_limit', 429, 'CANARY-ERROR-TEXT session limit'),
    );
    const obs = await claudeCodeAdapter.collect(ctx());
    const dumped = JSON.stringify(obs);
    for (const forbidden of [
      'CANARY-PROMPT-TEXT',
      'CANARY-ERROR-TEXT',
      'acme-merger',
      '2d94c3ba-c440-420a-952f-8c2aa6ff9ddc',
      'req_0123456789abcdef',
      'bf811591-4a86-462b-8606-3292a348a0cc',
      '/Users/someone',
    ]) {
      expect(dumped).not.toContain(forbidden);
    }
  });

  it('survives a malformed line without losing the rest of the file', async () => {
    write(
      'j.jsonl',
      turn('claude-opus-5', NOW - 5000, 'ok') +
        '{"type":"assistant", TRUNCATED\n' +
        errorRecord(NOW - 4000, 'rate_limit', 429, 'limit'),
    );
    const obs = await claudeCodeAdapter.collect(ctx());
    expect(obs.events).toHaveLength(1);
  });
});
