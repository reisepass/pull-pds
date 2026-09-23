import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { cborDecodeAll } from '@atproto/lex-cbor';
import { readCarWithRoot, verifyRepo } from '@atproto/repo';
import { Pds } from '../src/pds-websub/app.js';
import { pdsConfigFromEnv } from '../src/pds-websub/config.js';
import { createServer } from '../src/server/http.js';

/**
 * End-to-end over real sockets (localhost): a publisher origin server + the
 * PDS server. We drive the WebSub publish flow, then read the repo back
 * over XRPC and consume the firehose over a real WebSocket. ALLOW_LOCALHOST lets
 * the SSRF guard dial loopback for this test only.
 */

import { ERROR_METRICS_NSID } from '../src/collections.js';

// Exercise the CURRENT OTel-shaped NSID end to end through the lexicon-validated
// ingest path. Legacy-shape validation is covered separately in ingest.test.ts.
const COLL = ERROR_METRICS_NSID;

let originServer: http.Server;
let originPort: number;
let aggServer: http.Server;
let aggPort: number;
let pds: Pds;
let feedBody: string;
let DID: string;
let SELF: string;

function decodeFrame(payload: Uint8Array): { t?: string; body: any } {
  const [header, body] = [...cborDecodeAll(payload)] as any[];
  return { t: header.t, body };
}

beforeAll(async () => {
  process.env.ALLOW_LOCALHOST = '1';

  // 1. Pds (ephemeral key generated at boot).
  aggServer = http.createServer();
  // First bind the PDS to learn its port, so SELF_ENDPOINT is correct.
  await new Promise<void>((r) => aggServer.listen(0, '127.0.0.1', r));
  aggPort = (aggServer.address() as AddressInfo).port;
  SELF = `https://127.0.0.1:${aggPort}`; // https in the doc; we serve over http locally
  aggServer.close();

  // Rebuild via createServer with a config whose SELF_ENDPOINT matches how the
  // did.json will advertise it. We use the http origin's own host as the DID.
  const config = pdsConfigFromEnv(
    { selfEndpoint: SELF, allowedCollections: [COLL], dataDir: ':memory:', minPingIntervalSec: 0 },
    {} as NodeJS.ProcessEnv,
  );
  pds = await Pds.create(config);
  aggServer = createServer(pds);
  await new Promise<void>((r) => aggServer.listen(aggPort, '127.0.0.1', r));

  // 2. Publisher origin: serves did.json + feed.json. Its did:web host is
  //    127.0.0.1:<port> (localhost port allowed in test mode).
  originServer = http.createServer((req, res) => {
    if (req.url === '/.well-known/did.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: DID,
          alsoKnownAs: [`at://localhost`],
          verificationMethod: [
            { id: `${DID}#atproto`, type: 'Multikey', controller: DID, publicKeyMultibase: pds.pdsKey.publicKeyMultibase },
          ],
          service: [{ id: `${DID}#atproto_pds`, type: 'AtprotoPersonalDataServer', serviceEndpoint: SELF }],
        }),
      );
      return;
    }
    if (req.url === '/atproto/feed.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(feedBody);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => originServer.listen(0, '127.0.0.1', r));
  originPort = (originServer.address() as AddressInfo).port;
  DID = `did:web:localhost%3A${originPort}`;
  feedBody = JSON.stringify({
    $type: 'app.pullpds.feed',
    did: DID,
    records: [
      {
        collection: COLL,
        rkey: 'current',
        // Settled canonical shape (REDESIGN-TASK §1); validates against the
        // committed lexicon so this exercises the SPEC-COMPLIANCE §4 path.
        record: {
          $type: COLL,
          serviceType: 'llm',
          'gen_ai.provider.name': 'openai',
          'gen_ai.request.model': 'gpt-4o',
          windowStartUnixMicro: 1785000000000000,
          windowEndUnixMicro: 1785000300000000,
          errors: [{ code: '429', count: 5 }],
          totalErrors: 5,
          requestVolumeBucket: '1K-9.9K',
          'telemetry.distro.name': 'omniroute',
          'telemetry.distro.version': '1.0.0',
          observedAt: '2026-07-21T00:00:00.000Z',
          seq: 1,
          emittedAt: '2026-07-21T00:00:00.000Z',
        },
      },
    ],
  });
}, 20_000);

afterAll(async () => {
  await new Promise<void>((r) => aggServer.close(() => r()));
  await new Promise<void>((r) => originServer.close(() => r()));
  pds.meta.close();
  delete process.env.ALLOW_LOCALHOST;
});

const topicUrl = () => `https://localhost:${originPort}/atproto/feed.json`;

// The PDS's resolver + feed fetch use guardedFetch over https, but the
// origin serves http. So for this integration test we ingest by calling the
// PDS's ingest() with a transport that hits the local http origin. That
// still exercises the whole pipeline, server routing, XRPC, and firehose.
// (The real-TLS variant runs in experiments/ against p2.0rs.org.)
import { guardedFetch as _gf } from '../src/net/guarded-fetch.js';

