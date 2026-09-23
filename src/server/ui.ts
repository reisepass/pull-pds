import { Repo, verifyCommitSig, cborToLex, def } from '@atproto/repo';
import type { Commit } from '@atproto/repo';
import type { Pds } from '../pds-websub/app.js';

/**
 * Server-rendered HTML UI for the PDS (UI-TASK.md). Same process, same
 * Caddy, no build step, inline CSS, a little vanilla JS. Every view is a real
 * bookmarkable GET URL.
 *
 * HARD DISPLAY RULE (UI-TASK.md): never truncate a DID, CID, rev, signature, or
 * at:// URI. The `.id` CSS class renders every identifier full, monospace,
 * `word-break: break-all`, always selectable, with a click-to-copy button that
 * does NOT hide the text.
 */

export interface UiResult {
  status: number;
  html?: string;
  json?: unknown;
}

// ---------------------------------------------------------------------------
// Shared chrome
// ---------------------------------------------------------------------------

const CSS = `
:root{--bg:#0f1115;--panel:#171a21;--panel2:#1e222b;--fg:#e6e8ec;--muted:#9aa3b2;--line:#2a2f3a;--accent:#6ea8fe;--ok:#3fb950;--bad:#f85149;--warn:#d29922}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--panel);border-bottom:1px solid var(--line);padding:12px 20px;position:sticky;top:0;z-index:10}
header .brand{font-weight:700;font-size:16px;margin-right:18px}
nav a{margin-right:14px;color:var(--muted);font-size:14px}
nav a:hover{color:var(--fg)}
main{max-width:1100px;margin:0 auto;padding:22px 20px 60px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:26px 0 10px;color:var(--fg)}
.sub{color:var(--muted);font-size:13px;margin-bottom:18px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:200px 1fr;gap:8px 16px}
.grid .k{color:var(--muted);font-size:13px;padding-top:2px}
.grid .v{min-width:0}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
tr:hover td{background:var(--panel2)}
.id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all;white-space:normal;background:var(--panel2);border:1px solid var(--line);border-radius:6px;padding:3px 6px;display:inline-block;max-width:100%}
.id.sm{font-size:11px}
.copy{cursor:pointer;border:1px solid var(--line);background:var(--panel2);color:var(--muted);border-radius:5px;font-size:11px;padding:1px 6px;margin-left:6px;user-select:none}
.copy:hover{color:var(--fg);border-color:var(--accent)}
.badge{display:inline-block;border-radius:20px;padding:1px 9px;font-size:12px;font-weight:600}
.ok{background:rgba(63,185,80,.15);color:var(--ok)}
.bad{background:rgba(248,81,73,.15);color:var(--bad)}
.muted-badge{background:var(--panel2);color:var(--muted)}
.warn{background:rgba(210,153,34,.15);color:var(--warn)}
pre{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:14px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;white-space:pre-wrap;word-break:break-all}
.stat{display:inline-block;min-width:150px;margin:0 24px 14px 0}
.stat .n{font-size:24px;font-weight:700}
.stat .l{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.btn{display:inline-block;background:var(--accent);color:#06122b;border:none;border-radius:7px;padding:8px 14px;font-weight:600;cursor:pointer;font-size:14px}
.btn:hover{filter:brightness(1.08)}
.op{font-family:ui-monospace,monospace;font-size:12px}
.op.create{color:var(--ok)}.op.update{color:var(--warn)}.op.delete{color:var(--bad)}
#feed{max-height:70vh;overflow:auto}
.evt{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin-bottom:8px;background:var(--panel)}
.evt .t{font-weight:700;font-size:13px}
small.muted{color:var(--muted)}
`;

function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render a full, never-truncated identifier with a copy button. */
function id(value: string, cls = ''): string {
  const v = esc(value);
  return `<span class="id ${cls}">${v}</span><button class="copy" data-copy="${v}" title="copy">copy</button>`;
}

function badge(text: string, kind: 'ok' | 'bad' | 'warn' | 'muted'): string {
  const cls = kind === 'muted' ? 'muted-badge' : kind;
  return `<span class="badge ${cls}">${esc(text)}</span>`;
}

