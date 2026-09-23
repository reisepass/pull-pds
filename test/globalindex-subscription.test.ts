import { it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { GlobalIndexer } from '../src/globalindex/indexer.js';
import { GlobalStore } from '../src/globalindex/store.js';
import { DEFAULT_RESOLVER_CONFIG } from '../src/config.js';

const sockets = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('ws', () => ({ WebSocket: class extends EventEmitter {
  constructor(url: string) { super(); sockets.urls.push(url); }
  close() {}
} }));

it('subscribes with repeated collection parameters and preserves the resume cursor', () => {
  const store = new GlobalStore();
  store.setCursor('jetstream.example.com', 12345);
  const indexer = new GlobalIndexer(store, {
    jetstreamHost: 'jetstream.example.com', targetCollection: ['org.peertelemetry.errorMetrics', 'org.peertelemetry.usageMetrics'],
    reconcilePdsHosts: [], resolverConfig: DEFAULT_RESOLVER_CONFIG, reconcileIntervalMs: 0,
  });
  try {
    indexer.start();
    const url = new URL(sockets.urls[0]!);
    expect(url.searchParams.getAll('wantedCollections')).toEqual(['org.peertelemetry.errorMetrics', 'org.peertelemetry.usageMetrics']);
    expect(url.searchParams.get('cursor')).toBe('12345');
  } finally { indexer.stop(); store.close(); }
});
