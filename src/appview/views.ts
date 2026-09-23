import { IndexStore } from './index-store.js';
import {
  providerRows,
  aggregateByProvider,
  disagreements,
  health,
  globalAggregate,
  globalLatency,
  globalProviderRows,
  usageRows,
  rankUsage,
  type ProviderRow,
  type UsageRow,
  type GlobalDeps,
  type ErrorCodeCount,
} from './server.js';
import type { GlobalStore } from '../globalindex/store.js';
import { ERROR_METRICS_NSID, USAGE_METRICS_NSID } from '../collections.js';
import { bucketBounds } from '../genai/volume.js';
import { resolveDidWeb, defaultResolverDeps } from '../identity/didweb.js';
import { readCarWithRoot, cborToLex, verifyCommitSig, def } from '@atproto/repo';
import type { Commit } from '@atproto/repo';
import { DEFAULT_RESOLVER_CONFIG } from '../config.js';

/**
 * Server-rendered AppView HTML (PHASE-3 B3). Bookmarkable GET routes, inline CSS,
 * no build step. HARD RULE: DIDs, CIDs, revs, signatures, at:// URIs are never
 * truncated - `.id` renders the full value, monospace, break-all, copyable.
 * Every provider row shows its source PDS, publishing DID, and sig-verified state.
 */

export interface ViewResult {
  status: number;
  body: string;
}

const CSS = `
:root{--bg:#0f1115;--panel:#171a21;--panel2:#1e222b;--fg:#e6e8ec;--muted:#9aa3b2;--line:#2a2f3a;--accent:#6ea8fe;--ok:#3fb950;--bad:#f85149;--warn:#d29922}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--panel);border-bottom:1px solid var(--line);padding:12px 20px;position:sticky;top:0;z-index:10}
header .brand{font-weight:700;font-size:16px;margin-right:18px}
nav a{margin-right:14px;color:var(--muted);font-size:14px}
nav a:hover{color:var(--fg)}
main{max-width:1180px;margin:0 auto;padding:22px 20px 60px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 10px}
.sub{color:var(--muted);font-size:13px;margin-bottom:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:hover td{background:var(--panel2)}
.id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;word-break:break-all;white-space:normal;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:2px 5px;display:inline-block;max-width:100%}
.copy{cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--muted);border-radius:5px;font-size:11px;padding:1px 6px;margin-left:6px;user-select:none}
.copy:hover{color:var(--fg);border-color:var(--accent)}
.badge{display:inline-block;border-radius:20px;padding:1px 9px;font-size:12px;font-weight:600}
.ok{background:rgba(63,185,80,.15);color:var(--ok)}
.bad{background:rgba(248,81,73,.15);color:var(--bad)}
.warn{background:rgba(210,153,34,.15);color:var(--warn)}
.muted-badge{background:var(--panel2);color:var(--muted)}
.stat{display:inline-block;min-width:150px;margin:0 24px 14px 0}
.stat .n{font-size:24px;font-weight:700}
.stat .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
pre{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:14px;overflow:auto;font-family:ui-monospace,monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-all}
.bar{height:8px;background:var(--accent);border-radius:4px;display:inline-block;vertical-align:middle}
.step{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px}
.step.pass{border-left:3px solid var(--ok)}.step.fail{border-left:3px solid var(--bad)}
.pill{font-family:ui-monospace,monospace;font-size:12px;background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
form.inline{display:inline}
input,select{background:var(--panel2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:13px}
button.go{background:var(--accent);color:#06122b;border:none;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer}
.status-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px}
.status-card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px;display:block;transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease;text-decoration:none}
.status-card:hover{transform:translateY(-2px);text-decoration:none;border-color:var(--accent)}
.ok-glow{box-shadow:0 0 15px rgba(63,185,80,.05)}
.bad-glow{border-color:var(--bad);box-shadow:0 0 18px rgba(248,81,73,.12)}
.hero-card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:28px 24px;margin-bottom:24px}
.hero-ok{border-left:5px solid var(--ok);background:linear-gradient(135deg,rgba(63,185,80,.06) 0%,var(--panel) 100%)}
.hero-bad{border-left:5px solid var(--bad);background:linear-gradient(135deg,rgba(248,81,73,.08) 0%,var(--panel) 100%)}
.concept-btn{font-size:12px;padding:4px 12px;border-radius:20px;background:var(--panel2);border:1px solid var(--line);color:var(--muted);text-decoration:none;transition:all .15s ease}
.concept-btn:hover,.concept-btn.active{background:var(--accent);color:#06122b;border-color:var(--accent);font-weight:600;text-decoration:none}
`;

