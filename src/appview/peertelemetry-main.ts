import { join } from 'node:path';
import http from 'node:http';
import { IndexStore } from './index-store.js';
import { Indexer } from './indexer.js';
import { renderPeerTelemetry } from './peertelemetry-views.js';
import { aggregateByProvider, ispStability, liveIncidents, metricRows } from './peertelemetry.js';
import { DEFAULT_RESOLVER_CONFIG } from '../config.js';
import { log } from '../log.js';
import { startRetentionPruner } from '../retention.js';

/**
 * The peer-telemetry AppView for the unified org.peertelemetry.errorMetrics
 * schema (ISP-SERVICETYPE.md Part 2). SAME machinery as the omniroute AppView -
 * IndexStore + Indexer, verifying every commit against each publisher's own
 * did:web key - pointed at the netreport aggregator (p4.0rs.org) and rendering
 * the cross-serviceType + ISP-quality questions. No privileged access.
 *
 * Separate entrypoint + port so this stack never disturbs the running omniroute
 * services (another worktree). One store, one set of views, both serviceTypes.
 *
 * Env: PDS_HOSTS (default "p4.0rs.org"), DATA_DIR (":memory:" ephemeral),
 *      PORT/HOST (default 3110 / 127.0.0.1).
 */
async function main(): Promise<void> {
  const hosts = (process.env.PDS_HOSTS ?? 'p4.0rs.org')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const dataDir = process.env.DATA_DIR?.trim() || ':memory:';
  const location = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'index.sqlite');
  const store = new IndexStore(location);

  const resolverConfig = { ...DEFAULT_RESOLVER_CONFIG, serviceEndpoint: 'https://appview.0rs.org', skipEndpointCheck: true };
  const indexer = new Indexer(store, { pdsHosts: hosts, resolverConfig });

  const server = http.createServer((req, res) => {
    handle(store, hosts, req, res).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'InternalServerError', message: (err as Error).message }));
    });
  });
  const port = Number(process.env.PORT ?? 3110);
  const host = process.env.HOST ?? '127.0.0.1';
  server.listen(port, host, () => log.info('peertelemetry appview listening', { host, port, hosts }));

  indexer.start().catch((err) => log.error('peertelemetry indexer start failed', { err: (err as Error).message }));
  startRetentionPruner(() => [store]);
}

async function handle(store: IndexStore, hosts: string[], req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (path === '/health') {
    return json(res, 200, {
      status: 'ok',
      pdsHosts: hosts,
      cursors: Object.fromEntries(hosts.map((h) => [h, store.getCursor(h)])),
      indexedRecords: store.recordCount(),
      distinctPublishers: store.distinctDids().length,
      commitsIndexed: store.getStat('commits_indexed'),
      commitsRejected: store.getStat('commits_rejected'),
    });
  }
  if (path === '/api/records') return json(res, 200, metricRows(store));
  if (path === '/api/aggregate') {
    const st = url.searchParams.get('serviceType')?.trim() || undefined;
    return json(res, 200, aggregateByProvider(store, st));
  }
  if (path === '/api/isp') return json(res, 200, ispStability(store));
  if (path === '/api/live') return json(res, 200, liveIncidents(store));

  if (req.method === 'GET') {
    const html = renderPeerTelemetry(store, hosts, path, url.searchParams);
    if (html) {
      res.writeHead(html.status, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html.body);
      return;
    }
  }
  json(res, 404, { error: 'NotFound' });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

main().catch((err) => {
  log.error('peertelemetry appview fatal', { err: (err as Error).message, stack: (err as Error).stack });
  process.exitCode = 1;
});
