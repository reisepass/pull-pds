/**
 * The AGY adapter, against synthetic glog files.
 *
 * The line shapes here are copied from real `~/.gemini/antigravity-cli/log`
 * output (with the IPs and ids replaced), because the two things this adapter
 * has to get right are both about which lines it IGNORES: AGY's own analytics
 * upload failing 2829 times, and the user pressing escape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agyAdapter, parseGlogLine, classifyPhrase } from '../src/collector/adapters/agy.js';
import { CollectorState } from '../src/collector/state.js';
import type { CollectContext } from '../src/collector/types.js';

let dir: string;
let stateDir: string;
const NOW = new Date(2026, 7, 3, 20, 0, 0).getTime();

const VERTEX = (model: string): string =>
  `https://aiplatform.googleapis.com/v1/projects/shared-ai-keys/locations/global/publishers/google/models/${model}:streamGenerateContent?alt=sse`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pt-agy-'));
  stateDir = mkdtempSync(join(tmpdir(), 'pt-agy-state-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(stateDir, { recursive: true, force: true });
});

function glog(sev: 'I' | 'W' | 'E', hhmmss: string, message: string): string {
  return `ERROR: logging before google.Init: ${sev}0803 ${hhmmss}.354991      37 client.go:68] ${message}\n`;
}

function write(body: string, name = 'cli-20260803_181823.log'): string {
  const path = join(dir, name);
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

describe('agy adapter', () => {
  it('reads provider from the host and model from the URL path, no inference', async () => {
    write(glog('E', '17:34:05', `request failed: Post "${VERTEX('gemini-3.6-flash')}": read tcp 10.0.0.1:1->10.0.0.2:443: read: connection reset by peer`));
    const obs = await agyAdapter.collect(ctx());
    expect(obs.events).toHaveLength(1);
    expect(obs.events[0]).toMatchObject({
      provider: 'gcp.vertex_ai',
      model: 'gemini-3.6-flash',
      errorCode: 'connection_error',
      sourceCli: 'agy',
    });
  });

  it("ignores AGY's own analytics upload failing, which is the bulk of its E lines", async () => {
    let body = '';
    for (let i = 0; i < 50; i++) {
      body += glog('E', '17:34:05', 'Post "https://play.googleapis.com/log": dial tcp: lookup play.googleapis.com: no such host');
    }
    body += glog('E', '17:35:00', 'Failed to poll ListExperiments: Post "https://cloudcode-pa.googleapis.com/v1internal:listExperiments": read tcp: connection reset');
    write(body);
    const obs = await agyAdapter.collect(ctx());
    expect(obs.events).toEqual([]);
  });

  it('ignores a request the user cancelled', async () => {
    write(glog('E', '17:34:05', `error encountered while processing planner output: request failed: Post "${VERTEX('gemini-3.6-flash')}": context canceled by user`));
    const obs = await agyAdapter.collect(ctx());
    expect(obs.events).toEqual([]);
  });

  it('counts a completed request as the denominator', async () => {
    write(
      glog('I', '17:30:00', `URL: ${VERTEX('gemini-3.6-flash')} ResponseID: _05waujrBIyiw`) +
        glog('I', '17:30:05', `URL: ${VERTEX('gemini-3.6-flash')} ResponseID: _0JuaoufI-HIw`) +
        glog('E', '17:31:00', `RESOURCE_EXHAUSTED (code 429): Resource exhausted. Please try again later. ${VERTEX('gemini-3.6-flash')}`),
    );
    const obs = await agyAdapter.collect(ctx());
    expect(obs.attempts).toEqual([
      { provider: 'gcp.vertex_ai', model: 'gemini-3.6-flash', successes: 2 },
    ]);
    expect(obs.events[0]).toMatchObject({ errorCode: 'resource_exhausted', httpStatus: 429 });
  });

  it('counts a retried failure, which is the number transcripts cannot give', async () => {
    write(glog('I', '17:34:05', `Encountered retryable api error. retrying in 1s. Error (): request failed: Post "${VERTEX('gemini-3.1-pro-preview')}": UNAVAILABLE`));
    const obs = await agyAdapter.collect(ctx());
    expect(obs.events).toHaveLength(1);
    expect(obs.events[0]).toMatchObject({ errorCode: 'unavailable', model: 'gemini-3.1-pro-preview' });
    expect(obs.attempts).toEqual([]);
  });

  it('emits unknown for a model-host failure it cannot phrase-match, never silence', async () => {
    write(glog('E', '17:34:05', `request failed: Post "${VERTEX('gemini-3.6-flash')}": something nobody has written a rule for`));
    const obs = await agyAdapter.collect(ctx());
    expect(obs.events[0]?.errorCode).toBe('unknown');
  });

  it('takes the year from the filename, since glog does not record one', async () => {
    write(glog('E', '17:34:05', `Post "${VERTEX('gemini-3.6-flash')}": UNAVAILABLE`), 'cli-20251231_181823.log');
    const obs = await agyAdapter.collect(ctx());
    expect(new Date(obs.events[0]?.timestampMs ?? 0).getFullYear()).toBe(2025);
  });

  it('ignores files that are not AGY logs', async () => {
    writeFileSync(join(dir, 'notes.txt'), glog('E', '17:34:05', `Post "${VERTEX('x')}": UNAVAILABLE`));
    const obs = await agyAdapter.collect(ctx());
    expect(obs.sourcesScanned).toBe(0);
    expect(obs.events).toEqual([]);
  });

  it('does not re-report a line on a second run', async () => {
    const path = write(glog('E', '17:34:05', `Post "${VERTEX('gemini-3.6-flash')}": UNAVAILABLE`));
    const state = CollectorState.load(stateDir);
    expect((await agyAdapter.collect(ctx({ cursors: state }))).events).toHaveLength(1);
    expect((await agyAdapter.collect(ctx({ cursors: state }))).events).toHaveLength(0);
    appendFileSync(path, glog('E', '17:36:05', `Post "${VERTEX('gemini-3.6-flash')}": INTERNAL`));
    const third = await agyAdapter.collect(ctx({ cursors: state }));
    expect(third.events.map((e) => e.errorCode)).toEqual(['internal']);
  });

  it('never carries the local or remote IP off the line', async () => {
    write(glog('E', '17:34:05', `request failed: Post "${VERTEX('gemini-3.6-flash')}": read tcp 192.168.178.21:59316->142.250.181.234:443: read: connection reset by peer`));
    const obs = await agyAdapter.collect(ctx());
    const dumped = JSON.stringify(obs);
    expect(dumped).not.toContain('192.168.178.21');
    expect(dumped).not.toContain('142.250.181.234');
    expect(dumped).not.toContain('shared-ai-keys');
  });
});

describe('glog parsing', () => {
  it('reads severity, timestamp and message, discarding pid and source location', () => {
    const p = parseGlogLine(
      'ERROR: logging before google.Init: E0730 17:34:05.354991      37 client.go:68] boom',
      2026,
    );
    expect(p?.severity).toBe('E');
    expect(p?.message).toBe('boom');
    expect(new Date(p?.timestampMs ?? 0).getMonth()).toBe(6); // July
  });

  it('rejects a line with no glog prefix and a file with no year', () => {
    expect(parseGlogLine('just some text', 2026)).toBeUndefined();
    expect(parseGlogLine('E0730 17:34:05.354991 37 x.go:1] boom', 0)).toBeUndefined();
  });
});

describe('failure phrase table', () => {
  it('prefers the specific gRPC status over the generic transport phrase', () => {
    expect(classifyPhrase('RESOURCE_EXHAUSTED (code 429): dial tcp failed')).toBe('resource_exhausted');
    expect(classifyPhrase('DEADLINE_EXCEEDED')).toBe('deadline_exceeded');
    expect(classifyPhrase('broken pipe')).toBe('connection_error');
    expect(classifyPhrase('nothing recognisable')).toBeUndefined();
  });
});
