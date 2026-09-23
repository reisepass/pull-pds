import { appendFileSync } from 'node:fs';

/**
 * Opt-in JSONL tracing for the PHASE-4 latency experiment. When `TRACE_FILE` is
 * set, each hop (hub receipt, aggregator ingest stages, AppView index) appends
 * one line so the soak harness can reconstruct the per-hop, per-ping timeline
 * without any in-band side channel - the correlation key (did, seq) travels
 * inside the signed record itself.
 *
 * All processes run on one VM, so every timestamp shares one clock (no skew) -
 * which is exactly why the resulting numbers are a *lower bound* on real-world
 * latency, stated plainly in the writeup.
 *
 * Tracing is a no-op unless TRACE_FILE is set, so production is unaffected.
 */
const TRACE_FILE = process.env.TRACE_FILE?.trim();

export function traceEnabled(): boolean {
  return !!TRACE_FILE;
}

export function trace(record: Record<string, unknown>): void {
  if (!TRACE_FILE) return;
  try {
    appendFileSync(TRACE_FILE, JSON.stringify({ ...record, ts: Date.now() }) + '\n');
  } catch {
    /* tracing must never break the request path */
  }
}

/** Millisecond wall clock, the single time source for every hop mark. */
export function nowMs(): number {
  return Date.now();
}
