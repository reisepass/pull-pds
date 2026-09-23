import http from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Pds } from '../pds-websub/app.js';
import { WebSubHub, type HubDeps } from '../websub/hub.js';
import { guardedFetch } from '../net/guarded-fetch.js';
import { encodeErrorFrame } from '../firehose/frames.js';
import * as xrpc from './xrpc.js';
import type { XrpcResult } from './xrpc.js';
import { renderUi } from './ui.js';
import { log } from '../log.js';

/**
 * The public HTTP + WebSocket surface. Routes:
 *   - GET  /.well-known/atproto-pull-pds              (descriptor, spec §2.3)
 *   - GET  /.well-known/atproto-pull-aggregator      (deprecated alias of ^)
 *   - POST /websub                                    (WebSub hub, spec §4)
 *   - GET  /xrpc/com.atproto.sync.*                   (read + sync, spec §6.2)
 *   - GET  /xrpc/com.atproto.repo.*                   (unauthenticated reads)
 *   - GET  /xrpc/com.atproto.server.describeServer
 *   - GET  /xrpc/com.atproto.sync.subscribeRepos      (WebSocket firehose)
 *   - anything in §6.3                                -> 501
 *
 * No account/session/OAuth/write endpoints exist (their absence is the feature).
 */
export function createServer(pds: Pds): http.Server {
  const hub = buildHub(pds);
  const server = http.createServer((req, res) => {
    handle(pds, hub, req, res).catch((err) => {
      log.error('request handler crashed', { err: (err as Error).message });
      sendJson(res, 500, { error: 'InternalServerError' });
    });
  });

  // WebSocket firehose on com.atproto.sync.subscribeRepos.
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/xrpc/com.atproto.sync.subscribeRepos') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleFirehose(pds, ws, url).catch((err) => {
        log.error('firehose stream crashed', { err: (err as Error).message });
        try {
          ws.send(encodeErrorFrame('InternalError', (err as Error).message));
        } catch {
          /* socket may be gone */
        }
        ws.close();
      });
    });
  });

  return server;
}

function buildHub(pds: Pds): WebSubHub {
  const deps: HubDeps = {
    verifyIntent: async (callback, p) => {
      // GET the callback with hub.* params; the subscriber must echo hub.challenge.
      const u = new URL(callback);
      u.searchParams.set('hub.mode', p.mode);
      u.searchParams.set('hub.topic', p.topic);
      u.searchParams.set('hub.challenge', p.challenge);
      u.searchParams.set('hub.lease_seconds', String(p.leaseSeconds));
      try {
        const r = await guardedFetch(u.toString(), { timeoutMs: 5_000, maxBytes: 64 * 1024, maxRedirects: 0 });
        const body = new TextDecoder().decode(r.body).trim();
        return r.status === 200 && body === p.challenge;
      } catch (err) {
        log.warn('intent verification failed', { callback, err: (err as Error).message });
        return false;
      }
    },
    triggerIngest: async (topicUrl) => {
      const outcome = await pds.ingest(topicUrl);
      // After a committed ingest, fan the fetched feed out to any raw WebSub
      // subscribers of this topic (spec §4.4). Distribution is best-effort and
      // must never affect the ingest result.
      if (outcome.status === 'committed' && outcome.feedBytes) {
        hub.distribute(topicUrl, outcome.feedBytes).catch((err) => {
          log.error('websub distribute failed', { topicUrl, err: (err as Error).message });
        });
      }
    },
    distribute: async (sub, body, headers) => {
      // POST the content to the (already intent-verified) subscriber callback,
      // through the SSRF-guarded transport so a callback that later resolves to
      // a private address cannot be used to reach internal services.
      await guardedFetch(sub.callback, {
        method: 'POST',
        body,
        headers,
        timeoutMs: 5_000,
        maxBytes: 4 * 1024,
        maxRedirects: 0,
      });
    },
    now: () => Date.now(),
  };
  const hub = new WebSubHub(deps, pds.config.minPingIntervalSec, pds.meta, `${pds.config.selfEndpoint}/websub`);
  return hub;
}