function page(title: string, body: string): string {
  const nav = [
    ['/', 'Dashboard'],
    ['/repos', 'Repos'],
    ['/firehose', 'Firehose'],
    ['/ingest-log', 'Ingest log'],
    ['/health', 'Health'],
    ['/readme', 'README'],
  ]
    .map(([href, label]) => `<a href="${href}">${label}</a>`)
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>${CSS}</style></head>
<body>
<header><span class="brand">pull-pds</span><nav>${nav}</nav></header>
<main>${body}</main>
<script>
document.addEventListener('click',function(e){
  var b=e.target.closest('.copy'); if(!b)return;
  var t=b.getAttribute('data-copy');
  navigator.clipboard&&navigator.clipboard.writeText(t);
  var o=b.textContent;b.textContent='copied';setTimeout(function(){b.textContent=o;},900);
});
</script>
</body></html>`;
}

function html(status: number, body: string): UiResult {
  return { status, html: body };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** Main dispatcher. Returns null if the path is not a UI route. */
export async function renderUi(pds: Pds, path: string): Promise<UiResult | null> {
  if (path === '/' || path === '') return dashboard(pds);
  if (path === '/repos') return repos(pds);
  if (path === '/firehose') return html(200, firehosePage());
  if (path === '/ingest-log') return ingestLog(pds);
  if (path === '/health') return { status: 200, json: health(pds) };
  if (path === '/readme') return docPage('README.md', 'README');

  // /repos/:did ... (did may itself contain slashes? no - it's URL-encoded)
  const m = path.match(/^\/repos\/([^/]+)(\/.*)?$/);
  if (m) {
    const did = decodeURIComponent(m[1] as string);
    const rest = m[2] ?? '';
    if (rest === '' || rest === '/') return repoDetail(pds, did);
    if (rest === '/commits') return commits(pds, did);
    const rm = rest.match(/^\/records\/([^/]+)\/([^/]+)$/);
    if (rm) return recordView(pds, did, decodeURIComponent(rm[1] as string), decodeURIComponent(rm[2] as string));
  }
  return null;
}

function uptime(pds: Pds): string {
  const ms = Date.now() - pds.bootedAtMs;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mn = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${mn}m ${sec}s`;
}

function health(pds: Pds): Record<string, unknown> {
  return {
    status: 'ok',
    uptimeSeconds: Math.floor((Date.now() - pds.bootedAtMs) / 1000),
    sequencerCursor: pds.sequencer.currentSeq(),
    totalRepos: pds.meta.listDids().length,
    totalCommits: pds.totalCommits(),
    lastIngestAt: pds.lastIngestAt(),
    pdsDid: pds.config.pdsDid,
  };
}

async function dashboard(pds: Pds): Promise<UiResult> {
  const dids = pds.meta.listDids();
  const seq = pds.sequencer.currentSeq();
  const c = pds.config;
  const body = `
<h1>pull-pds</h1>
<div class="sub">A did:web pull-PDS. Publishers host static feeds and ping over WebSub; this server pulls, signs, and serves a standard atproto repo.</div>

<div class="card">
  <div class="stat"><div class="n">${dids.length}</div><div class="l">Hosted repos</div></div>
  <div class="stat"><div class="n">${pds.totalCommits()}</div><div class="l">Commits this boot</div></div>
  <div class="stat"><div class="n">${seq}</div><div class="l">Firehose seq</div></div>
  <div class="stat"><div class="n">${esc(uptime(pds))}</div><div class="l">Uptime</div></div>
</div>

<div class="card">
<div class="grid">
  <div class="k">PDS DID</div><div class="v">${id(c.pdsDid)}</div>
  <div class="k">Signing key (did:key)</div><div class="v">${id(pds.pdsKey.didKey)}</div>
  <div class="k">Signing pubkey (multibase)</div><div class="v">${id(pds.pdsKey.publicKeyMultibase)}</div>
  <div class="k">Endpoint</div><div class="v">${id(c.selfEndpoint)}</div>
  <div class="k">Hub URL</div><div class="v">${id(c.selfEndpoint + '/websub')}</div>
  <div class="k">Allowed collections</div><div class="v">${c.allowedCollections.map((x) => `<span class="op">${esc(x)}</span>`).join(', ')}</div>
  <div class="k">Ingest mode</div><div class="v">${esc(c.ingestMode)}</div>
  <div class="k">Key mode</div><div class="v">${esc(c.keyMode)}</div>
  <div class="k">Last ingest</div><div class="v">${pds.lastIngestAt() ? esc(pds.lastIngestAt()) : '<small class="muted">none yet</small>'}</div>
</div>
</div>

<div class="card">
  <a class="btn" href="/repos">Browse repos &rarr;</a>
  <a class="btn" href="/firehose" style="margin-left:8px">Live firehose &rarr;</a>
  <a class="btn" href="/ingest-log" style="margin-left:8px">Ingest log &rarr;</a>
</div>`;
  return html(200, page('pull-pds', body));
}

