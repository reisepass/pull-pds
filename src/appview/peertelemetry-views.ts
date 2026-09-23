import type { IndexStore } from './index-store.js';
import {
  metricRows,
  aggregateByProvider,
  ispStability,
  liveIncidents,
  bucketMidpoint,
  ERRORMETRICS_COLLECTION,
  type MetricRow,
  type ErrorCodeCount,
} from './peertelemetry.js';

/**
 * Server-rendered AppView HTML over the unified org.peertelemetry.errorMetrics
 * schema (ISP-SERVICETYPE.md). Same display rules as the omniroute AppView: every
 * view a bookmarkable GET, inline CSS, no build step, and the HARD RULE that
 * DIDs, CIDs, revs are NEVER truncated. Every row shows source PDS + signature.
 *
 *   /            -> cross-serviceType overview (llm + isp in one view, filterable)
 *   /isp         -> which ISP is more stable (buying decision)
 *   /live        -> is it just me right now (live incident check)
 *   /records     -> raw, every field, full provenance
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
.st-llm{background:rgba(110,168,254,.16);color:var(--accent)}
.st-isp{background:rgba(63,185,80,.14);color:var(--ok)}
.stat{display:inline-block;min-width:150px;margin:0 24px 14px 0}
.stat .n{font-size:24px;font-weight:700}
.stat .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.pill{font-family:ui-monospace,monospace;font-size:12px;background:var(--panel2);border:1px solid var(--line);border-radius:5px;padding:1px 6px}
form.inline{display:inline}
input,select{background:var(--panel2);border:1px solid var(--line);color:var(--fg);border-radius:6px;padding:6px 8px;font-size:13px}
button.go{background:var(--accent);color:#06122b;border:none;border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer}
`;

function esc(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function id(v: string): string {
  const e = esc(v);
  return `<span class="id">${e}</span><button class="copy" data-copy="${e}">copy</button>`;
}
function sigBadge(ok: boolean): string {
  return ok ? `<span class="badge ok">verified</span>` : `<span class="badge bad">UNVERIFIED</span>`;
}
function stBadge(st: string): string {
  const cls = st === 'llm' ? 'st-llm' : st === 'isp' ? 'st-isp' : 'muted-badge';
  return `<span class="badge ${cls}">${esc(st)}</span>`;
}
function errCodes(errors: ErrorCodeCount[], total: number): string {
  if (errors.length === 0) return `<span class="badge muted-badge">0 errors</span>`;
  const parts = errors
    .map((e) => {
      const k = e.code === 'link_down' ? 'bad' : /loss|429|5\d\d|529|503/.test(e.code) ? 'warn' : 'muted-badge';
      return `<span class="badge ${k}" title="provider error code">${esc(e.code)}×${e.count}</span>`;
    })
    .join(' ');
  return `${parts} <small>= ${total}</small>`;
}

function page(title: string, body: string): string {
  const nav = [
    ['/', 'All providers'],
    ['/isp', 'Which ISP is stable'],
    ['/live', 'Is it just me now'],
    ['/records', 'All records'],
    ['/health', 'Health'],
  ]
    .map(([h, l]) => `<a href="${h}">${l}</a>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head><body>
<header><span class="brand">peer telemetry · appview.0rs.org</span><nav>${nav}</nav></header>
<main>${body}</main>
<script>document.addEventListener('click',function(e){var b=e.target.closest('.copy');if(!b)return;var t=b.getAttribute('data-copy');navigator.clipboard&&navigator.clipboard.writeText(t);var o=b.textContent;b.textContent='copied';setTimeout(function(){b.textContent=o;},900);});</script>
</body></html>`;
}

export function renderPeerTelemetry(store: IndexStore, hosts: string[], path: string, q: URLSearchParams): ViewResult | null {
  if (path === '/' || path === '') return { status: 200, body: overview(store, hosts, q) };
  if (path === '/isp') return { status: 200, body: ispPage(store) };
  if (path === '/live') return { status: 200, body: livePage(store, q) };
  if (path === '/records') return { status: 200, body: recordsPage(store) };
  return null;
}

// --- cross-serviceType overview --------------------------------------------

function overview(store: IndexStore, hosts: string[], q: URLSearchParams): string {
  const filter = (q.get('serviceType') ?? '').trim().toLowerCase() || undefined;
  const agg = aggregateByProvider(store, filter);
  const all = metricRows(store);
  const serviceTypes = [...new Set(all.map((r) => r.serviceType))].sort();
  const households = new Set(all.map((r) => r.did)).size;
  const rejected = store.getStat('commits_rejected');
  const rows = agg
    .map(
      (a) => `<tr>
    <td>${stBadge(a.serviceType)}</td>
    <td><span class="pill">${esc(a.provider)}</span></td>
    <td>${a.publishers}</td>
    <td>${a.reports}</td>
    <td>${a.totalErrors}</td>
    <td>${a.approxErrorRatePct == null ? '<small>n/a</small>' : a.approxErrorRatePct + '%'}</td>
    <td>${errCodes(a.codes, a.totalErrors)}</td>
    <td>${a.latestObservedAt ? id(a.latestObservedAt) : '-'}</td>
  </tr>`,
    )
    .join('');
  const filterLinks = ['all', ...serviceTypes]
    .map((st) => {
      const href = st === 'all' ? '/' : `/?serviceType=${encodeURIComponent(st)}`;
      const active = (st === 'all' && !filter) || st === filter;
      return `<a href="${href}" ${active ? 'style="color:var(--fg);font-weight:700"' : ''}>${esc(st)}</a>`;
    })
    .join(' &nbsp;·&nbsp; ');
  return page(
    'Peer telemetry - all providers',
    `
<h1>Provider reliability, published by consumers</h1>
<div class="sub">One schema (<span class="pill">${ERRORMETRICS_COLLECTION}</span>) for any digital service provider, keyed by <span class="pill">serviceType</span>. LLM gateways and internet households appear in the same table because they are the same record shape. Every row was signature-verified against the publisher's own did:web document before it counted. No privileged access, nobody owns the dataset.</div>
<div class="card">
  <div class="stat"><div class="n">${households}</div><div class="l">Publishers</div></div>
  <div class="stat"><div class="n">${serviceTypes.length}</div><div class="l">Service types</div></div>
  <div class="stat"><div class="n">${agg.length}</div><div class="l">Provider rows${filter ? ' (filtered)' : ''}</div></div>
  <div class="stat"><div class="n">${hosts.length}</div><div class="l">Source PDSs</div></div>
  <div class="stat"><div class="n" style="color:${Number(rejected) > 0 ? 'var(--bad)' : 'var(--fg)'}">${rejected}</div><div class="l">Commits rejected</div></div>
</div>
<div class="sub">Filter by serviceType: ${filterLinks}</div>
<div class="card"><table>
<thead><tr><th>Service type</th><th>Provider</th><th>Publishers</th><th>Reports</th><th>Total health errors</th><th>Approx rate</th><th>Error codes</th><th>Latest observed</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8"><small>index still warming up - refresh in a moment</small></td></tr>'}</tbody>
</table></div>
<div class="sub">This is the cross-serviceType proof: <span class="pill">llm</span> and <span class="pill">isp</span> aggregated by one pipeline, filterable, no special-casing. <a href="/isp">Which ISP is more stable &rarr;</a> · <a href="/live">Is it just me right now &rarr;</a></div>`,
  );
}

// --- which ISP is more stable ----------------------------------------------

function ispPage(store: IndexStore): string {
  const table = ispStability(store);
  const rows = table
    .map(
      (a, i) => `<tr>
    <td>${i + 1}</td>
    <td><span class="pill">${esc(a.provider)}</span></td>
    <td>${a.households}</td>
    <td>${a.reports}</td>
    <td>${a.totalErrors}</td>
    <td>${a.approxErrorRatePct == null ? '<small>n/a</small>' : `<strong>${a.approxErrorRatePct}%</strong>`}</td>
    <td>${a.linkDownReports > 0 ? `<span class="badge bad">${a.linkDownReports}</span>` : '0'}</td>
    <td>${a.regions.map((r) => `<span class="pill">${esc(r)}</span>`).join(' ') || '<small>-</small>'}</td>
    <td>${errCodes(a.codes, a.totalErrors)}</td>
  </tr>`,
    )
    .join('');
  return page(
    'Which ISP is more stable',
    `
<h1>Which ISP is more stable</h1>
<div class="sub">The buying decision, for <span class="pill">serviceType=isp</span>. Ranked by provider-health error RATE (health errors over the coarse volume bucket), then by how many households reported a full link-down. Aggregated from real households publishing on their own did:web origins, every record signature-verified.</div>
<div class="card" style="border-left:3px solid var(--warn)">
  <strong>Honest scope (a finding, not a bug):</strong> "more stable" here means <em>fewer provider-health errors</em>, NOT <em>faster</em>. The unified <span class="pill">errorMetrics</span> schema has no throughput field, so the advertised-vs-delivered download number - the other half of the buying decision - cannot be expressed on this schema. See FINDINGS.md; the proposed minimal fix is an optional <span class="pill">qualitySample</span> shared by both serviceTypes.
</div>
<div class="card"><table>
<thead><tr><th>#</th><th>ISP</th><th>Households</th><th>Reports</th><th>Total health errors</th><th>Approx error rate</th><th>Link-down reports</th><th>Regions</th><th>Codes</th></tr></thead>
<tbody>${rows || '<tr><td colspan="9"><small>no isp records yet</small></td></tr>'}</tbody>
</table></div>`,
  );
}

// --- is it just me right now -----------------------------------------------

function livePage(store: IndexStore, q: URLSearchParams): string {
  const incidents = liveIncidents(store);
  const filterIsp = (q.get('isp') ?? q.get('provider') ?? '').trim().toLowerCase();
  const filterRegion = (q.get('region') ?? '').trim().toLowerCase();
  const shown = incidents.filter(
    (inc) => (!filterIsp || inc.provider.toLowerCase() === filterIsp) && (!filterRegion || inc.region.toLowerCase() === filterRegion),
  );
  const blocks = shown
    .map((inc) => {
      const verdict = inc.correlated
        ? `<span class="badge bad">NOT just you - ${inc.affectedHouseholds} households affected</span>`
        : `<span class="badge warn">only 1 household reporting - possibly just you</span>`;
      const didList = inc.dids.map((d) => `<div style="margin:3px 0">${id(d)}</div>`).join('');
      const rowsHtml = inc.rows
        .map(
          (r) => `<tr>
        <td>${id(r.did)}</td>
        <td><span class="pill">${esc(r.access)}</span></td>
        <td>${errCodes(r.errors, r.totalErrors)}</td>
        <td>${r.emittedAt ? id(r.emittedAt) : '-'}</td>
        <td>${id(r.sourcePds)}</td>
        <td>${sigBadge(r.sigVerified)}</td>
        <td>${id(r.cid)}</td>
        <td>${id(r.rev)}</td>
      </tr>`,
        )
        .join('');
      return `<div class="card">
      <h2><span class="pill">${esc(inc.provider)}</span> in region <span class="pill">${esc(inc.region)}</span> &nbsp; ${verdict}</h2>
      <div class="sub">Latest report at ${inc.latestAt ? id(inc.latestAt) : '-'} · affected households:</div>
      ${didList}
      <table>
      <thead><tr><th>Household DID</th><th>Access</th><th>Codes</th><th>Emitted at</th><th>Source PDS</th><th>Signature</th><th>Record CID</th><th>Rev</th></tr></thead>
      <tbody>${rowsHtml}</tbody></table></div>`;
    })
    .join('');
  return page(
    'Is it just me right now',
    `
<h1>Is it just me, or is my whole ISP down?</h1>
<div class="sub">The live incident check, for <span class="pill">serviceType=isp</span>. Households currently reporting a link-down or heavy packet loss, grouped by ISP and region. One household is "just you"; two or more on the same ISP in the same region at once is a correlated outage. Region and access are recovered from the signed rkey (<span class="pill">access.region</span>), because the schema carries no region field.</div>
<form class="inline" method="get" action="/live">
  <input name="isp" placeholder="isp e.g. telekom" value="${esc(q.get('isp') ?? '')}">
  <input name="region" placeholder="region e.g. de-by" value="${esc(q.get('region') ?? '')}">
  <button class="go" type="submit">Filter</button>
</form>
<div class="card">
  <div class="stat"><div class="n">${incidents.length}</div><div class="l">Active incident groups</div></div>
  <div class="stat"><div class="n" style="color:${incidents.some((i) => i.correlated) ? 'var(--bad)' : 'var(--fg)'}">${incidents.filter((i) => i.correlated).length}</div><div class="l">Correlated (not just you)</div></div>
</div>
${blocks || '<div class="card"><span class="badge ok">no ISP outages being reported right now</span></div>'}
<div class="sub">Auto-refreshes every 5s.</div>
<script>setTimeout(function(){location.reload();},5000);</script>`,
  );
}

// --- raw records ------------------------------------------------------------

function recordsPage(store: IndexStore): string {
  const rows = metricRows(store).sort((a, b) => (a.emittedAt < b.emittedAt ? 1 : -1));
  const tr = (r: MetricRow): string => `<tr>
    <td>${stBadge(r.serviceType)}</td>
    <td><span class="pill">${esc(r.provider)}</span>${r.model ? ` <small>${esc(r.model)}</small>` : ''}</td>
    <td>${r.serviceType === 'isp' ? `<span class="pill">${esc(r.access)}</span> ${esc(r.region)}` : '<small>-</small>'}</td>
    <td>${errCodes(r.errors, r.totalErrors)}</td>
    <td><small>${esc(r.requestVolumeBucket)}</small></td>
    <td>${r.emittedAt ? id(r.emittedAt) : '-'}</td>
    <td>${id(r.did)}</td>
    <td>${id(r.sourcePds)}</td>
    <td>${sigBadge(r.sigVerified)}</td>
    <td>${id(r.cid)}</td>
    <td>${id(r.rev)}</td>
  </tr>`;
  return page(
    'All records',
    `<h1>Every indexed record</h1>
<div class="sub">Every indexed <span class="pill">${ERRORMETRICS_COLLECTION}</span> record, newest first, full provenance: serviceType, publishing DID, source PDS, signature state, record CID, rev. Nothing truncated.</div>
<div class="card"><table>
<thead><tr><th>Service</th><th>Provider</th><th>Access / region</th><th>Codes</th><th>Volume</th><th>Emitted at</th><th>Publisher DID</th><th>Source PDS</th><th>Signature</th><th>Record CID</th><th>Rev</th></tr></thead>
<tbody>${rows.map(tr).join('') || '<tr><td colspan="11"><small>no records yet</small></td></tr>'}</tbody>
</table></div>`,
  );
}

export { bucketMidpoint };