async function handle(
  pds: Pds,
  hub: WebSubHub,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const q = url.searchParams;

  // --- descriptor (spec §2.3) ---
  // `atproto-pull-pds` is canonical; `atproto-pull-aggregator` is the legacy
  // pre-rename path, still served IDENTICALLY as a deprecated alias so
  // publishers already pointing at it keep working (SPEC-COMPLIANCE-TASK §1).
  if (
    (path === '/.well-known/atproto-pull-pds' || path === '/.well-known/atproto-pull-aggregator') &&
    req.method === 'GET'
  ) {
    return sendJson(res, 200, descriptor(pds));
  }

  // --- the PDS's own did.json (so it is itself a resolvable did:web) ---
  if (path === '/.well-known/did.json' && req.method === 'GET') {
    return sendJson(res, 200, pdsDidDoc(pds));
  }

  // --- WebSub hub ---
  if (path === '/websub' && req.method === 'POST') {
    let body: Buffer;
    try {
      body = await readBody(req, 64 * 1024);
    } catch (err) {
      // Oversized or malformed request body: a clean 413, not a crashed socket.
      if ((err as Error).message === 'body too large') {
        // The unread remainder of the oversized body is still queued on the
        // socket, so this connection cannot be reused: a keep-alive client would
        // parse those leftover bytes as its next request line and see an
        // ECONNRESET. Answer 413 and close, rather than destroying the socket
        // mid-request (which makes a reverse proxy report 502).
        res.setHeader('connection', 'close');
        return sendText(res, 413, 'request body too large');
      }
      return sendText(res, 400, 'bad request body');
    }
    const params = new URLSearchParams(body.toString('utf8'));
    const mode = params.get('hub.mode');
    if (mode === 'publish') {
      const r = await hub.publish(params);
      if (!r.accepted) return sendText(res, 400, r.reason ?? 'bad publish');
      return sendText(res, 202, 'accepted');
    }
    if (mode === 'subscribe' || mode === 'unsubscribe' || mode === 'denied') {
      // A2: subscribe/unsubscribe/denied all validate synchronously and answer
      // 202 immediately; intent verification happens asynchronously in the hub.
      // A3: hub.mode=denied drops any stored lease for (callback, topic).
      const r = mode === 'subscribe' ? await hub.subscribe(params) : mode === 'unsubscribe' ? await hub.unsubscribe(params) : await hub.denied(params);
      if (r.status === 'accepted') return sendText(res, 202, 'accepted');
      return sendText(res, 400, r.message);
    }
    return sendText(res, 400, 'unknown hub.mode');
  }

  // --- XRPC ---
  if (path.startsWith('/xrpc/') && req.method === 'GET') {
    const nsid = path.slice('/xrpc/'.length);
    const result = await routeXrpc(pds, nsid, q);
    return sendXrpc(res, result);
  }

  // §6.3: writes/account/session/oauth via POST -> 501.
  if (path.startsWith('/xrpc/') && req.method === 'POST') {
    const nsid = path.slice('/xrpc/'.length);
    return sendXrpc(res, xrpc.notImplemented(nsid));
  }
  if (path.startsWith('/oauth') || path.startsWith('/.well-known/oauth')) {
    return sendXrpc(res, xrpc.notImplemented(path));
  }

  // --- Web UI (server-rendered HTML) ---
  if (req.method === 'GET') {
    const ui = await renderUi(pds, path);
    if (ui) {
      if (ui.json !== undefined) return sendJson(res, ui.status, ui.json);
      res.writeHead(ui.status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ui.html ?? '');
      return;
    }
  }

  sendJson(res, 404, { error: 'NotFound' });
}

async function routeXrpc(pds: Pds, nsid: string, q: URLSearchParams): Promise<XrpcResult> {
  const did = q.get('did') ?? '';
  const repo = q.get('repo') ?? did;

  // Validate the did/repo param syntactically before any handler touches it. A
  // malformed or absurdly long value (e.g. a 5000-char string) would otherwise
  // reach repoFor and try to open a SQLite file with an over-long name ->
  // ENAMETOOLONG -> unhandled 500 (F-9). Reject it as a clean 400 up front. Only
  // the methods that take a repo identifier are guarded.
  const needsRepo = nsid.startsWith('com.atproto.sync.') || nsid.startsWith('com.atproto.repo.');
  const usesDidParam = nsid !== 'com.atproto.sync.listRepos' && nsid !== 'com.atproto.sync.listBlobs';
  if (needsRepo && usesDidParam && repo && !isValidDidWebParam(repo)) {
    return xrpc.xrpcError(400, 'InvalidRequest', `not a valid did:web: ${repo.slice(0, 64)}`);
  }

  switch (nsid) {
    case 'com.atproto.server.describeServer':
      return xrpc.describeServer(pds);
    case 'com.atproto.sync.getRepo':
      return xrpc.getRepo(pds, did, q.get('since') ?? undefined);
    case 'com.atproto.sync.getLatestCommit':
      return xrpc.getLatestCommit(pds, did);
    case 'com.atproto.sync.getRecord':
      return xrpc.getRecord(pds, did, q.get('collection') ?? '', q.get('rkey') ?? '');
    case 'com.atproto.sync.getRepoStatus':
      return xrpc.getRepoStatus(pds, did);
    case 'com.atproto.sync.listRepos':
      return xrpc.listRepos(pds, num(q.get('limit'), 500), q.get('cursor') ?? undefined);
    case 'com.atproto.sync.listBlobs':
      return xrpc.listBlobs();
    case 'com.atproto.sync.getBlob':
      return xrpc.getBlob();
    case 'com.atproto.repo.getRecord':
      return xrpc.repoGetRecord(pds, repo, q.get('collection') ?? '', q.get('rkey') ?? '');
    case 'com.atproto.repo.listRecords':
      return xrpc.repoListRecords(pds, repo, q.get('collection') ?? '', num(q.get('limit'), 50), q.get('cursor') ?? undefined);
    case 'com.atproto.repo.describeRepo':
      return xrpc.describeRepo(pds, repo);
    case 'com.atproto.identity.resolveHandle': {
      const handle = q.get('handle') ?? '';
      return xrpc.ok({ did: `did:web:${handle}` });
    }
    // §6.3 read-shaped stubs that must not exist as functional endpoints.
    case 'com.atproto.server.createAccount':
    case 'com.atproto.server.createSession':
    case 'com.atproto.server.getSession':
      return xrpc.notImplemented(nsid);
    default:
      return xrpc.xrpcError(404, 'MethodNotFound', `unknown XRPC method ${nsid}`);
  }
}

