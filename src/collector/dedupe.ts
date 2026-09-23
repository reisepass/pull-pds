/**
 * Burst collapsing, because these events are not independent samples.
 *
 * THE MEASUREMENT THIS FIXES. On the Claude Code corpus used to design this,
 * three clusters dominate 57 error records:
 *
 *   - an auth expiry storm: 16 errors across 5 sessions in 65 minutes;
 *   - a workflow fan-out: 7 errors inside 30 MILLISECONDS, then 5 more inside
 *     24 ms, when one upstream failure knocked over 12 parallel agents. All 12
 *     were counted against the same model, and that single incident is 34% of
 *     that model's entire error total;
 *   - a weekly-limit hit: 4 errors across 4 unrelated projects.
 *
 * A per-model error count built from those raw records is not a count of
 * failures, it is a count of incidents multiplied by how many agents happened to
 * be in flight. Published into a federated aggregate it would let one laptop's
 * parallelism outvote another laptop's actual provider experience.
 *
 * WHAT IS DONE ABOUT IT. Events sharing (source, provider, model, code) inside a
 * window collapse to ONE event. The window is deliberately short by default
 * (60 s): long enough to swallow a fan-out, short enough that a genuine sustained
 * outage still produces one event per minute per model rather than one event
 * total. Set it to 0 to publish raw counts, which is honest but noisier.
 *
 * WHAT IS NOT DONE. Deduping does not use the session id - the obvious key,
 * deliberately not carried (see `types.ts`). The fan-out case is collapsed
 * anyway because those 12 records share a model, a code, and a 30 ms span. The
 * auth storm case is NOT fully collapsed, because it spans 65 minutes; those are
 * account-scoped codes and the classifier drops them from the record before
 * publication anyway.
 */
import { groupKey, type ErrorEvent } from './types.js';

export const DEFAULT_DEDUPE_WINDOW_MS = 60_000;

export interface DedupeResult {
  events: ErrorEvent[];
  /** Events removed. Reported locally so the operator can see how bursty it was. */
  collapsed: number;
}

/**
 * Collapse bursts. Input need not be sorted; output is sorted by timestamp,
 * which is what the aggregator wants for the window bounds.
 *
 * `windowMs <= 0` disables collapsing and only sorts.
 */
export function dedupeBursts(
  events: readonly ErrorEvent[],
  windowMs: number = DEFAULT_DEDUPE_WINDOW_MS,
): DedupeResult {
  const sorted = [...events].sort((a, b) => a.timestampMs - b.timestampMs);
  if (windowMs <= 0) return { events: sorted, collapsed: 0 };

  const lastKept = new Map<string, number>();
  const out: ErrorEvent[] = [];
  let collapsed = 0;
  for (const ev of sorted) {
    const key = groupKey(ev.sourceCli, ev.provider, ev.model, ev.errorCode);
    const prev = lastKept.get(key);
    // Note the window is measured from the last KEPT event, not the last seen
    // one, so a continuous stream of failures cannot slide the window forever
    // and collapse an hour-long outage into a single event.
    if (prev !== undefined && ev.timestampMs - prev < windowMs) {
      collapsed++;
      continue;
    }
    lastKept.set(key, ev.timestampMs);
    out.push(ev);
  }
  return { events: out, collapsed };
}