function esc(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function id(v: string): string {
  const e = esc(v);
  return `<span class="id">${e}</span><button class="copy" data-copy="${e}">copy</button>`;
}
/** Render a specific provider error-code breakdown, e.g. 429×150 529×29. */
function errCodes(errors: ErrorCodeCount[], total: number): string {
  if (errors.length === 0) return `<span class="badge muted-badge">0 errors</span>`;
  const parts = errors
    .map((e) => {
      const k = e.code === '429' ? 'warn' : /^5/.test(e.code) ? 'bad' : 'muted-badge';
      return `<span class="badge ${k}" title="provider error code — look it up in that provider's docs">${esc(e.code)}×${e.count}</span>`;
    })
    .join(' ');
  return `${parts} <small>= ${total}</small>`;
}
function sigBadge(ok: boolean): string {
  return ok ? `<span class="badge ok">verified</span>` : `<span class="badge bad">UNVERIFIED</span>`;
}

function page(title: string, body: string): string {
  const nav = [
    ['/', 'Demo Overview'],
    ['/firehose-global', 'GLOBAL firehose'],
    ['/providers', 'All Providers'],
    ['/disagreements', 'Disagreements'],
    ['/usage', 'Usage Stats'],
    ['/records', 'Raw Feed'],
    ['/health', 'Health'],
  ]
    .map(([h, l]) => `<a href="${h}">${l}</a>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Peer Telemetry</title><style>${CSS}</style></head><body>
<header><span class="brand">peertelemetry.org</span><nav>${nav}</nav></header>
<main><div class="card"><strong>Pull-PDS technology demo</strong> — Peer Telemetry illustrates publishing and verifying records on AT Protocol. Records may be synthetic; this is not an authoritative provider status service. A verified signature establishes attribution, not accuracy.</div>${body}</main>
<script>document.addEventListener('click',function(e){var b=e.target.closest('.copy');if(!b)return;var t=b.getAttribute('data-copy');navigator.clipboard&&navigator.clipboard.writeText(t);var o=b.textContent;b.textContent='copied';setTimeout(function(){b.textContent=o;},900);});</script>
</body></html>`;
}

export async function renderAppView(
  store: IndexStore,
  hosts: string[],
  path: string,
  q: URLSearchParams,
  global?: GlobalDeps,
): Promise<ViewResult | null> {
  if (path === '/' || path === '') return { status: 200, body: overview(store, hosts, q) };
  if (path === '/firehose-global' || path === '/global') {
    if (!global) return { status: 200, body: page('Global firehose', '<h1>Global firehose indexer not enabled</h1>') };
    return { status: 200, body: firehoseGlobal(global.store, global.indexer) };
  }
  if (path === '/providers') return { status: 200, body: providers(store) };
  if (path === '/usage') return { status: 200, body: usagePage(store, q) };
  if (path === '/disagreements') return { status: 200, body: disagreementView(store) };
  if (path === '/records') return { status: 200, body: records(store) };
  if (path === '/rejections') return { status: 200, body: rejections(store) };
  if (path === '/lag') return { status: 200, body: lagPage(store) };
  if (path === '/experiments') return { status: 200, body: await experimentsPage() };
  const em = path.match(/^\/experiments\/([^/]+)$/);
  if (em) return { status: 200, body: await experimentDetail(decodeURIComponent(em[1] as string)) };
  if (path === '/verify') return { status: 200, body: await verifyPage(store, q) };
  const pm = path.match(/^\/provider\/([^/]+)$/);
  if (pm) return { status: 200, body: providerDetail(store, decodeURIComponent(pm[1] as string)) };
  return null;
}

/** Only recent, verified LLM observations can contribute to this demo summary. */
function overview(store: IndexStore, _hosts: string[], _q?: URLSearchParams): string {
  const now = Date.now();
  const maxAgeMs = 15 * 60 * 1000;
  const rows = providerRows(store).filter((row) => row.serviceType === 'llm' || row.serviceType === '');
  const providers = [...new Set(['openai', 'anthropic', 'google', 'groq', 'mistral', 'aws.bedrock', ...rows.map((r) => r.provider)])];
  const cards = providers.map((provider) => {
    const reports = rows.filter((row) => row.provider === provider);
    const recent = reports.filter((row) => {
      const age = now - Date.parse(row.observedAt);
      return row.sigVerified && Number.isFinite(age) && age >= 0 && age <= maxAgeMs;
    });
    const errors = recent.reduce((sum, row) => sum + row.totalErrors, 0);
    const status = recent.length === 0 ? 'UNKNOWN' : errors > 0 ? 'ERRORS REPORTED' : 'NO ERRORS REPORTED';
    const badge = recent.length === 0 ? 'muted-badge' : errors > 0 ? 'warn' : 'ok';
    const detail = recent.length === 0
      ? reports.length ? 'Stored observations are stale, undated, future-dated, or unverified.' : 'No observations received.'
      : `${recent.length} recent report(s); ${errors} reported error(s).`;
    const latest = reports.map((row) => row.observedAt).filter((at) => Number.isFinite(Date.parse(at))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
    return `<a href="/provider/${encodeURIComponent(provider)}" class="status-card">
      <h2>${esc(provider)}</h2><span class="badge ${badge}">${status}</span>
      <p>${esc(detail)}</p><small>Latest observation: ${latest ? esc(latest) : 'none'}</small>
    </a>`;
  }).join('');
  return page('Demo overview', `<h1>Peer Telemetry sample observations</h1>
    <p class="sub">Only signature-verified observations from the last 15 minutes contribute to these summaries. Missing data means unknown. Reports describe the publishers’ observations, not a provider-wide outage.</p>
    <div class="status-grid">${cards}</div>`);
}

// --- /firehose-global : the round-trip page (FIREHOSE-INDEXER-TASK) --------

/**
 * Connect-storm fix deploy time (commit ed5ee8f, appview restart). The clean
 * latency window starts here: tip_resets froze at 26969 (pre-fix) and the
 * indexer subscribed at the live tip once, resuming from cursor ever since.
 */
const FIX_SINCE = '2026-07-25T15:29:30.000Z';

function firehoseGlobal(store: GlobalStore, indexer: { status(): { relayHost: string; connected: boolean; connectedSince: string | null; lastSeq: number; cursor: number; reconnects: number; filtered?: boolean; source?: string; jetstreamEvents?: number; verified?: number; fetchDrops?: number; fetchRetries?: number; reconcileMissing?: number; deletesConfirmed?: number; deletesRejected?: number; queueDepth?: number } }): string {
  const st = indexer.status();
  const agg = globalAggregate(store);
  const rows = globalProviderRows(store).sort((a, b) => b.seq - a.seq);
  const latest = store.latestRecords();
  const events = store.eventCount();
  const rejected = store.getStat('commits_rejected');
  const relayHost = esc(st.relayHost);

  const aggRows = agg
    .map(
      (a) => `<tr>
    <td><span class="pill">${esc(a.provider)}</span></td>
    <td>${a.publishers}</td><td>${a.reports}</td>
    <td>${a.totalErrors}</td><td>${a.maxErrors}</td>
    <td>${errCodes(a.codes, a.totalErrors)}</td>
    <td>${a.latestSeq}</td>
    <td>${a.latestObservedAt ? id(a.latestObservedAt) : '—'}</td>
  </tr>`,
    )
    .join('');

  const detailRows = rows
    .map(
      (r) => `<tr>
    <td><span class="pill">${esc(r.provider)}</span></td>
    <td>${esc(r.model)}</td>
    <td>${errCodes(r.errors, r.totalErrors)}</td>
    <td>${r.observedAt ? id(r.observedAt) : '—'}</td>
    <td>${id(r.did)}</td>
    <td>${id(r.rkey)}</td>
    <td>${r.seq}</td>
    <td>${id(r.commitCid)}</td>
    <td>${r.opCid ? id(r.opCid) : '—'}</td>
    <td>${id(r.rev)}</td>
    <td>${sigBadge(r.sigOk)}</td>
  </tr>`,
    )
    .join('');

  const empty = latest.length === 0;
  const emptyNote = empty
? `<div class="card"><span class="badge warn">no global-firehose records yet</span> — the indexer is connected at the live tip and waiting. Nothing here is read from the local aggregator index; a row only appears when a commit for <span class="pill">${esc(ERROR_METRICS_NSID)}</span> (or the legacy <span class="pill">app.omniroute.errorReport</span>, still read) arrives back out of <strong>${relayHost}</strong>'s merged global stream and its signature verifies against the publisher's did:web document. If publishers are idle, start the publisher sims and watch rows land here.</div>`
    : '';

  // In-band round-trip latency: frame_time/arrived_at - emittedAt (signed record).
  // Live frames only for the arrival distribution; indexed_at is never used.
  // Two views: ALL-TIME (includes pre-connect-storm-fix rows, replay-excluded via
  // the live flag) and the CLEAN WINDOW since the fix was deployed (tip_resets
  // froze at its pre-fix value and never increments again).
  const lat = globalLatency(store);
  const clean = globalLatency(store, FIX_SINCE);
  const ms = (v: number | null): string => (v == null ? '—' : `${v} ms`);
  const msOrMin = (v: number): string =>
    v >= 60_000 ? `${Math.round(v / 1000)} s (${(v / 60_000).toFixed(1)} min)` : `${v} ms`;

  // TRUE current live lag: how far behind wall-clock the freshest
  // correlation-carrying sample actually is. Unlike the windowed live
  // distributions below, this INCLUDES the replay/catch-up reality — when the
  // consumer is minutes behind, the freshest data it has processed is old and
  // this number says so, loudly. Both numbers are shown, labelled.
  const cur = globalLatency(store).currentLag;
  const currentLagBanner = cur
    ? `<div class="card" style="border-left:4px solid var(--bad)"><h2>Current live lag — the unflattering number</h2>
<div class="sub">Right now (${id(cur.measuredAt)}) the freshest stamped record this consumer has processed was emitted <strong>${id(cur.emittedAt)}</strong> and arrived <strong>${id(cur.arrivedAt)}</strong>.</div>
<div class="stat"><div class="n" style="color:var(--bad)">${msOrMin(cur.lagMs)}</div><div class="l">Current live lag (now − newest emittedAt) — how far behind this single consumer actually is</div></div>
<div class="sub">On the Jetstream-notify + getRecord-verify path this number should stay small and NOT grow over a run: verification load is our own record rate (~0.3/s), not ~383/s of strangers' traffic, so this single VM stays at the tip. Contrast the historical raw-firehose baseline (labelled in LATENCY-SOAK.md), where the same VM fell ~23.7 h behind because bsky.network ignores <span class="pill">wantedCollections</span> and streams the full firehose.</div>
</div>`
    : '';
  const latencyCard =
    lat.relayDelayMs.n === 0
      ? `<div class="card"><h2>Global round-trip latency</h2><div class="sub">No records with in-band <span class="pill">seq</span>/<span class="pill">emittedAt</span> correlation fields indexed yet — the latency distribution appears here once sim-stamped records arrive back via the global stream.</div></div>`
      : `<div class="card"><h2>Global round-trip latency — Jetstream notify + verify</h2>
<div class="sub">Publisher stamped <span class="pill">emittedAt</span> INSIDE the signed record at ping time. On this path <span class="pill">frame_time</span> is the publisher's own <span class="pill">emittedAt</span> (there is no relay frame stamp — the notification comes from Jetstream, the signed record from the publisher's PDS), so <strong>arrival lag</strong> (arrived_at − emittedAt) is emittedAt → Jetstream notification at our socket, and the getRecord fetch+verify tax is added before indexing. Percentiles, never means. JSON: <span class="pill">/api/global/latency</span> (add <span class="pill">?since=ISO</span> for a window).</div>
<table>
<thead><tr><th>Window</th><th>n</th><th>Relay delay p50</th><th>p90</th><th>p99</th><th>max</th><th>Arrival lag p50</th><th>p90</th><th>p99</th><th>max</th><th>live n</th></tr></thead>
<tbody>
<tr><td><strong>Clean window</strong> since ${id(FIX_SINCE)} — live frames only; arrival lag here is the first minutes after a fresh tip-subscribe, before the consumer falls behind (see current live lag above)</td><td>${clean.total}</td><td>${ms(clean.relayDelayMs.p50)}</td><td>${ms(clean.relayDelayMs.p90)}</td><td>${ms(clean.relayDelayMs.p99)}</td><td>${ms(clean.relayDelayMs.max)}</td><td>${ms(clean.arrivalDelayMs.p50)}</td><td>${ms(clean.arrivalDelayMs.p90)}</td><td>${ms(clean.arrivalDelayMs.p99)}</td><td>${ms(clean.arrivalDelayMs.max)}</td><td>${clean.live}</td></tr>
<tr><td>All-time (includes pre-fix storm rows)</td><td>${lat.total}</td><td>${ms(lat.relayDelayMs.p50)}</td><td>${ms(lat.relayDelayMs.p90)}</td><td>${ms(lat.relayDelayMs.p99)}</td><td>${ms(lat.relayDelayMs.max)}</td><td>${ms(lat.arrivalDelayMs.p50)}</td><td>${ms(lat.arrivalDelayMs.p90)}</td><td>${ms(lat.arrivalDelayMs.p99)}</td><td>${ms(lat.arrivalDelayMs.max)}</td><td>${lat.live}</td></tr>
</tbody></table>
<div class="sub"><span class="pill">arrived_at</span> is stamped at Jetstream notification receipt — before the getRecord fetch + signature verification, so it is never inflated by that work. ${lat.backfilled} all-time rows are backfill/replay. On this notify+verify path the arrival lag should stay flat over a run (verification is our own ~0.3/s, not ~383/s), unlike the historical raw-firehose baseline where the same VM fell ~23.7 h behind. Compare LOCAL aggregator latency (ping→indexed via our own firehose): <strong>p50 ≈ 71 ms</strong> (EXPERIMENT-RESULTS.md §10).</div>
</div>`;

  return page(
    'GLOBAL firehose index',
    `
<h1>Global firehose index — Jetstream notify + getRecord verify</h1>
<div class="sub"><strong>${latest.length} records from ${store.distinctDids().length} did:web repos, discovered globally via Jetstream ${id(relayHost)}</strong>. KILL-RAW-FIREHOSE.md: this indexer NO LONGER drinks anyone's raw firehose (bsky.network ignores <span class="pill">wantedCollections</span> and one VM cannot verify ~383 commits/s). It subscribes <span class="pill">wss://${relayHost}/subscribe?wantedCollections=app.omniroute.errorReport</span> as a filtered NOTIFICATION channel, then on each notification fetches the SIGNED record from the publisher's own PDS via <span class="pill">com.atproto.sync.getRecord</span> and verifies it against the publisher's did:web key with <span class="pill">verifyRecords</span> before indexing. A record is indexed ONLY after verification; nothing is indexed from Jetstream's unsigned JSON. A slow <span class="pill">listRecords</span> reconciliation sweep catches anything Jetstream drops by omission. (Our PDS's own <span class="pill">subscribeRepos</span> EMISSION is untouched.)</div>
<div class="card">
  <div class="stat"><div class="n">${latest.length}</div><div class="l">Live records (latest per rkey)</div></div>
  <div class="stat"><div class="n">${store.distinctDids().length}</div><div class="l">did:web repos</div></div>
  <div class="stat"><div class="n">${st.verified ?? events}</div><div class="l">Verified + indexed</div></div>
  <div class="stat"><div class="n">${st.jetstreamEvents ?? 0}</div><div class="l">Jetstream notifications</div></div>
  <div class="stat"><div class="n" style="color:${(st.reconcileMissing ?? 0) > 0 ? 'var(--bad)' : 'var(--fg)'}">${st.reconcileMissing ?? 0}</div><div class="l">Reconcile: at source, never notified</div></div>
  <div class="stat"><div class="n" style="color:${(st.fetchDrops ?? 0) > 0 ? 'var(--bad)' : 'var(--fg)'}">${st.fetchDrops ?? 0}</div><div class="l">Fetch drops (never indexed)</div></div>
  <div class="stat"><div class="n" style="color:${rejected > 0 ? 'var(--bad)' : 'var(--fg)'}">${rejected}</div><div class="l">Verification rejections</div></div>
  <div class="stat"><div class="n">${st.connected ? '<span class="badge ok">LIVE</span>' : '<span class="badge bad">DISCONNECTED</span>'}</div><div class="l">Jetstream socket</div></div>
</div>
<div class="card"><div class="sub">Jetstream ${id(st.relayHost)} · resume cursor ${st.cursor > 0 ? esc(String(st.cursor)) + ' (time_us)' : 'live tail (no cursor)'} · connected since ${st.connectedSince ? id(st.connectedSince) : '—'} · stats: ${store.getStat('jetstream_events')} Jetstream notifications, ${store.getStat('records_indexed')} verified + indexed, ${store.getStat('reconcile_missing')} reconcile-missing (at source but never notified), ${store.getStat('fetch_drops')} fetch drops (after ${store.getStat('fetch_retries')} retries), ${store.getStat('deletes_confirmed')} deletes confirmed / ${store.getStat('deletes_rejected')} deletes rejected (source still served the record), ${store.getStat('key_refreshes')} key re-resolves (rotation), ${store.getStat('connections')} connections, ${store.getStat('reconnects')} reconnects (cursor-resumed) · verify queue depth ${st.queueDepth ?? 0}</div></div>
${emptyNote}
${currentLagBanner}
${latencyCard}
<h2>Aggregated by provider (global-firehose-sourced)</h2>
<div class="card"><table>
<thead><tr><th>Provider</th><th>Publishers</th><th>Reports</th><th>Total errors</th><th>Max errors</th><th>Error codes</th><th>Latest seq</th><th>Latest observedAt</th></tr></thead>
<tbody>${aggRows || '<tr><td colspan="8"><small>nothing aggregated yet — waiting for the global firehose</small></td></tr>'}</tbody>
</table></div>
<h2>Latest record per (repo, collection, rkey) — full provenance</h2>
<div class="card"><table>
<thead><tr><th>Provider</th><th>Model</th><th>Error codes</th><th>observedAt</th><th>Publisher DID</th><th>rkey</th><th>Relay seq</th><th>Commit CID</th><th>Record CID</th><th>Rev</th><th>Signature</th></tr></thead>
<tbody>${detailRows || '<tr><td colspan="11"><small>no records yet</small></td></tr>'}</tbody>
</table></div>
<div class="sub">Auto-refreshes every 5s. Cross-check any DID at its own PDS: <span class="pill">curl "https://PDS_HOST/xrpc/com.atproto.sync.getRecord?did=DID&collection=app.omniroute.errorReport&rkey=RKEY"</span> (the same signed CAR this indexer verifies).</div>
<script>setTimeout(function(){location.reload();},5000);</script>`,
  );
}

/**
 * Health-error RATE cell. The errors tier carries a COARSE volume BUCKET, not an
 * exact count (USAGE-STATS §3), so the rate is an APPROXIMATE range, never a
 * false-precision point value. Legacy records carry no denominator; show the raw
 * count with a note. Exact rates require the separate usageMetrics tier.
 */
function healthRate(r: ProviderRow): string {
  if (!r.requestVolumeBucket) {
    return `<small class="muted">${r.totalErrors} err / no volume</small>`;
  }
  const { low, high } = bucketBounds(r.requestVolumeBucket);
  // Rate range: dividing by the SMALLER count gives the higher rate bound.
  const hiPct = low > 0 ? (r.totalErrors / low) * 100 : null;
  const loPct = high != null && high > 0 ? (r.totalErrors / high) * 100 : null;
  const approx =
    loPct != null && hiPct != null
      ? `~${loPct.toFixed(1)}-${hiPct.toFixed(1)}%`
      : hiPct != null
        ? `&lt;${hiPct.toFixed(1)}%`
        : '~0%';
  return `${approx} <small class="muted">(${r.totalErrors} err / ${esc(r.requestVolumeBucket)} req)</small>`;
}

function providerTableRows(rows: ProviderRow[]): string {
  return rows
    .map(
      (r) => `<tr>
    <td>${r.serviceType ? `<span class="pill">${esc(r.serviceType)}</span>` : '<small class="muted">-</small>'}</td>
    <td><span class="pill">${esc(r.provider)}</span></td>
    <td>${esc(r.model)}</td>
    <td>${errCodes(r.errors, r.totalErrors)}</td>
    <td>${healthRate(r)}</td>
    <td>${r.emitter ? esc(r.emitter) : '<small class="muted">unknown</small>'}</td>
    <td>${id(r.did)}</td>
    <td>${id(r.sourcePds)}</td>
    <td>${sigBadge(r.sigVerified)}</td>
    <td>${id(r.cid)}</td>
    <td>${id(r.rev)}</td>
  </tr>`,
    )
    .join('');
}

function providers(store: IndexStore): string {
  const rows = providerRows(store).sort((a, b) => b.totalErrors - a.totalErrors);
  return page(
    'Providers',
    `<h1>All provider reports</h1>
<div class="sub">Every indexed <span class="pill">${esc(ERROR_METRICS_NSID)}</span> (and legacy <span class="pill">app.omniroute.errorReport</span>, dual-read), with the specific provider error codes observed (codes you can look up in that provider's docs). Source PDS, publishing DID and signature state on every row. Nothing truncated.</div>
<div class="card"><table>
<thead><tr><th>Service</th><th>Provider</th><th>Model</th><th>Error codes</th><th>Health rate (approx)</th><th>Emitter</th><th>Publisher DID</th><th>Source PDS</th><th>Signature</th><th>Record CID</th><th>Rev</th></tr></thead>
<tbody>${providerTableRows(rows) || '<tr><td colspan="11"><small>no records yet</small></td></tr>'}</tbody>
</table></div>`,
  );
}

/**
 * Usage rankings page (USAGE-STATS). Self-reported, so the sybil caveat is shown
 * as prominently as the ranking itself; the publisher set is always visible and
 * the ranking can be filtered to a chosen publisher subset (there is no single
 * canonical ranking).
 */
function usagePage(store: IndexStore, q: URLSearchParams): string {
  // Optional publisher allowlist from the query (?publishers=did1,did2). When
  // present, the ranking counts ONLY those publishers - the consumer chooses
  // whose numbers to trust.
  const filterRaw = (q.get('publishers') ?? '').trim();
  const onlyDids = filterRaw
    ? new Set(filterRaw.split(',').map((s) => s.trim()).filter(Boolean))
    : undefined;
  const ranking = rankUsage(store, onlyDids);
  const allRows = usageRows(store);
  const allPublishers = [...new Set(allRows.map((r) => r.did))].sort();

  const sybil = `<div class="card" style="border-left:3px solid var(--warn,#c80)">
    <strong>These numbers are self-reported.</strong> Anyone can register a domain, stand up a
    <span class="pill">did:web</span>, and claim any volume against any model. A decentralized
    ranking with no defense looks authoritative while being trivially gamed, so read this the
    way you read the signing-key trust note: fabrication is possible; <em>anonymous</em>
    fabrication is not. Every number here is <strong>signed and attributable</strong> to the
    publisher DID on its row, only signature-verified records are counted, and you decide whom
    to count. This is a ranking across <strong>the ${ranking.publishers.length} attested
    publisher(s) below</strong>, never "the" ranking. ${ranking.unverifiedSkipped > 0 ? `<strong>${ranking.unverifiedSkipped}</strong> record(s) were skipped because their signature did not verify.` : ''}
  </div>`;

  const filterForm = `<div class="card"><form method="get" action="/usage">
    <div class="sub">Count only these publisher DIDs (comma-separated); leave blank to count all attested publishers.</div>
    <input name="publishers" value="${esc(filterRaw)}" size="60" placeholder="did:web:known-op-a.example,did:web:known-op-b.example">
    <button type="submit">Rank</button>
  </form></div>`;

  const publisherList = allPublishers.length
    ? allPublishers
        .map((d) => `<span class="pill">${esc(d)}</span>`)
        .join(' ')
    : '<small class="muted">no usage publishers seen yet</small>';

  const rankRows = ranking.rows.length
    ? ranking.rows
        .map(
          (a) => `<tr>
      <td><span class="pill">${esc(a.provider)}</span></td>
      <td>${esc(a.model)}</td>
      <td>${a.operationCount.toLocaleString('en-US')}</td>
      <td>${a.inputTokens.toLocaleString('en-US')}</td>
      <td>${a.outputTokens.toLocaleString('en-US')}</td>
      <td>${a.publishers}${a.singleSource ? ' <small class="muted">single source</small>' : ''}</td>
    </tr>`,
        )
        .join('')
    : '<tr><td colspan="6"><small>no usage records from the counted publishers</small></td></tr>';

  const rawRows = allRows
    .sort((a, b) => b.operationCount - a.operationCount)
    .map(
      (r) => `<tr>
    <td>${r.serviceType ? `<span class="pill">${esc(r.serviceType)}</span>` : '<small class="muted">-</small>'}</td>
    <td><span class="pill">${esc(r.provider)}</span></td>
    <td>${esc(r.model)}</td>
    <td>${r.operationCount.toLocaleString('en-US')}</td>
    <td>${r.inputTokens.toLocaleString('en-US')}</td>
    <td>${r.outputTokens.toLocaleString('en-US')}</td>
    <td>${latCell(r)}</td>
    <td>${r.emitter ? esc(r.emitter) : '<small class="muted">unknown</small>'}</td>
    <td>${r.kAnonRare ? '<small class="muted">rare/deanon risk</small>' : ''}</td>
    <td>${id(r.did)}</td>
    <td>${sigBadge(r.sigVerified)}</td>
  </tr>`,
    )
    .join('');

  return page(
    'Usage rankings',
    `<h1>Usage rankings</h1>
<div class="sub">Aggregate LLM usage from <span class="pill">${esc(USAGE_METRICS_NSID)}</span>, a separate opt-in signal. Precise counts (unlike the coarse error-tier volume). Latency is percentiles, never means.</div>
${sybil}
${filterForm}
<h2>Ranking (${ranking.rows.length} models across ${ranking.publishers.length} counted publisher(s))</h2>
<div class="card"><table>
<thead><tr><th>Provider</th><th>Model</th><th>Operations</th><th>Input tokens</th><th>Output tokens</th><th>Publishers</th></tr></thead>
<tbody>${rankRows}</tbody>
</table></div>
<h2>Counted publisher set (${ranking.publishers.length})</h2>
<div class="card">${ranking.publishers.length ? ranking.publishers.map((d) => `<span class="pill">${esc(d)}</span>`).join(' ') : '<small class="muted">none</small>'}</div>
<h2>All usage publishers seen (${allPublishers.length})</h2>
<div class="card">${publisherList}</div>
<h2>Every usage record (nothing truncated)</h2>
<div class="card"><table>
<thead><tr><th>Service</th><th>Provider</th><th>Model</th><th>Operations</th><th>Input tok</th><th>Output tok</th><th>Latency p50/p90/p99 ms</th><th>Emitter</th><th>k-anon</th><th>Publisher DID</th><th>Signature</th></tr></thead>
<tbody>${rawRows || '<tr><td colspan="11"><small>no usage records yet</small></td></tr>'}</tbody>
</table></div>`,
  );
}

function latCell(r: UsageRow): string {
  const f = (n: number | null): string => (n == null ? '-' : String(n));
  return `${f(r.latencyMsP50)} / ${f(r.latencyMsP90)} / ${f(r.latencyMsP99)}`;
}

function providerDetail(store: IndexStore, provider: string): string {
  const rows = providerRows(store).filter((r) => r.provider === provider);
  const total = rows.reduce((a, b) => a + b.totalErrors, 0);
  return page(
    'Provider ' + provider,
    `<h1>Provider: <span class="pill">${esc(provider)}</span></h1>
<div class="sub">${rows.length} report(s) from ${new Set(rows.map((r) => r.did)).size} publisher(s) · total errors = ${total}</div>
<div class="card"><table>
<thead><tr><th>Provider</th><th>Model</th><th>Error codes</th><th>Publisher DID</th><th>Source PDS</th><th>Signature</th><th>Record CID</th><th>Rev</th></tr></thead>
<tbody>${providerTableRows(rows)}</tbody>
</table></div>`,
  );
}

function disagreementView(store: IndexStore): string {
  const dis = disagreements(store);
  const blocks = dis
    .map((d) => {
      const stateSummary = d.states
        .map((s) => `<span class="badge warn">${esc(s.state)}</span> <small>×${s.publishers.length}</small>`)
        .join(' &nbsp; ');
      return `<div class="card">
      <h2>${esc(d.provider)} &nbsp; ${stateSummary}</h2>
      <table>
      <thead><tr><th>Error profile</th><th>Total errors</th><th>Model</th><th>Publisher DID</th><th>Source PDS</th><th>Signature</th></tr></thead>
      <tbody>${d.rows
        .map(
          (r) => `<tr><td>${errCodes(r.errors, r.totalErrors)}</td><td>${r.totalErrors}</td><td>${esc(r.model)}</td><td>${id(r.did)}</td><td>${id(r.sourcePds)}</td><td>${sigBadge(r.sigVerified)}</td></tr>`,
        )
        .join('')}</tbody></table></div>`;
    })
    .join('');
  return page(
    'Disagreements',
    `<h1>Where publishers disagree</h1>
<div class="sub">Providers for which independent publishers report a <strong>materially different error-code profile</strong> (a different dominant code, or a &gt;2× spread in total errors). This is the most interesting output of a federated health commons — no single source of truth, and every row is independently signature-verified so you can trust who said what. Codes are provider-specific (429 rate_limit, 529 overloaded, 503, insufficient_quota, …) — look them up in that provider's docs.</div>
${blocks || '<div class="card"><small>No disagreements right now — all publishers agree on every provider they report, or the index is still warming up.</small></div>'}`,
  );
}

function records(store: IndexStore): string {
  const rows = store
    .allRecords()
    .map(
      (r) => `<tr>
    <td><span class="pill">${esc(r.collection)}</span></td>
    <td>${id(r.rkey)}</td>
    <td>${id(r.did)}</td>
    <td>${id(r.sourcePds)}</td>
    <td>${sigBadge(r.sigVerified)}</td>
    <td>${id(r.cid)}</td>
    <td>${id(r.rev)}</td>
    <td><a href="/verify?did=${encodeURIComponent(r.did)}&collection=${encodeURIComponent(r.collection)}&rkey=${encodeURIComponent(r.rkey)}">verify</a></td>
  </tr>`,
    )
    .join('');
  return page(
    'Records',
    `<h1>All indexed records</h1>
<div class="sub">${store.recordCount()} record(s). Full identifiers, source PDS, signature state.</div>
<div class="card"><table>
<thead><tr><th>Collection</th><th>rkey</th><th>Publisher DID</th><th>Source PDS</th><th>Signature</th><th>CID</th><th>Rev</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="8"><small>no records yet</small></td></tr>'}</tbody>
</table></div>`,
  );
}

function rejections(store: IndexStore): string {
  const rej = store.recentRejections(200);
  const rows = rej
    .map(
      (r) => `<tr><td><small>${esc(r.at)}</small></td><td>${id(r.did)}</td><td>${id(r.sourcePds)}</td><td>${r.rev ? id(r.rev) : ''}</td><td><span class="badge bad">${esc(r.reason)}</span></td></tr>`,
    )
    .join('');
  return page(
    'Rejections',
    `<h1>Rejected commits</h1>
<div class="sub">Commits the AppView refused to index because the signature did not verify against the publisher's DID document, or the document was unresolvable. This is the trust boundary made visible.</div>
<div class="card">
  <div class="stat"><div class="n" style="color:${rej.length > 0 ? 'var(--bad)' : 'var(--fg)'}">${store.getStat('commits_rejected')}</div><div class="l">Total rejected</div></div>
</div>
<div class="card"><table>
<thead><tr><th>Time</th><th>Publisher DID</th><th>Source PDS</th><th>Rev</th><th>Reason</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5"><small>No rejections — every indexed commit verified.</small></td></tr>'}</tbody>
</table></div>`,
  );
}

/** The /verify page: re-check a record end-to-end, showing each step. */
async function verifyPage(store: IndexStore, q: URLSearchParams): Promise<string> {
  const did = q.get('did') ?? '';
  const collection = q.get('collection') ?? ERROR_METRICS_NSID;
  const rkey = q.get('rkey') ?? '';

  const form = `
<div class="card">
<form class="inline" method="get" action="/verify">
  <div class="sub">Enter a record to re-verify end-to-end. The AppView will re-resolve the publisher's did:web document, re-fetch the record's covering proof from the PDS it was indexed from, and re-check the commit signature — showing each step.</div>
  DID <input name="did" value="${esc(did)}" size="34" placeholder="did:web:didwebuser1.0rs.org">
  collection <input name="collection" value="${esc(collection)}" size="26">
  rkey <input name="rkey" value="${esc(rkey)}" size="12" placeholder="current">
  <button class="go" type="submit">Verify</button>
</form>
</div>`;

  if (!did || !rkey) return page('Verify', `<h1>Verify a record</h1>${form}`);

  const indexed = store.getRecord(did, collection, rkey);
  const steps: string[] = [];
  const step = (ok: boolean, title: string, detail: string) =>
    steps.push(`<div class="step ${ok ? 'pass' : 'fail'}"><strong>${ok ? '✓' : '✗'} ${esc(title)}</strong><div>${detail}</div></div>`);

  // Step 1: the record is in our index.
  if (!indexed) {
    step(false, 'Record present in index', `No indexed record for ${esc(collection)}/${esc(rkey)} under this DID.`);
    return page('Verify', `<h1>Verify a record</h1>${form}${steps.join('')}`);
  }
  step(true, 'Record present in index', `Indexed from ${id(indexed.sourcePds)} at ${esc(indexed.indexedAt)}, rev ${id(indexed.rev)}`);

  // Step 2: resolve the publisher's did:web document -> #atproto key.
  let signingKey = '';
  try {
    const identity = await resolveDidWeb(
      did,
      { ...DEFAULT_RESOLVER_CONFIG, serviceEndpoint: 'https://appview.0rs.org', skipEndpointCheck: true },
      defaultResolverDeps(),
    );
    signingKey = identity.atprotoKey.didKey;
    step(true, 'Resolve publisher DID document', `Fetched https://${esc(didHost(did))}/.well-known/did.json · #atproto key ${id(signingKey)} · delegates to ${id(identity.pdsEndpoint)}`);
  } catch (err) {
    step(false, 'Resolve publisher DID document', `Could not resolve: ${esc((err as Error).message)}`);
    return page('Verify', `<h1>Verify a record</h1>${form}${steps.join('')}`);
  }

  // Step 3: fetch the covering-proof CAR from the source PDS (sync.getRecord).
  let commitOk = false;
  let commitCidStr = '';
  let commitRev = '';
  try {
    const url = new URL(`https://${indexed.sourcePds}/xrpc/com.atproto.sync.getRecord`);
    url.searchParams.set('did', did);
    url.searchParams.set('collection', collection);
    url.searchParams.set('rkey', rkey);
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`getRecord ${res.status}`);
    const car = new Uint8Array(await res.arrayBuffer());
    const { root, blocks } = await readCarWithRoot(car);
    commitCidStr = root.toString();
    const commitBytes = blocks.get(root);
    if (!commitBytes) throw new Error('commit block not in proof CAR');
    const commit = def.commit.schema.parse(cborToLex(commitBytes)) as unknown as Commit;
    commitRev = commit.rev;
    step(true, 'Fetch commit from PDS', `com.atproto.sync.getRecord on ${id(indexed.sourcePds)} · commit CID ${id(commitCidStr)} · rev ${id(commitRev)}`);

    // Step 4: verify the commit signature against the resolved key.
    commitOk = await verifyCommitSig(commit, signingKey);
    step(commitOk, 'Verify commit signature against #atproto key', commitOk ? `Signature is valid — this commit was signed by the key published at ${esc(didHost(did))}.` : `Signature does NOT verify against the published key.`);
  } catch (err) {
    step(false, 'Fetch + verify commit from PDS', `Failed: ${esc((err as Error).message)}`);
  }

  const verdict = commitOk
    ? `<div class="card"><span class="badge ok" style="font-size:15px">END-TO-END VERIFIED</span> — the record is present, the publisher's key resolved, and the commit signature checks out against it.</div>`
    : `<div class="card"><span class="badge bad" style="font-size:15px">VERIFICATION FAILED</span> — see the failing step above.</div>`;

  const value = (() => {
    try {
      return JSON.stringify(JSON.parse(indexed.recordJson), null, 2);
    } catch {
      return indexed.recordJson;
    }
  })();

  return page(
    'Verify',
    `<h1>Verify a record</h1>${form}
<h2>Verification steps</h2>${steps.join('')}
${verdict}
<h2>Indexed value</h2><div class="card"><pre>${esc(value)}</pre></div>`,
  );
}

function didHost(did: string): string {
  return decodeURIComponent(did.slice('did:web:'.length));
}

// --- /lag : live per-publisher aggregation lag ----------------------------

function lagPage(store: IndexStore): string {
  const now = Date.now();
  const rows: string[] = [];
  for (const did of store.distinctDids()) {
    const recs = store.recordsForDid(did);
    // Newest emittedAt across this publisher's indexed records.
    let newest = 0;
    let newestIso = '';
    let sourcePds = '';
    for (const r of recs) {
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(r.recordJson) as Record<string, unknown>;
      } catch {
        continue;
      }
      const em = typeof v.emittedAt === 'string' ? Date.parse(v.emittedAt) : NaN;
      if (Number.isFinite(em) && em > newest) {
        newest = em;
        newestIso = String(v.emittedAt);
        sourcePds = r.sourcePds;
      }
    }
    const lagMs = newest > 0 ? now - newest : null;
    const lagBadge =
      lagMs == null
        ? `<span class="badge muted-badge">no emittedAt</span>`
        : lagMs < 15_000
          ? `<span class="badge ok">${fmtMs(lagMs)}</span>`
          : lagMs < 120_000
            ? `<span class="badge warn">${fmtMs(lagMs)}</span>`
            : `<span class="badge bad">${fmtMs(lagMs)}</span>`;
    rows.push(`<tr>
      <td>${id(did)}</td>
      <td>${sourcePds ? id(sourcePds) : '—'}</td>
      <td>${recs.length}</td>
      <td>${newestIso ? id(newestIso) : '—'}</td>
      <td>${lagBadge}</td>
    </tr>`);
  }
  return page(
    'Lag',
    `<h1>Live aggregation lag</h1>
<div class="sub">For each publisher: <strong>now − emittedAt of its most recently indexed record</strong>. This is the one-glance health view — how far behind the index is versus when the publisher last stamped a record. Auto-refreshes every 5s. Lag includes each publisher's own tick interval, so a 60s-tick publisher naturally shows more lag than a 5s one.</div>
<div class="card"><table>
<thead><tr><th>Publisher DID</th><th>Source PDS</th><th>Records</th><th>Latest emittedAt (in record)</th><th>Lag</th></tr></thead>
<tbody>${rows.join('') || '<tr><td colspan="5"><small>no records indexed yet</small></td></tr>'}</tbody>
</table></div>
<div class="sub">Measured at ${esc(new Date(now).toISOString())}</div>
<script>setTimeout(function(){location.reload();},5000);</script>`,
  );
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

// --- /experiments : soak run list + detail --------------------------------

/** Directory holding soak result JSON. cwd-relative (systemd WorkingDirectory is
 *  the repo root); RESULTS_DIR overrides. Robust to the dist/src nesting. */
function resultsDir(): string {
  return process.env.RESULTS_DIR?.trim() || 'experiments/results';
}

async function listResultFiles(): Promise<Array<{ label: string; path: string; mtime: string }>> {
  const fs = await import('node:fs/promises');
  const nodePath = await import('node:path');
  const dir = resultsDir();
  try {
    const names = await fs.readdir(dir);
    const out: Array<{ label: string; path: string; mtime: string }> = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const stat = await fs.stat(nodePath.join(dir, n));
      out.push({ label: n.replace(/\.json$/, ''), path: n, mtime: stat.mtime.toISOString() });
    }
    out.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
    return out;
  } catch {
    return [];
  }
}

async function readResult(name: string): Promise<Record<string, unknown> | null> {
  const fs = await import('node:fs/promises');
  const nodePath = await import('node:path');
  try {
    const safe = name.replace(/[^a-zA-Z0-9._-]/g, '');
    const text = await fs.readFile(nodePath.join(resultsDir(), safe + '.json'), 'utf8');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function experimentsPage(): Promise<string> {
  const files = await listResultFiles();
  const rows = files
    .map(
      (f) => `<tr><td><a href="/experiments/${encodeURIComponent(f.label)}"><span class="pill">${esc(f.label)}</span></a></td><td><small>${esc(f.mtime)}</small></td></tr>`,
    )
    .join('');
  return page(
    'Experiments',
    `<h1>Soak experiments</h1>
<div class="sub">PHASE-4 continuous multi-publisher latency runs. Each run correlates every ping to its indexed record via the in-band (did, seq) key and reports the full bucket breakdown + per-hop percentiles. <strong>One VM: these are a lower bound on real-world latency.</strong></div>
<div class="card"><table>
<thead><tr><th>Run</th><th>Captured</th></tr></thead>
<tbody>${rows || '<tr><td colspan="2"><small>no runs captured yet</small></td></tr>'}</tbody>
</table></div>`,
  );
}

async function experimentDetail(label: string): Promise<string> {
  const r = await readResult(label);
  if (!r) return page('Experiment', `<h1>Run not found</h1><div class="sub">${esc(label)}</div>`);
  const b = r.buckets as Record<string, number>;
  const e = r.e2eLatencyMs as Record<string, number>;
  const hops = r.perHopMs as Record<string, Record<string, number>>;
  const sig = r.signatureVerification as Record<string, number>;
  const corr = r.correctness as { allMatch: boolean; perPublisher: Array<{ did: string; ok: boolean; feedRecords: number; indexedRecords: number; mismatches: unknown[] }> };
  const cont = r.firehoseContinuity as Record<string, { framesRecv: number; gaps: number; minSeq: number; maxSeq: number }>;
  const commitsPer = r.commitsPerAggregator as Record<string, number>;
  const lost = (r.lost as unknown[]) ?? [];

  const bucketBar = bucketSvg(b);
  const hopRows = Object.entries(hops)
    .map(([h, v]) => `<tr><td class="pill">${esc(h)}</td><td>${fmtN(v.p50)}</td><td>${fmtN(v.p90)}</td><td>${fmtN(v.p99)}</td><td>${fmtN(v.max)}</td><td><small>${v.n ?? ''}</small></td></tr>`)
    .join('');
  const corrRows = corr.perPublisher
    .map(
      (p) => `<tr><td>${id(p.did)}</td><td>${p.feedRecords}</td><td>${p.indexedRecords}</td><td>${p.ok ? '<span class="badge ok">match</span>' : `<span class="badge bad">${p.mismatches.length} mismatch</span>`}</td></tr>`,
    )
    .join('');
  const contRows = Object.entries(cont)
    .map(([h, v]) => `<tr><td>${id(h)}</td><td>${v.framesRecv}</td><td>${v.minSeq}–${v.maxSeq}</td><td>${v.gaps > 0 ? `<span class="badge bad">${v.gaps} gaps</span>` : '<span class="badge ok">0 gaps</span>'}</td></tr>`)
    .join('');
  const commitRows = Object.entries(commitsPer)
    .map(([h, n]) => `<tr><td>${id(h)}</td><td>${n}</td></tr>`)
    .join('');

  return page(
    'Run ' + label,
    `<h1>Soak run: <span class="pill">${esc(label)}</span></h1>
<div class="sub">${esc(String(r.startedAt))} → ${esc(String(r.finishedAt))} · minPingIntervalSec=${esc(String(r.minPingIntervalSec))}</div>
<div class="card"><strong>Honesty note:</strong> ${esc(String(r.note))}</div>

<div class="card">
  <div class="stat"><div class="n">${r.totalPings}</div><div class="l">Total pings</div></div>
  <div class="stat"><div class="n">${b.indexed}</div><div class="l">Indexed</div></div>
  <div class="stat"><div class="n">${b.debounced}</div><div class="l">Debounced</div></div>
  <div class="stat"><div class="n">${b['no-change']}</div><div class="l">No-change</div></div>
  <div class="stat"><div class="n" style="color:${(b.rejected ?? 0) > 0 ? 'var(--bad)' : 'var(--fg)'}">${b.rejected}</div><div class="l">Rejected</div></div>
  <div class="stat"><div class="n" style="color:${(b.lost ?? 0) > 0 ? 'var(--bad)' : 'var(--fg)'}">${b.lost}</div><div class="l">LOST</div></div>
</div>
<div class="card"><h2>Ping buckets</h2>${bucketBar}</div>

<h2>End-to-end latency: ping → indexed (ms)</h2>
<div class="card">
  <div class="stat"><div class="n">${fmtN(e.p50)}</div><div class="l">p50</div></div>
  <div class="stat"><div class="n">${fmtN(e.p90)}</div><div class="l">p90</div></div>
  <div class="stat"><div class="n">${fmtN(e.p99)}</div><div class="l">p99</div></div>
  <div class="stat"><div class="n">${fmtN(e.max)}</div><div class="l">max</div></div>
  <div class="stat"><div class="n">${e.n ?? 0}</div><div class="l">samples</div></div>
</div>

<h2>Per-hop breakdown (ms)</h2>
<div class="card"><table>
<thead><tr><th>Hop</th><th>p50</th><th>p90</th><th>p99</th><th>max</th><th>n</th></tr></thead>
<tbody>${hopRows}</tbody></table></div>

<h2>Signature verification</h2>
<div class="card"><span class="badge ok">${sig.verified} verified</span> &nbsp; <span class="badge ${(sig.rejected ?? 0) > 0 ? 'bad' : 'muted-badge'}">${sig.rejected} rejected</span></div>

<h2>Commits per aggregator</h2>
<div class="card"><table><thead><tr><th>PDS</th><th>Commits</th></tr></thead><tbody>${commitRows}</tbody></table></div>

<h2>Firehose continuity</h2>
<div class="card"><table><thead><tr><th>PDS</th><th>Frames</th><th>Seq range</th><th>Gaps</th></tr></thead><tbody>${contRows}</tbody></table></div>

<h2>Correctness: index vs live feed</h2>
<div class="card">${corr.allMatch ? '<span class="badge ok">ALL PUBLISHERS MATCH</span>' : '<span class="badge bad">MISMATCH — see below</span>'}
<table style="margin-top:10px"><thead><tr><th>Publisher DID</th><th>Feed records</th><th>Indexed</th><th>Match</th></tr></thead><tbody>${corrRows}</tbody></table></div>

${lost.length > 0 ? `<h2>LOST pings (reported loudly)</h2><div class="card"><pre>${esc(JSON.stringify(lost, null, 2))}</pre></div>` : '<div class="card"><span class="badge ok">Zero lost pings — every ping accounted for.</span></div>'}

<h2>Raw result JSON</h2>
<div class="card"><pre>${esc(JSON.stringify(r, null, 2))}</pre></div>`,
  );
}

function fmtN(v: number | null | undefined): string {
  return v == null ? '—' : String(v);
}

/** A tiny inline-SVG stacked bar of the ping buckets (no external chart libs). */
function bucketSvg(b: Record<string, number>): string {
  const order: Array<[string, string]> = [
    ['indexed', '#3fb950'],
    ['debounced', '#6ea8fe'],
    ['no-change', '#9aa3b2'],
    ['rejected', '#f85149'],
    ['lost', '#d29922'],
  ];
  const total = order.reduce((a, [k]) => a + (b[k] ?? 0), 0) || 1;
  const W = 720;
  const H = 34;
  let x = 0;
  const segs = order
    .map(([k, c]) => {
      const w = ((b[k] ?? 0) / total) * W;
      const rect = `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${H}" fill="${c}"><title>${k}: ${b[k] ?? 0}</title></rect>`;
      x += w;
      return rect;
    })
    .join('');
  const legend = order
    .map(([k, c]) => `<span style="display:inline-block;margin:8px 14px 0 0"><span style="display:inline-block;width:11px;height:11px;background:${c};border-radius:2px;vertical-align:middle"></span> ${k}: <strong>${b[k] ?? 0}</strong></span>`)
    .join('');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="max-width:100%;border-radius:6px;border:1px solid var(--line)">${segs}</svg><div>${legend}</div>`;
}
