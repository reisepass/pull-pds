import { join } from 'node:path';
import http from 'node:http';
import { IndexStore } from './index-store.js';
import { Indexer } from './indexer.js';
import { createAppViewServer } from './server.js';
import { GlobalStore } from '../globalindex/store.js';
import { GlobalIndexer } from '../globalindex/indexer.js';
import { DEFAULT_RESOLVER_CONFIG } from '../config.js';
import { ALL_TELEMETRY_COLLECTIONS } from '../collections.js';
import { log } from '../log.js';
import { startRetentionPruner } from '../retention.js';

/** Sample AppView: direct PDS indexing plus legacy Jetstream JSON notifications. */
async function main(): Promise<void> {
  if (!process.env.PDS_HOSTS?.trim()) throw new Error('Set PDS_HOSTS to the comma-separated publisher PDS hostnames to index.');
  const hosts = process.env.PDS_HOSTS
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // KILL-RAW-FIREHOSE.md: Jetstream is the filtered notification channel; the
  // publisher PDSes (PDS_HOSTS) are both the getRecord fetch source and the
  // reconciliation-sweep targets.
  const jetstreamHost = (process.env.JETSTREAM_HOST ?? 'jetstream1.us-east.bsky.network').trim();
  const reconcileIntervalMs = Number(process.env.RECONCILE_MS ?? 5 * 60_000);
  const dataDir = process.env.DATA_DIR?.trim() || ':memory:';
  const location = dataDir === ':memory:' ? ':memory:' : join(dataDir, 'index.sqlite');
  const store = new IndexStore(location);

  // The AppView resolves each publisher's did:web doc itself only to read the
  // #atproto key; it is not a PDS, so it skips the serviceEndpoint-equality
  // binding check (a real PDS must not). Same config serves both pipelines.
  const resolverConfig = { ...DEFAULT_RESOLVER_CONFIG, serviceEndpoint: 'https://appview.0rs.org', skipEndpointCheck: true };

  const indexer = new Indexer(store, { pdsHosts: hosts, resolverConfig });

  const globalDataDir = process.env.GLOBAL_DATA_DIR?.trim() || dataDir;
  const globalLocation = globalDataDir === ':memory:' ? ':memory:' : join(globalDataDir, 'global-firehose.sqlite');
  const globalStore = new GlobalStore(globalLocation);
  const globalIndexer = new GlobalIndexer(globalStore, {
    jetstreamHost,
    // Index both signals: error-metrics (+ legacy dual-read) and usage-metrics.
    // wantedCollections still filters per type, so a publisher opting into only
    // one signal is unaffected.
    targetCollection: ALL_TELEMETRY_COLLECTIONS,
    reconcilePdsHosts: hosts,
    resolverConfig,
    reconcileIntervalMs,
  });

  const server: http.Server = createAppViewServer(store, indexer, hosts, { store: globalStore, indexer: globalIndexer });
  const port = Number(process.env.PORT ?? 3100);
  const host = process.env.HOST ?? '127.0.0.1';
  server.listen(port, host, () => log.info('appview+globalindex listening', { host, port, hosts, jetstreamHost }));

  // Kick off both indexers in the background; the UI works (empty) meanwhile.
  indexer.start().catch((err) => log.error('indexer start failed', { err: (err as Error).message }));
  globalIndexer.start();

  // REDESIGN-TASK §2: periodic retention pruning (6 months / 0.5 GB, whichever
  // first) on BOTH index stores. Periodic, batched, logged; never per-write.
  startRetentionPruner(() => [store, globalStore]);
}

main().catch((err) => {
  log.error('appview fatal', { err: (err as Error).message, stack: (err as Error).stack });
  process.exitCode = 1;
});
