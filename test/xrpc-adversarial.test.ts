import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { Pds } from '../src/pds-websub/app.js';
import { pdsConfigFromEnv } from '../src/pds-websub/config.js';
import { createServer } from '../src/server/http.js';

/**
 * Adversarial XRPC surface sweep (ADVERSARIAL-TESTS.md "XRPC surface"): malformed,
 * missing, oversized, and garbage params against the real HTTP server, plus
 * confirming the 501 endpoints cannot be coaxed into writing. Read-only server,
 * in-memory store, localhost.
 */

const COLL = 'com.example.custom.record';
let server: http.Server;
let agg: Pds;
let port: number;

beforeAll(async () => {
  const config = pdsConfigFromEnv(
    { selfEndpoint: 'https://agg.example', allowedCollections: [COLL], dataDir: ':memory:', minPingIntervalSec: 0 },
    {} as NodeJS.ProcessEnv,
  );
  agg = await Pds.create(config);
  server = createServer(agg);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  agg.meta.close();
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  let body: any;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

async function post(path: string, init: RequestInit = {}): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', ...init });
  return r.status;
}

describe('XRPC malformed / oversized identifiers (F-9 class, pinned)', () => {
  it('a 5000-char did is a clean 400, never a 500', async () => {
    const huge = `did:web:${'a'.repeat(5000)}`;
    const r = await get(`/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(huge)}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('InvalidRequest');
  });

  it('a did with path separators is a clean 400', async () => {
    const r = await get(`/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent('did:web:../../etc/passwd')}&collection=x&rkey=y`);
    expect(r.status).toBe(400);
  });

  it('a did with an embedded NUL / control char is a clean 400', async () => {
    const r = await get(`/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent('did:web:x\0.example')}`);
    expect(r.status).toBe(400);
  });

  it('a scheme-confusion did resolves to no repo (404), never a crash or an origin fetch', async () => {
    // `did:web:http://evil.example` is read as host label `http` by the param
    // gate (the `//evil.example` is stripped as a bogus port), so it can only
    // ever hit an unknown-repo 404 on the READ path - it never triggers a fetch
    // to evil.example (only the ingest path fetches origins, and that derives
    // the host from the topic URL, not from a did param). The point is that it
    // is handled cleanly, not a 500.
    const r = await get(`/xrpc/com.atproto.sync.getLatestCommit?did=${encodeURIComponent('did:web:http://evil.example')}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('RepoNotFound');
  });

  it('a well-formed but unknown did is a clean 404, not a 500', async () => {
    const r = await get(`/xrpc/com.atproto.sync.getRepo?did=did:web:nobody.example`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('RepoNotFound');
  });
});

describe('XRPC garbage pagination / range params (pinned)', () => {
  it('listRepos tolerates a garbage cursor (no crash, empty page)', async () => {
    const r = await get('/xrpc/com.atproto.sync.listRepos?cursor=%00%01garbage%FF');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.repos)).toBe(true);
  });

  it('listRepos tolerates a negative limit', async () => {
    const r = await get('/xrpc/com.atproto.sync.listRepos?limit=-5');
    expect(r.status).toBe(200);
  });

  it('listRepos tolerates an enormous limit', async () => {
    const r = await get('/xrpc/com.atproto.sync.listRepos?limit=999999999999');
    expect(r.status).toBe(200);
  });

  it('listRepos tolerates a non-numeric limit', async () => {
    const r = await get('/xrpc/com.atproto.sync.listRepos?limit=not-a-number');
    expect(r.status).toBe(200);
  });

  it('getRepo with a since newer than head on an unknown repo is a 404, not a crash', async () => {
    const r = await get('/xrpc/com.atproto.sync.getRepo?did=did:web:nobody.example&since=zzzzzzzzzzzzz');
    expect(r.status).toBe(404);
  });

  it('an unknown XRPC method is a clean 404 MethodNotFound', async () => {
    const r = await get('/xrpc/com.atproto.does.not.exist');
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('MethodNotFound');
  });
});

describe('the deliberately-absent write/auth surface really is 501', () => {
  const absent = [
    'com.atproto.server.createAccount',
    'com.atproto.server.createSession',
    'com.atproto.server.refreshSession',
    'com.atproto.server.deleteSession',
    'com.atproto.server.createAppPassword',
    'com.atproto.repo.applyWrites',
    'com.atproto.repo.putRecord',
    'com.atproto.repo.createRecord',
    'com.atproto.repo.deleteRecord',
  ];

  it('every account/session/write method POSTs to 501 and writes nothing', async () => {
    for (const nsid of absent) {
      const status = await post(`/xrpc/${nsid}`, {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repo: 'did:web:x.example', collection: COLL, rkey: 'x', record: { $type: COLL, n: 1 } }),
      });
      expect(status, nsid).toBe(501);
    }
    // Nothing was created: the repo set is still empty.
    const list = await get('/xrpc/com.atproto.sync.listRepos');
    expect(list.body.repos).toHaveLength(0);
  });

  it('the OAuth surface is 501 (no authorization server)', async () => {
    expect(await post('/oauth/token')).toBe(501);
    const wk = await get('/.well-known/oauth-authorization-server');
    expect(wk.status).toBe(501);
  });

  it('a write method sent as GET is a 404 MethodNotFound, still no write path', async () => {
    // applyWrites is POST-only in the router; as a GET it is simply unknown.
    const r = await get('/xrpc/com.atproto.repo.applyWrites?repo=did:web:x.example');
    expect(r.status).toBe(404);
  });
});