describe('server integration (localhost, http origin)', () => {
  it('descriptor endpoint publishes the pds key + hub (canonical path)', async () => {
    const r = await fetch(`http://127.0.0.1:${aggPort}/.well-known/atproto-pull-pds`);
    const body = await r.json();
    expect(body.signingPublicKeyMultibase).toBe(pds.pdsKey.publicKeyMultibase);
    expect(body.allowedCollections).toContain(COLL);
    expect(body.hub).toBe(`${SELF}/websub`);
    // Canonical `pdsDid`, with the deprecated `aggregatorDid` alias echoing it.
    expect(body.pdsDid).toBe(pds.config.pdsDid);
    expect(body.aggregatorDid).toBe(body.pdsDid);
  });

  it('legacy descriptor path still serves an identical body (back-compat alias)', async () => {
    const [neu, old] = await Promise.all([
      fetch(`http://127.0.0.1:${aggPort}/.well-known/atproto-pull-pds`).then((r) => r.json()),
      fetch(`http://127.0.0.1:${aggPort}/.well-known/atproto-pull-aggregator`).then((r) => r.json()),
    ]);
    expect(old).toEqual(neu);
  });

  it('describeServer does not advertise account creation', async () => {
    const r = await fetch(`http://127.0.0.1:${aggPort}/xrpc/com.atproto.server.describeServer`);
    const body = await r.json();
    expect(body.did).toBe(pds.config.pdsDid);
    expect(body.inviteCodeRequired).toBe(false);
    expect('availableUserDomains' in body).toBe(true);
    expect(body.availableUserDomains).toEqual([]);
  });

  it('a malformed/oversized did param is a clean 400, not a 500 (F-9)', async () => {
    const hugeDid = `did:web:${'a'.repeat(5000)}`;
    const r = await fetch(`http://127.0.0.1:${aggPort}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(hugeDid)}`);
    expect(r.status).toBe(400);
    const body = await r.json();
    expect(body.error).toBe('InvalidRequest');
  });

  it('a did with path separators is rejected as 400 (F-9)', async () => {
    const bad = 'did:web:../../etc/passwd';
    const r = await fetch(`http://127.0.0.1:${aggPort}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(bad)}&collection=x&rkey=y`);
    expect(r.status).toBe(400);
  });

  it('an oversized websub body is a clean 413, not a dropped connection (F-9)', async () => {
    const big = 'x'.repeat(200_000);
    const r = await fetch(`http://127.0.0.1:${aggPort}/websub`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: big,
    });
    expect(r.status).toBe(413);
  });

  it('createAccount and applyWrites return 501', async () => {
    const r1 = await fetch(`http://127.0.0.1:${aggPort}/xrpc/com.atproto.server.createAccount`, { method: 'POST' });
    expect(r1.status).toBe(501);
    const r2 = await fetch(`http://127.0.0.1:${aggPort}/xrpc/com.atproto.repo.applyWrites`, { method: 'POST' });
    expect(r2.status).toBe(501);
  });

  it('ingest -> getRepo -> verifyRepo, and firehose delivers the #commit', async () => {
    // Connect the firehose FIRST so we catch the commit live.
    const ws = new WebSocket(`ws://127.0.0.1:${aggPort}/xrpc/com.atproto.sync.subscribeRepos?cursor=0`);
    const frames: Array<{ t?: string; body: any }> = [];
    const gotCommit = new Promise<void>((resolve) => {
      ws.on('message', (data: Buffer) => {
        const f = decodeFrame(new Uint8Array(data));
        frames.push(f);
        if (f.t === '#commit') resolve();
      });
    });
    await new Promise<void>((r) => ws.on('open', () => r()));

    // Drive an ingest directly (http origin; injected transport hits it).
    const httpTransport = async (url: string) => {
      const u = new URL(url);
      const res = await fetch(`http://127.0.0.1:${u.port}${u.pathname}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const headers = new Map<string, string>();
      res.headers.forEach((v, k) => headers.set(k, v));
      return { status: res.status, headers, body: buf, url, peerAddress: '127.0.0.1' };
    };
    // Run one ingest over the local http transport (the real-TLS variant runs
    // in experiments/ against p2.0rs.org).
    const outcome = await ingestViaHttp(pds, topicUrl(), httpTransport);
    expect(outcome?.status).toBe('committed');

    // getRepo -> CAR -> verifyRepo against the pds key.
    const repoRes = await fetch(
      `http://127.0.0.1:${aggPort}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(DID)}`,
    );
    expect(repoRes.status).toBe(200);
    const car = new Uint8Array(await repoRes.arrayBuffer());
    const { root, blocks } = await readCarWithRoot(car);
    const verified = await verifyRepo(blocks, root, DID, pds.pdsKey.didKey);
    expect(verified.creates.length).toBe(1);

    await gotCommit;
    ws.close();
    expect(frames.some((f) => f.t === '#commit')).toBe(true);
    expect(frames.some((f) => f.t === '#sync')).toBe(true);
  }, 20_000);
});

/**
 * Build a one-off pipeline over an http transport and run a single ingest,
 * reusing the PDS's repo cache, firehose, key, and stores so the commit
 * lands in the same PDS the server reads from.
 */
async function ingestViaHttp(
  pds: Pds,
  topic: string,
  transport: (url: string, opts: any) => Promise<any>,
) {
  const { IngestPipeline } = await import('../src/pds-websub/ingest.js');
  const { buildRecordValidator } = await import('../src/pds-websub/lexicon-validate.js');
  const pipeline = new IngestPipeline(pds.config, pds.resolverConfig, {
    resolverDeps: { resolver: async () => ['127.0.0.1'], transport },
    feedTransport: transport,
    repoFor: (did) => pds.repoFor(did),
    firehose: pds.firehose,
    pdsKey: pds.pdsKey,
    etagStore: pds.meta,
    seenStore: pds.meta,
    validateRecord: buildRecordValidator(),
    nowIso: () => new Date().toISOString(),
  });
  return pipeline.ingest(topic);
}
