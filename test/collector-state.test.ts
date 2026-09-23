/**
 * Cursor state, the run lock, and incremental reading.
 *
 * These are the tests that decide whether a second run is cheap and whether two
 * overlapping runs can double-count. Every one of them works on a temp
 * directory - nothing here touches a real `~/.claude`, `~/.codex` or
 * `~/.gemini`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CollectorState, pathKey, resumeOffset, redactPath } from '../src/collector/state.js';
import { tailLines, parseJsonLine } from '../src/collector/tail.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pt-collector-state-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cursor state', () => {
  it('round-trips cursors and the window end across a save/load', () => {
    const a = CollectorState.load(dir);
    a.setFile('k1', { offset: 100, size: 200, inode: 7, lastSeenMs: 1000 });
    a.setRowId('codex:logs_2.id', 4242);
    a.lastRunEndMs = 555;
    a.save(2000);

    const b = CollectorState.load(dir);
    expect(b.getFile('k1')).toEqual({ offset: 100, size: 200, inode: 7, lastSeenMs: 1000 });
    expect(b.getRowId('codex:logs_2.id')).toBe(4242);
    expect(b.lastRunEndMs).toBe(555);
  });

  it('starts fresh rather than half-reading a corrupt state file', () => {
    writeFileSync(join(dir, 'cursors.json'), '{ this is not json');
    const s = CollectorState.load(dir);
    expect(s.getFile('k1')).toBeUndefined();
    expect(s.lastRunEndMs).toBe(0);
  });

  it('discards a state file from an unrecognised version', () => {
    writeFileSync(
      join(dir, 'cursors.json'),
      JSON.stringify({ version: 99, lastRunEndMs: 12345, files: { k1: {} } }),
    );
    const s = CollectorState.load(dir);
    expect(s.lastRunEndMs).toBe(0);
    expect(s.getFile('k1')).toBeUndefined();
  });

  it('prunes cursors nothing has seen inside the TTL', () => {
    const s = CollectorState.load(dir);
    const now = 1_800_000_000_000;
    s.setFile('fresh', { offset: 1, size: 1, inode: 1, lastSeenMs: now });
    s.setFile('stale', { offset: 1, size: 1, inode: 1, lastSeenMs: now - 60 * 24 * 3600 * 1000 });
    s.save(now);
    const reloaded = CollectorState.load(dir);
    expect(reloaded.getFile('fresh')).toBeDefined();
    expect(reloaded.getFile('stale')).toBeUndefined();
  });

  it('never writes a path into the state file', () => {
    const s = CollectorState.load(dir);
    const secret = '/Users/someone/.claude/projects/-Users-someone-workspace-acme-merger/x.jsonl';
    s.setFile(pathKey(secret), { offset: 1, size: 2, inode: 3, lastSeenMs: 4 });
    s.save(5);
    const raw = readFileSync(join(dir, 'cursors.json'), 'utf8');
    expect(raw).not.toContain('acme-merger');
    expect(raw).not.toContain('/Users/someone');
    expect(raw).toContain(pathKey(secret));
  });

  it('hashes a path stably and distinctly', () => {
    expect(pathKey('/a/b')).toBe(pathKey('/a/b'));
    expect(pathKey('/a/b')).not.toBe(pathKey('/a/c'));
  });

  it('redacts a path down to a depth, never a project name', () => {
    const root = '/home/u/.claude/projects';
    const out = redactPath(`${root}/-Users-u-workspace-acme/session.jsonl`, root);
    expect(out).not.toContain('acme');
    expect(out).not.toContain('session');
    expect(redactPath('/elsewhere/x', root)).toBe('<outside-root>');
  });
});

describe('run lock', () => {
  it('lets exactly one holder in, and the second one back out cleanly', () => {
    const a = CollectorState.load(dir);
    const b = CollectorState.load(dir);
    expect(a.acquireLock(1000)).toBe(true);
    expect(b.acquireLock(1000)).toBe(false);
    a.releaseLock();
    expect(b.acquireLock(1000)).toBe(true);
    b.releaseLock();
  });

  it('breaks a lock old enough to belong to a killed run', () => {
    const a = CollectorState.load(dir);
    expect(a.acquireLock(1000)).toBe(true);
    const later = statSync(join(dir, 'run.lock')).mtimeMs + 2 * 60 * 60 * 1000;
    const b = CollectorState.load(dir);
    expect(b.acquireLock(later)).toBe(true);
    b.releaseLock();
  });

  it('releasing a lock never taken is a no-op', () => {
    const s = CollectorState.load(dir);
    expect(() => s.releaseLock()).not.toThrow();
  });
});

describe('resumeOffset', () => {
  it('starts at zero with no cursor', () => {
    expect(resumeOffset(undefined, { size: 10, ino: 1 })).toEqual({ offset: 0, rescanned: false });
  });

  it('resumes where it stopped', () => {
    const c = { offset: 40, size: 40, inode: 1, lastSeenMs: 0 };
    expect(resumeOffset(c, { size: 90, ino: 1 })).toEqual({ offset: 40, rescanned: false });
  });

  it('rereads from zero when the file was rotated (inode changed)', () => {
    const c = { offset: 40, size: 40, inode: 1, lastSeenMs: 0 };
    expect(resumeOffset(c, { size: 90, ino: 2 })).toEqual({ offset: 0, rescanned: true });
  });

  it('rereads from zero when the file was truncated below the cursor', () => {
    const c = { offset: 40, size: 40, inode: 1, lastSeenMs: 0 };
    expect(resumeOffset(c, { size: 10, ino: 1 })).toEqual({ offset: 0, rescanned: true });
  });
});

describe('incremental line reading', () => {
  it('reads only what was appended since the last run', () => {
    const path = join(dir, 'log.jsonl');
    writeFileSync(path, '{"a":1}\n{"a":2}\n');
    const first: string[] = [];
    const r1 = tailLines(path, undefined, 1, (l) => void first.push(l));
    expect(first).toEqual(['{"a":1}', '{"a":2}']);

    appendFileSync(path, '{"a":3}\n');
    const second: string[] = [];
    const r2 = tailLines(path, r1.cursor, 2, (l) => void second.push(l));
    expect(second).toEqual(['{"a":3}']);
    expect(r2.bytesRead).toBe(8);
  });

  it('leaves a partial trailing line for the next run instead of eating half of it', () => {
    const path = join(dir, 'partial.jsonl');
    writeFileSync(path, '{"a":1}\n{"a":2'); // second record still being written
    const seen: string[] = [];
    const r1 = tailLines(path, undefined, 1, (l) => void seen.push(l));
    expect(seen).toEqual(['{"a":1}']);

    appendFileSync(path, '}\n');
    const seen2: string[] = [];
    tailLines(path, r1.cursor, 2, (l) => void seen2.push(l));
    expect(seen2).toEqual(['{"a":2}']);
  });

  it('rereads a truncated file from the start rather than skipping it', () => {
    const path = join(dir, 'rot.log');
    writeFileSync(path, 'one\ntwo\nthree\n');
    const r1 = tailLines(path, undefined, 1, () => undefined);
    writeFileSync(path, 'fresh\n');
    const seen: string[] = [];
    const r2 = tailLines(path, r1.cursor, 2, (l) => void seen.push(l));
    expect(r2.rescanned).toBe(true);
    expect(seen).toEqual(['fresh']);
  });

  it('keeps byte offsets exact across multi-byte UTF-8', () => {
    const path = join(dir, 'utf8.jsonl');
    writeFileSync(path, '{"t":"über – café"}\n{"t":"next"}\n');
    const seen: string[] = [];
    const r = tailLines(path, undefined, 1, (l) => void seen.push(l));
    expect(seen[0]).toBe('{"t":"über – café"}');
    expect(r.cursor?.offset).toBe(statSync(path).size);
  });

  it('drops a single line too large to hold and keeps going', () => {
    const path = join(dir, 'huge.jsonl');
    writeFileSync(path, `{"pasted":"${'x'.repeat(300 * 1024)}"}\n{"a":1}\n`);
    const seen: string[] = [];
    const r = tailLines(path, undefined, 1, (l) => void seen.push(l));
    expect(r.linesTooLong).toBe(1);
    expect(seen).toEqual(['{"a":1}']);
    expect(r.cursor?.offset).toBe(statSync(path).size);
  });

  it('reports a missing file rather than throwing', () => {
    const r = tailLines(join(dir, 'nope.log'), undefined, 1, () => undefined);
    expect(r.error).toContain('stat failed');
    expect(r.cursor).toBeUndefined();
  });
});

describe('parseJsonLine', () => {
  it('returns undefined for anything that is not a JSON object', () => {
    expect(parseJsonLine('')).toBeUndefined();
    expect(parseJsonLine('not json')).toBeUndefined();
    expect(parseJsonLine('[1,2]')).toBeUndefined();
    expect(parseJsonLine('{"a":')).toBeUndefined();
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
  });
});
