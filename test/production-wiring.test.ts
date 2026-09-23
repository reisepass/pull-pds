import { readCarWithRoot, verifyRepo } from '@atproto/repo';
import { createServer } from '../src/server/http.js';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Pds } from '../src/pds-websub/app.js';
import { pdsConfigFromEnv } from '../src/pds-websub/config.js';
import { guardedFetch } from '../src/net/guarded-fetch.js';
import { loadSharedPdsKey } from '../src/repo/signing-key.js';
import { log } from '../src/log.js';

// Replace only network I/O. The validator, admission gate, signer and storage
// are the exact dependencies installed by the production factory.
vi.mock('../src/net/guarded-fetch.js', async (original) => ({
  ...await original<typeof import('../src/net/guarded-fetch.js')>(),
  guardedFetch: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

describe('production dependency wiring', () => {
  it('rejects a whole snapshot with an invalid record before signing anything', async () => {
    const pds = await Pds.create(pdsConfigFromEnv({}, {}));
    const did = 'did:web:publisher.example.com';
    const collection = 'com.example.sensor.reading';
    const valid = {
      $type: collection, sensorId: 'station-7', metric: 'co2', value: 412, unit: 'ppm',
      observedAt: '2026-09-22T00:00:00Z',
    };
    let invalid = true;
    vi.mocked(guardedFetch).mockImplementation(async (url) => ({
      status: 200, headers: new Map(), url, peerAddress: '93.184.216.34',
      body: new TextEncoder().encode(JSON.stringify(url.endsWith('did.json') ? {
        id: did, alsoKnownAs: ['at://publisher.example.com'],
        verificationMethod: [{ id: `${did}#atproto`, type: 'Multikey', controller: did, publicKeyMultibase: pds.pdsKey.publicKeyMultibase }],
        service: [{ id: `${did}#atproto_pds`, type: 'AtprotoPersonalDataServer', serviceEndpoint: pds.config.selfEndpoint }],
      } : {
        $type: 'app.pullpds.feed', did, records: [
          { collection, rkey: 'good', record: valid },
          ...(invalid ? [{ collection, rkey: 'bad', record: { ...valid, homeIp: 'private data' } }] : []),
        ],
      })),
    }));
    try {
      const before = pds.sequencer.currentSeq();
      expect(await pds.ingest('https://publisher.example.com/atproto/feed.json')).toMatchObject({ status: 'rejected', code: 'lexicon-invalid' });
      expect(pds.sequencer.currentSeq()).toBe(before);
      expect(pds.totalCommits()).toBe(0);
      invalid = false;
      expect(await pds.ingest('https://publisher.example.com/atproto/feed.json')).toMatchObject({ status: 'committed', ops: 1 });
      const server = createServer(pds);
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const port = (server.address() as AddressInfo).port;
        const response = await fetch(`http://127.0.0.1:${port}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`);
        expect(response.status).toBe(200);
        const { root, blocks } = await readCarWithRoot(new Uint8Array(await response.arrayBuffer()));
        const verified = await verifyRepo(blocks, root, did, pds.pdsKey.didKey);
        expect(verified.creates).toHaveLength(1);
        expect(verified.creates[0]?.rkey).toBe('good');
      } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
    } finally { pds.meta.close(); }
  });

  it('logs only public identifiers when generating an ephemeral key', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const key = await loadSharedPdsKey({});
    const metadata = warn.mock.calls[0]?.[1];
    expect(metadata).toEqual({ didKey: key.didKey, publicKeyMultibase: key.publicKeyMultibase });
  });

  it.each([
    { KEY_MODE: 'per-publisher' }, { INGEST_MODE: 'oplog' },
    { DID_DOC_TTL_SEC: '300' }, { PDS_CRAWLERS: 'relay.example.com' },
    { MAX_FEED_BYTES: 'abc' }, { MAX_RECORDS_PER_REPO: '-1' }, { FETCH_TIMEOUT_MS: 'Infinity' },
  ])('refuses unsupported options: %j', (env) => {
    expect(() => pdsConfigFromEnv({}, env)).toThrow();
  });
});