/**
 * Stream the firehose to a WebSocket subscriber from an optional cursor.
 *
 * REDESIGN-TASK §3 (filtered subscription): an optional
 * `?wantedCollections=nsid1,nsid2` query turns this into a collection-filtered,
 * Jetstream-style feed — the subscriber receives ONLY `#commit` frames whose
 * ops touch one of those collections. This is the cheap feed a resource-capped
 * consumer (our global indexer) subscribes to instead of the raw full
 * firehose. Omit the param for the standard unfiltered stream.
 */
async function handleFirehose(pds: Pds, ws: WebSocket, url: URL): Promise<void> {
  const cursorParam = url.searchParams.get('cursor');
  const cursor = cursorParam != null ? Number(cursorParam) : pds.sequencer.currentSeq();
  const wantedCollections = (url.searchParams.get('wantedCollections') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ac = new AbortController();
  ws.on('close', () => ac.abort());
  ws.on('error', () => ac.abort());

  log.info('firehose subscriber connected', { cursor, filtered: wantedCollections.length > 0, wantedCollections });
  const streamOpts = wantedCollections.length > 0 ? { wantedCollections } : {};
  for await (const evt of pds.sequencer.stream(Number.isFinite(cursor) ? cursor : 0, ac.signal, 500, streamOpts)) {
    if (ws.readyState !== ws.OPEN) break;
    ws.send(evt.payload);
  }
}

// --- descriptor / did.json -------------------------------------------------

function descriptor(pds: Pds): Record<string, unknown> {
  return {
    pdsDid: pds.config.pdsDid,
    // Deprecated pre-rename alias for `pdsDid`; kept so existing descriptor
    // consumers do not break. Both carry the same value (SPEC-COMPLIANCE §1).
    aggregatorDid: pds.config.pdsDid,
    signingPublicKeyMultibase: pds.pdsKey.publicKeyMultibase,
    atprotoPdsEndpoint: pds.config.selfEndpoint,
    hub: `${pds.config.selfEndpoint}/websub`,
    allowedCollections: pds.config.allowedCollections,
    feedSchema: 'app.pullpds.feed',
    ingestMode: pds.config.ingestMode,
    maxFeedBytes: pds.config.maxFeedBytes,
    minPingIntervalSec: pds.config.minPingIntervalSec,
  };
}

function pdsDidDoc(pds: Pds): Record<string, unknown> {
  const did = pds.config.pdsDid;
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: did,
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: pds.pdsKey.publicKeyMultibase,
      },
    ],
    service: [
      { id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds.config.selfEndpoint },
    ],
  };
}

// --- http helpers ----------------------------------------------------------

function num(v: string | null, dflt: number): number {
  if (v == null) return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * Cheap syntactic check that a `did`/`repo` XRPC param is a plausible did:web on
 * a bare hostname (optionally a percent-encoded localhost port). Bounds the
 * length hard so an over-long value can never reach the storage-filename path.
 * This is a param-hygiene gate, not full identity validation.
 */
function isValidDidWebParam(did: string): boolean {
  if (did.length > 260) return false;
  if (!did.startsWith('did:web:')) return false;
  const host = decodeURIComponent(did.slice('did:web:'.length)).split(':')[0] ?? '';
  // Hostname label chars only (letters, digits, dot, hyphen). No slashes,
  // no path separators, no whitespace.
  return /^[a-zA-Z0-9.-]{1,255}$/.test(host);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (c: Buffer) => {
      if (over) return;
      total += c.length;
      if (total > maxBytes) {
        // Drain (pause reading) and reject cleanly, but DON'T destroy the socket
        // - destroying mid-request makes the reverse proxy report a 502. Let the
        // handler send a 413 on the still-open response.
        over = true;
        req.pause();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(body);
}

function sendXrpc(res: http.ServerResponse, result: XrpcResult): void {
  if (result.bytes) {
    res.writeHead(result.status, { 'content-type': result.contentType ?? 'application/octet-stream' });
    res.end(Buffer.from(result.bytes));
    return;
  }
  sendJson(res, result.status, result.json ?? {});
}