async function repos(pds: Pds): Promise<UiResult> {
  const dids = pds.meta.listDids();
  const rows: string[] = [];
  for (const did of dids) {
    const mgr = await pds.repoFor(did);
    const root = mgr.getRoot();
    const rev = mgr.getRev();
    const active = pds.meta.isActive(did);
    const recs = await mgr.currentRecords();
    const latest = mgr.storage.getLatestCommit();
    rows.push(`<tr>
      <td>${id(did)}<div style="margin-top:4px"><a href="/repos/${encodeURIComponent(did)}">open</a></div></td>
      <td>${root ? id(root.toString(), 'sm') : '<small class="muted">empty</small>'}</td>
      <td>${rev ? id(rev, 'sm') : '—'}</td>
      <td>${active ? badge('active', 'ok') : badge('inactive', 'muted')}</td>
      <td>${recs.length}</td>
      <td>${latest ? mgr.storage.listCommits().length : 0}</td>
    </tr>`);
  }
  const body = `
<h1>Hosted repos</h1>
<div class="sub">${dids.length} repo(s). Every identifier below is the full value — click to copy.</div>
<div class="card">
<table>
<thead><tr><th>DID</th><th>Head CID</th><th>Rev</th><th>Active</th><th>Records</th><th>Commits</th></tr></thead>
<tbody>${rows.join('') || '<tr><td colspan="6"><small class="muted">No repos yet. Ping the hub to create one.</small></td></tr>'}</tbody>
</table>
</div>`;
  return html(200, page('Repos', body));
}

async function repoDetail(pds: Pds, did: string): Promise<UiResult> {
  const dids = new Set(pds.meta.listDids());
  if (!dids.has(did)) return html(404, page('Not found', `<h1>Repo not found</h1><div class="sub">${id(did)}</div>`));
  const mgr = await pds.repoFor(did);
  const root = mgr.getRoot();
  const rev = mgr.getRev();
  const active = pds.meta.isActive(did);
  const commitsList = mgr.storage.listCommits();
  const recs = await mgr.currentRecords();

  const recRows = recs
    .map(
      (r) => `<tr>
    <td><span class="op">${esc(r.collection)}</span></td>
    <td>${id(r.rkey, 'sm')}</td>
    <td>${id(r.cid.toString(), 'sm')}</td>
    <td><a href="/repos/${encodeURIComponent(did)}/records/${encodeURIComponent(r.collection)}/${encodeURIComponent(r.rkey)}">view</a></td>
  </tr>`,
    )
    .join('');

  // Resolve the published DID doc as this PDS would serve identity.
  const docJson = JSON.stringify(
    {
      id: did,
      alsoKnownAs: [`at://${didHostname(did)}`],
      verificationMethod: [
        {
          id: `${did}#atproto`,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: pds.pdsKey.publicKeyMultibase,
        },
      ],
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds.config.selfEndpoint }],
    },
    null,
    2,
  );

  const body = `
<h1>Repo</h1>
<div class="sub">${id(did)}</div>
<div class="card">
<div class="grid">
  <div class="k">Status</div><div class="v">${active ? badge('active', 'ok') : badge('inactive', 'muted')}</div>
  <div class="k">Head CID</div><div class="v">${root ? id(root.toString()) : '—'}</div>
  <div class="k">Rev</div><div class="v">${rev ? id(rev) : '—'}</div>
  <div class="k">Commits</div><div class="v">${commitsList.length} · <a href="/repos/${encodeURIComponent(did)}/commits">commit history &rarr;</a></div>
  <div class="k">Records</div><div class="v">${recs.length}</div>
</div>
</div>

<h2>Records</h2>
<div class="card"><table>
<thead><tr><th>Collection</th><th>rkey</th><th>CID</th><th></th></tr></thead>
<tbody>${recRows || '<tr><td colspan="4"><small class="muted">no records</small></td></tr>'}</tbody>
</table></div>

<h2>Resolved DID document</h2>
<div class="card"><pre>${esc(docJson)}</pre></div>`;
  return html(200, page('Repo ' + did, body));
}

async function recordView(pds: Pds, did: string, collection: string, rkey: string): Promise<UiResult> {
  const dids = new Set(pds.meta.listDids());
  if (!dids.has(did)) return html(404, page('Not found', `<h1>Repo not found</h1>`));
  const mgr = await pds.repoFor(did);
  const root = mgr.getRoot();
  if (!root) return html(404, page('Not found', `<h1>Empty repo</h1>`));
  const repo = await Repo.load(mgr.storage.asRepoStorage(), root);
  const value = await repo.getRecord(collection, rkey);
  if (value == null) {
    return html(404, page('Not found', `<h1>Record not found</h1><div class="sub">${esc(collection)}/${esc(rkey)}</div>`));
  }
  const cid = await repo.data.get(`${collection}/${rkey}`);
  const uri = `at://${did}/${collection}/${rkey}`;
  const body = `
<h1>Record</h1>
<div class="sub"><a href="/repos/${encodeURIComponent(did)}">&larr; ${esc(did)}</a></div>
<div class="card">
<div class="grid">
  <div class="k">at:// URI</div><div class="v">${id(uri)}</div>
  <div class="k">CID</div><div class="v">${cid ? id(cid.toString()) : '—'}</div>
  <div class="k">Collection</div><div class="v"><span class="op">${esc(collection)}</span></div>
  <div class="k">rkey</div><div class="v">${id(rkey, 'sm')}</div>
</div>
</div>
<h2>Value</h2>
<div class="card"><pre>${esc(JSON.stringify(value, null, 2))}</pre></div>`;
  return html(200, page('Record', body));
}

async function commits(pds: Pds, did: string): Promise<UiResult> {
  const dids = new Set(pds.meta.listDids());
  if (!dids.has(did)) return html(404, page('Not found', `<h1>Repo not found</h1>`));
  const mgr = await pds.repoFor(did);
  const list = mgr.storage.listCommits().reverse(); // newest first
  const signingKey = pds.pdsKey.didKey;

  const rows: string[] = [];
  for (const c of list) {
    // Verify the signature server-side against the published key.
    let sigOk = false;
    try {
      const commitObj = def.commit.schema.parse(cborToLex(c.bytes)) as unknown as Commit;
      sigOk = await verifyCommitSig(commitObj, signingKey);
    } catch {
      sigOk = false;
    }
    rows.push(`<tr>
      <td>${id(c.rev, 'sm')}</td>
      <td>${id(c.cid.toString(), 'sm')}</td>
      <td>${c.since ? id(c.since, 'sm') : '<small class="muted">null (first)</small>'}</td>
      <td>${sigOk ? badge('sig valid', 'ok') : badge('sig INVALID', 'bad')}</td>
    </tr>`);
  }

  const body = `
<h1>Commit history</h1>
<div class="sub"><a href="/repos/${encodeURIComponent(did)}">&larr; ${esc(did)}</a> · newest first · signature verified server-side against ${id(signingKey, 'sm')}</div>
<div class="card"><table>
<thead><tr><th>Rev</th><th>Commit CID</th><th>Since (prev rev)</th><th>Signature</th></tr></thead>
<tbody>${rows.join('') || '<tr><td colspan="4"><small class="muted">no commits</small></td></tr>'}</tbody>
</table></div>`;
  return html(200, page('Commits', body));
}

function ingestLog(pds: Pds): UiResult {
  const entries = pds.recentIngests();
  const rejected = entries.filter((e) => e.status === 'rejected').length;
  const rows = entries
    .map((e) => {
      const st =
        e.status === 'committed'
          ? badge('committed', 'ok')
          : e.status === 'rejected'
            ? badge('rejected', 'bad')
            : badge(e.status, 'muted');
      return `<tr>
      <td><small class="muted">${esc(e.at)}</small></td>
      <td>${st}</td>
      <td>${e.code ? `<span class="op">${esc(e.code)}</span>` : ''}</td>
      <td>${id(e.did, 'sm')}</td>
      <td>${e.rev ? id(e.rev, 'sm') : ''}${e.ops != null ? ` <small class="muted">${e.ops} ops</small>` : ''}${e.message ? `<div><small class="muted">${esc(e.message)}</small></div>` : ''}</td>
    </tr>`;
    })
    .join('');
  const body = `
<h1>Ingest log</h1>
<div class="sub">Most recent ${entries.length} ingest attempts, newest first. Rejections show the code + reason — this is where the binding / SSRF / feed-abuse defenses show up.</div>
<div class="card">
  <div class="stat"><div class="n">${entries.length}</div><div class="l">Recent attempts</div></div>
  <div class="stat"><div class="n" style="color:${rejected > 0 ? 'var(--bad)' : 'var(--fg)'}">${rejected}</div><div class="l">Rejected</div></div>
</div>
<div class="card"><table>
<thead><tr><th>Time</th><th>Status</th><th>Code</th><th>DID</th><th>Detail</th></tr></thead>
<tbody>${rows || '<tr><td colspan="5"><small class="muted">No ingests yet. Ping the hub.</small></td></tr>'}</tbody>
</table></div>`;
  return html(200, page('Ingest log', body));
}

function firehosePage(): string {
  const body = `
<h1>Live firehose</h1>
<div class="sub">Streaming <span class="op">com.atproto.sync.subscribeRepos</span> over a WebSocket from cursor 0. Newest at top. Identifiers are full values.</div>
<div class="card"><div id="status"><small class="muted">connecting…</small></div></div>
<div id="feed" class="card"></div>
<script>
(function(){
  var feed=document.getElementById('feed'), status=document.getElementById('status');
  var proto=location.protocol==='https:'?'wss:':'ws:';
  var ws=new WebSocket(proto+'//'+location.host+'/xrpc/com.atproto.sync.subscribeRepos?cursor=0');
  ws.binaryType='arraybuffer';
  var n=0;
  ws.onopen=function(){status.innerHTML='<span class="badge ok">connected</span>';};
  ws.onclose=function(){status.innerHTML='<span class="badge muted-badge">disconnected</span>';};
  ws.onerror=function(){status.innerHTML='<span class="badge bad">error</span>';};
  ws.onmessage=function(ev){
    n++;
    // We can't CBOR-decode in the browser without a lib; show frame size + a
    // fetch of the decoded latest commit from /health is overkill. Instead
    // render the raw byte length and sequence marker, plus a note. The decoded
    // detail lives in /ingest-log and /repos.
    var bytes=new Uint8Array(ev.data);
    var div=document.createElement('div');
    div.className='evt';
    div.innerHTML='<div class="t">frame #'+n+' <small class="muted">'+bytes.length+' bytes</small></div>'+
      '<small class="muted">binary DAG-CBOR firehose frame — decode with any atproto consumer. See /repos and /ingest-log for decoded state.</small>';
    feed.insertBefore(div, feed.firstChild);
    while(feed.childNodes.length>200) feed.removeChild(feed.lastChild);
  };
})();
</script>`;
  return page('Firehose', body);
}

async function docPage(file: string, title: string): Promise<UiResult> {
  const fs = await import('node:fs/promises');
  // Runs from src/server/ (tests) or dist/src/server/ (built), so try both depths.
  let text = `${file} not found.`;
  for (const up of ['../../', '../../../']) {
    try {
      text = await fs.readFile(new URL(up + file, import.meta.url), 'utf8');
      break;
    } catch {
      /* try the next depth */
    }
  }
  const body = `<h1>${esc(title)}</h1><div class="sub">${esc(file)} — rendered verbatim</div><div class="card"><pre>${esc(text)}</pre></div>`;
  return html(200, page(title, body));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function didHostname(did: string): string {
  return decodeURIComponent(did.slice('did:web:'.length));
}
