import { describe, it, expect } from 'vitest';
import { readCarWithRoot, def, signCommit, verifyCommitSig, cborToLex, cidForRecord, blocksToCarFile } from '@atproto/repo';
import type { Commit } from '@atproto/repo';
import { cborEncode } from '@atproto/lex-cbor';
import { SqliteRepoStorage } from '../src/storage/sqlite-repo-store.js';
import { RepoManager } from '../src/repo/repo-manager.js';
import { LocalKeyCommitSigner } from '../src/repo/commit-signer.js';
import { GlobalIndexer } from '../src/globalindex/indexer.js';
import { GlobalStore } from '../src/globalindex/store.js';
import { makeDidDoc, newKeypair, TEST_ENDPOINT } from './helpers.js';
import type { ResolverConfig } from '../src/config.js';
import type { ResolverDeps, GuardedTransport } from '../src/identity/didweb.js';
import type { GuardedResponse } from '../src/net/guarded-fetch.js';

const DID = 'did:web:node.test.example';
const COLL = 'app.omniroute.errorReport';
const RKEY = 'current';
const NOW = '2026-07-25T12:00:00Z';
// TEST_ENDPOINT is https://pds.test.example, so the publisher's did:web doc
// advertises that as its #atproto_pds. The indexer fetches getRecord from that
// host; the httpGet hook below intercepts it. This is the host the resolver
// hands back in pdsEndpoint.
const PDS_HOST = 'pds.test.example';

const resolverConfig: ResolverConfig = {
  serviceEndpoint: TEST_ENDPOINT,
  fetchTimeoutMs: 1000,
  maxDocumentBytes: 64 * 1024,
  allowLocalhost: false,
  skipEndpointCheck: true,
};

/** A resolver that serves `doc` as the did.json for every did:web lookup. */
function depsReturningDoc(doc: unknown): ResolverDeps {
  const transport: GuardedTransport = async (url) =>
    ({
      status: 200,
      headers: new Map<string, string>(),
      body: new TextEncoder().encode(JSON.stringify(doc)),
      url,
      peerAddress: '93.184.216.34',
    }) satisfies GuardedResponse;
  return { resolver: async () => ['93.184.216.34'], transport };
}

const okHttp = (status: number, bytes: Uint8Array) => ({
  status,
  bytes,
  text: () => Buffer.from(bytes).toString('utf8'),
});
const jsonHttp = (status: number, obj: unknown) => okHttp(status, new TextEncoder().encode(JSON.stringify(obj)));

/**
 * Produce a REAL `com.atproto.sync.getRecord` covering-proof CAR for `record`,
 * exactly what the publisher's own PDS serves and what verifyRecords consumes.
 * Returns the keypair (for the did doc), the CAR bytes, and the commit CID.
 */
async function realGetRecordCar(record: Record<string, unknown>) {
  const kp = await newKeypair();
  const storage = new SqliteRepoStorage(DID);
  const mgr = new RepoManager(storage, new LocalKeyCommitSigner(kp));
  const diff = await mgr.diffAgainstFeed([{ collection: COLL, rkey: RKEY, record }]);
  const result = await mgr.commitWrites(diff.writes);
  const car = await mgr.recordProofCar(COLL, RKEY);
  if (!car) throw new Error('no proof CAR produced');
  return { kp, car, commitCid: result.commit.cid };
}

/** Build a Jetstream commit notification (unsigned decoded JSON, as Jetstream sends). */
function jetstreamNotify(record: Record<string, unknown>, opts: { operation?: string; rkey?: string; timeUs?: number } = {}): string {
  return JSON.stringify({
    did: DID,
    time_us: opts.timeUs ?? 1_785_000_000_000_000,
    kind: 'commit',
    commit: {
      rev: '3mrkziaf6cs2c',
      operation: opts.operation ?? 'create',
      collection: COLL,
      rkey: opts.rkey ?? RKEY,
      record,
      cid: 'bafyreialdmz7pmpj2dtrw2wam7tesai63jqbrbkonmz6sabml5ixfg4mli',
    },
  });
}

type HttpGet = (url: string) => Promise<{ status: number; bytes: Uint8Array; text: () => string }>;

function makeIndexer(
  store: GlobalStore,
  deps: ResolverDeps,
  httpGet: HttpGet,
  extra: Partial<{ reconcilePdsHosts: string[]; retryBaseMs: number }> = {},
) {
  return new GlobalIndexer(store, {
    jetstreamHost: 'jetstream.test',
    targetCollection: COLL,
    reconcilePdsHosts: [],
    resolverConfig,
    resolverDeps: deps,
    httpGet,
    reconcileIntervalMs: 0,
    ...extra,
  });
}

describe('GlobalIndexer: Jetstream notify + getRecord verify', () => {
  it('refuses a publisher-advertised PDS on a private network', async () => {
    const kp = await newKeypair();
    const doc = await makeDidDoc(DID, kp, { endpoint: 'https://127.0.0.1' });
    const store = new GlobalStore();
    const indexer = new GlobalIndexer(store, {
      jetstreamHost: 'jetstream.test', targetCollection: COLL, reconcilePdsHosts: [],
      resolverConfig, resolverDeps: depsReturningDoc(doc), reconcileIntervalMs: 0, retryBaseMs: 1,
    });
    try {
      await indexer.testOnJetstreamEvent(jetstreamNotify({ $type: COLL }));
      expect(store.getStat('records_indexed')).toBe(0);
      expect(store.recentRejections()[0]?.reason).toContain('blocked address');
    } finally { indexer.stop(); store.close(); }
  });

  it('accepts each configured collection when the subscription is an array', async () => {
    const record = { $type: COLL, provider: 'demo', count429: 1 };
    const { kp, car } = await realGetRecordCar(record);
    const store = new GlobalStore();
    const indexer = new GlobalIndexer(store, {
      jetstreamHost: 'jetstream.test', targetCollection: ['org.peertelemetry.errorMetrics', COLL],
      reconcilePdsHosts: [], resolverConfig, resolverDeps: depsReturningDoc(await makeDidDoc(DID, kp)),
      httpGet: async () => okHttp(200, car), reconcileIntervalMs: 0,
    });
    try {
      await indexer.testOnJetstreamEvent(jetstreamNotify(record));
      expect(store.getStat('jetstream_events')).toBe(1);
      expect(store.getStat('records_indexed')).toBe(1);
      const unrelated = JSON.parse(jetstreamNotify(record));
      unrelated.commit.collection = 'app.bsky.feed.post';
      await indexer.testOnJetstreamEvent(JSON.stringify(unrelated));
      expect(store.getStat('jetstream_events')).toBe(1);
    } finally { indexer.stop(); store.close(); }
  });

  it('indexes a record ONLY after fetching + verifying it from the source PDS', async () => {
    const record = { $type: COLL, provider: 'groq', count429: 7, seq: 42, emittedAt: NOW };
    const { kp, car } = await realGetRecordCar(record);
    const doc = await makeDidDoc(DID, kp);

    let getRecordUrl = '';
    const httpGet = async (url: string) => {
      getRecordUrl = url;
      return okHttp(200, car);
    };
    const store = new GlobalStore();
    const indexer = makeIndexer(store, depsReturningDoc(doc), httpGet);
    await indexer.testOnJetstreamEvent(jetstreamNotify(record));

    // Fetched getRecord from the publisher's OWN PDS, not from a relay/Jetstream.
    expect(getRecordUrl).toContain(`https://${PDS_HOST}/xrpc/com.atproto.sync.getRecord`);
    expect(getRecordUrl).toContain(`did=${encodeURIComponent(DID)}`);
    expect(getRecordUrl).toContain(`collection=${encodeURIComponent(COLL)}`);
    expect(getRecordUrl).toContain(`rkey=${RKEY}`);

    expect(store.eventCount()).toBe(1);
    expect(store.getStat('records_indexed')).toBe(1);
    expect(store.getStat('jetstream_events')).toBe(1);
    expect(store.getStat('commits_rejected')).toBe(0);
    expect(store.recentRejections()).toEqual([]);
    // In-band correlation fields came from the SIGNED record in the CAR.
    const samples = store.latencySamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.did).toBe(DID);
    expect(samples[0]?.publisherSeq).toBe(42);
  });

  it('REJECTS + counts a record whose signed CAR fails verification, indexes NOTHING', async () => {
    const record = { $type: COLL, provider: 'groq', count429: 7, seq: 42, emittedAt: NOW };
    const { kp, car } = await realGetRecordCar(record);
    // The publisher's did:web doc advertises kp...
    const doc = await makeDidDoc(DID, kp);

    // ...but the commit block in the served CAR is signed by a DIFFERENT key.
    const { root, blocks } = await readCarWithRoot(car);
    const legitBytes = blocks.get(root);
    if (!legitBytes) throw new Error('commit block missing from CAR');
    const legit = def.commit.schema.parse(cborToLex(legitBytes)) as unknown as Commit;
    const attacker = await newKeypair();
    const forged = await signCommit(
      { did: legit.did, version: 3, data: legit.data, rev: legit.rev, prev: legit.prev ?? null },
      attacker,
    );
    expect(await verifyCommitSig(forged, kp.did())).toBe(false);
    expect(await verifyCommitSig(forged, attacker.did())).toBe(true);
    const forgedCid = await cidForRecord(forged);
    blocks.delete(root);
    blocks.set(forgedCid, cborEncode(forged));
    const forgedCar = await blocksToCarFile(forgedCid, blocks);

    const store = new GlobalStore();
    const indexer = makeIndexer(store, depsReturningDoc(doc), async () => okHttp(200, forgedCar));
    await indexer.testOnJetstreamEvent(jetstreamNotify(record));

    // Never indexed; counted as a verification rejection.
    expect(store.eventCount()).toBe(0);
    expect(store.latestRecords()).toEqual([]);
    expect(store.getStat('records_indexed')).toBe(0);
    expect(store.getStat('commits_rejected')).toBe(1);
    const rej = store.recentRejections();
    expect(rej).toHaveLength(1);
    expect(rej[0]?.did).toBe(DID);
    expect(rej[0]?.reason).toMatch(/verify-failed/);
  });

  it('REJECTS + counts when the publisher did:web doc is unresolvable', async () => {
    const record = { $type: COLL, provider: 'groq', count429: 1, seq: 1, emittedAt: NOW };
    const { car } = await realGetRecordCar(record);
    const transport: GuardedTransport = async () => {
      throw new (await import('../src/net/guarded-fetch.js')).GuardedFetchError('http-status', 'HTTP 404');
    };
    const store = new GlobalStore();
    const indexer = makeIndexer(store, { resolver: async () => ['93.184.216.34'], transport }, async () => okHttp(200, car));
    await indexer.testOnJetstreamEvent(jetstreamNotify(record));

    expect(store.eventCount()).toBe(0);
    expect(store.getStat('records_indexed')).toBe(0);
    expect(store.getStat('commits_rejected')).toBe(1);
    expect(store.recentRejections()[0]?.reason).toBe('did-doc-unresolvable');
  });

  it('source PDS unreachable: retries with bounded backoff, then DROPS + counts, never indexes', async () => {
    const record = { $type: COLL, provider: 'openai', count429: 3, seq: 9, emittedAt: NOW };
    const { kp } = await realGetRecordCar(record);
    const doc = await makeDidDoc(DID, kp);
    // getRecord always 500s. With retryBaseMs tiny, testOnJetstreamEvent awaits
    // the full retry-until-exhaustion sequence deterministically. Invariants:
    // never indexed, retries counted, final give-up counted as a drop (not a
    // verification rejection - the record was never disproven, just unreachable).
    let fetches = 0;
    const httpGet = async (url: string) => {
      if (url.includes('com.atproto.sync.getRecord')) fetches += 1;
      return okHttp(500, new Uint8Array());
    };
    const store = new GlobalStore();
    const indexer = makeIndexer(store, depsReturningDoc(doc), httpGet, { retryBaseMs: 1 });
    await indexer.testOnJetstreamEvent(jetstreamNotify(record));
    indexer.stop();

    expect(store.eventCount()).toBe(0);
    expect(store.getStat('records_indexed')).toBe(0);
    // MAX_ATTEMPTS = 5: one initial + four retries = five fetches, four counted retries.
    expect(fetches).toBe(5);
    expect(store.getStat('fetch_retries')).toBe(4);
    // Exhausted -> counted as a drop, NOT a verification rejection.
    expect(store.getStat('fetch_drops')).toBe(1);
    expect(store.getStat('commits_rejected')).toBe(0);
    expect(store.recentRejections()).toEqual([]);
  });

  it('transient source failure then success: retries and eventually indexes the verified record', async () => {
    const record = { $type: COLL, provider: 'groq', count429: 1, seq: 3, emittedAt: NOW };
    const { kp, car } = await realGetRecordCar(record);
    const doc = await makeDidDoc(DID, kp);
    // First two getRecord attempts 503, the third returns the real signed CAR.
    let attempt = 0;
    const httpGet = async (url: string) => {
      if (url.includes('com.atproto.sync.getRecord')) {
        attempt += 1;
        if (attempt < 3) return okHttp(503, new Uint8Array());
        return okHttp(200, car);
      }
      return okHttp(404, new Uint8Array());
    };
    const store = new GlobalStore();
    const indexer = makeIndexer(store, depsReturningDoc(doc), httpGet, { retryBaseMs: 1 });
    await indexer.testOnJetstreamEvent(jetstreamNotify(record));
    indexer.stop();

    expect(attempt).toBe(3);
    expect(store.getStat('fetch_retries')).toBe(2);
    expect(store.getStat('fetch_drops')).toBe(0);
    // Indexed only after the successful fetch verified.
    expect(store.eventCount()).toBe(1);
    expect(store.getStat('records_indexed')).toBe(1);
  });

  it('NEVER indexes from Jetstream JSON alone: a notify with no fetch backing indexes nothing', async () => {
    // getRecord returns 404 (record absent at source between notify and fetch).
    const record = { $type: COLL, provider: 'anthropic', count429: 2, seq: 5, emittedAt: NOW };
    const { kp } = await realGetRecordCar(record);
    const doc = await makeDidDoc(DID, kp);
    const store = new GlobalStore();
    const indexer = makeIndexer(store, depsReturningDoc(doc), async () => okHttp(404, new Uint8Array()));
    await indexer.testOnJetstreamEvent(jetstreamNotify(record));

    expect(store.eventCount()).toBe(0);
    expect(store.getStat('records_indexed')).toBe(0);
    // A 404 is a non-retryable verification-path failure: counted, not indexed.
    expect(store.getStat('commits_rejected')).toBe(1);
  });

  it('reconciliation sweep counts + indexes a record present at source but never notified', async () => {
    const record = { $type: COLL, provider: 'groq', count429: 4, seq: 7, emittedAt: NOW };
    const { kp, car } = await realGetRecordCar(record);
    const doc = await makeDidDoc(DID, kp);

    const httpGet = async (url: string) => {
      if (url.includes('com.atproto.sync.listRepos')) return jsonHttp(200, { repos: [{ did: DID }] });
      if (url.includes('com.atproto.repo.listRecords')) return jsonHttp(200, { records: [{ uri: `at://${DID}/${COLL}/${RKEY}` }] });
      if (url.includes('com.atproto.sync.getRecord')) return okHttp(200, car);
      return okHttp(404, new Uint8Array());
    };
    const store = new GlobalStore();
    const indexer = makeIndexer(store, depsReturningDoc(doc), httpGet, { reconcilePdsHosts: ['p2.0rs.org'] });

    const res = await indexer.reconcileOnce();
    // The sweep must let the enqueued verify drain; reconcileOnce pumps but the
    // verify is async, so wait a tick for it to complete.
    await new Promise((r) => setTimeout(r, 50));

    expect(res.checked).toBe(1);
    expect(res.missing).toBe(1);
    expect(store.getStat('reconcile_missing')).toBe(1);
    // Fallback path: the missed record was fetched, verified, and indexed.
    expect(store.getStat('records_indexed')).toBe(1);
    expect(store.eventCount()).toBe(1);
  });

  it('Jetstream down entirely: the reconciliation sweep is the fallback, indexing continues', async () => {
    // Simulate Jetstream being unreachable by never delivering any notification.
    // The ONLY path to indexing is the periodic listRecords sweep. It must still
    // discover, fetch, verify, and index every source record - degrade to
    // polling, never stop. Two publishers with one record each.
    const recordA = { $type: COLL, provider: 'groq', count429: 4, seq: 7, emittedAt: NOW };
    const { kp, car } = await realGetRecordCar(recordA);
    const doc = await makeDidDoc(DID, kp);

    const httpGet = async (url: string) => {
      if (url.includes('com.atproto.sync.listRepos')) return jsonHttp(200, { repos: [{ did: DID }] });
      if (url.includes('com.atproto.repo.listRecords')) {
        return jsonHttp(200, { records: [{ uri: `at://${DID}/${COLL}/${RKEY}` }] });
      }
      if (url.includes('com.atproto.sync.getRecord')) return okHttp(200, car);
      return okHttp(404, new Uint8Array());
    };
    const store = new GlobalStore();
    const indexer = makeIndexer(store, depsReturningDoc(doc), httpGet, { reconcilePdsHosts: ['p2.0rs.org'] });

    // No testOnJetstreamEvent is ever called: the notification channel is "down".
    expect(store.getStat('jetstream_events')).toBe(0);
    const res = await indexer.reconcileOnce();
    await new Promise((r) => setTimeout(r, 50));
    indexer.stop();

    // The record was indexed purely via the sweep fallback, fully verified.
    expect(res.checked).toBe(1);
    expect(res.missing).toBe(1);
    expect(store.getStat('records_indexed')).toBe(1);
    expect(store.eventCount()).toBe(1);
    expect(store.latestRecords()[0]?.sigOk).toBe(true);
  });

  it('a delete is confirmed against the source (getRecord 404) before tombstoning', async () => {
    const record = { $type: COLL, provider: 'groq', count429: 7, seq: 42, emittedAt: NOW };
    const { kp, car } = await realGetRecordCar(record);
    const doc = await makeDidDoc(DID, kp);
    // First the record exists (200 -> indexed); then the source reports it gone
    // (404), which CONFIRMS the delete and tombstones the local row.
    let recordGone = false;
    const httpGet = async (url: string) => {
      if (url.includes('com.atproto.sync.getRecord')) return recordGone ? okHttp(404, new Uint8Array()) : okHttp(200, car);
      return okHttp(404, new Uint8Array());
    };
    const store = new GlobalStore();
    const indexer = makeIndexer(store, depsReturningDoc(doc), httpGet);

    await indexer.testOnJetstreamEvent(jetstreamNotify(record));
    expect(store.latestRecords()).toHaveLength(1);

    recordGone = true; // the publisher really deleted it at the source
    await indexer.testOnJetstreamEvent(jetstreamNotify({}, { operation: 'delete', timeUs: 1_785_000_000_100_000 }));
    expect(store.latestRecords()).toEqual([]);
    expect(store.getStat('deletes_confirmed')).toBe(1);
    expect(store.getStat('deletes_rejected')).toBe(0);
  });

  it('a spurious/forged Jetstream delete is REJECTED when the source still serves the record (censorship resistance)', async () => {
    const record = { $type: COLL, provider: 'groq', count429: 7, seq: 42, emittedAt: NOW };
    const { kp, car } = await realGetRecordCar(record);
    const doc = await makeDidDoc(DID, kp);
    // The source ALWAYS serves the record (200). A malicious/erroneous Jetstream
    // "delete" must NOT be able to remove it: we only tombstone on a source 404.
    const store = new GlobalStore();
    const indexer = makeIndexer(store, depsReturningDoc(doc), async () => okHttp(200, car));

    await indexer.testOnJetstreamEvent(jetstreamNotify(record));
    expect(store.latestRecords()).toHaveLength(1);

    await indexer.testOnJetstreamEvent(jetstreamNotify({}, { operation: 'delete', timeUs: 1_785_000_000_100_000 }));
    // The record is KEPT: the delete was not confirmed by the source.
    expect(store.latestRecords()).toHaveLength(1);
    expect(store.getStat('deletes_confirmed')).toBe(0);
    expect(store.getStat('deletes_rejected')).toBe(1);
  });

  it('handles a publisher key rotation: stale cached key fails, re-resolves the current key, then indexes', async () => {
    // Publisher first publishes signed by key A (doc advertises A). We index it,
    // caching key A. Then the publisher ROTATES: the source now serves a record
    // signed by key B and the did:web doc advertises B. The first verify with the
    // cached key A fails; the indexer must re-resolve the current doc (now B) and
    // succeed, rather than permanently rejecting the publisher's genuine records.
    const recA = { $type: COLL, provider: 'groq', count429: 1, seq: 1, emittedAt: NOW };
    const a = await realGetRecordCar(recA);
    const docHolder = { doc: await makeDidDoc(DID, a.kp) };
    const transport: GuardedTransport = async (url) =>
      ({ status: 200, headers: new Map<string, string>(), body: new TextEncoder().encode(JSON.stringify(docHolder.doc)), url, peerAddress: '93.184.216.34' }) satisfies GuardedResponse;
    const deps: ResolverDeps = { resolver: async () => ['93.184.216.34'], transport };

    // The source PDS serves whichever CAR is "current".
    let currentCar = a.car;
    const store = new GlobalStore();
    const indexer = makeIndexer(store, deps, async (url) =>
      url.includes('com.atproto.sync.getRecord') ? okHttp(200, currentCar) : okHttp(404, new Uint8Array()),
    );

    await indexer.testOnJetstreamEvent(jetstreamNotify(recA));
    expect(store.getStat('records_indexed')).toBe(1);
    expect(store.getStat('commits_rejected')).toBe(0);

    // ROTATE: new keypair B, new signed record, doc now advertises B.
    const recB = { $type: COLL, provider: 'groq', count429: 2, seq: 2, emittedAt: NOW };
    const b = await realGetRecordCar(recB);
    docHolder.doc = await makeDidDoc(DID, b.kp);
    currentCar = b.car;

    await indexer.testOnJetstreamEvent(jetstreamNotify(recB, { timeUs: 1_785_000_000_900_000 }));
    // The stale cached key A failed, the indexer re-resolved to key B, verified.
    expect(store.getStat('key_refreshes')).toBe(1);
    expect(store.getStat('records_indexed')).toBe(2);
    expect(store.getStat('commits_rejected')).toBe(0);
  });

  it('a genuinely forged record is still rejected after a single key re-resolve (no infinite loop)', async () => {
    const record = { $type: COLL, provider: 'groq', count429: 7, seq: 42, emittedAt: NOW };
    const { kp, car } = await realGetRecordCar(record);
    const doc = await makeDidDoc(DID, kp);
    // Forge the commit block with a DIFFERENT key; the doc keeps advertising kp,
    // so re-resolving yields the same (correct) key and the forgery still fails.
    const { root, blocks } = await readCarWithRoot(car);
    const legit = def.commit.schema.parse(cborToLex(blocks.get(root)!)) as unknown as Commit;
    const attacker = await newKeypair();
    const forged = await signCommit({ did: legit.did, version: 3, data: legit.data, rev: legit.rev, prev: legit.prev ?? null }, attacker);
    const forgedCid = await cidForRecord(forged);
    blocks.delete(root);
    blocks.set(forgedCid, cborEncode(forged));
    const forgedCar = await blocksToCarFile(forgedCid, blocks);

    const store = new GlobalStore();
    const indexer = makeIndexer(store, depsReturningDoc(doc), async () => okHttp(200, forgedCar));
    await indexer.testOnJetstreamEvent(jetstreamNotify(record));

    // Exactly one re-resolve attempt, then rejected. Never indexed, never loops.
    expect(store.getStat('key_refreshes')).toBe(1);
    expect(store.getStat('records_indexed')).toBe(0);
    expect(store.getStat('commits_rejected')).toBe(1);
  });

  it('persists the Jetstream cursor monotonically and rejects a far-future time_us', async () => {
    const record = { $type: COLL, provider: 'groq', count429: 1, seq: 1, emittedAt: NOW };
    const { kp, car } = await realGetRecordCar(record);
    const doc = await makeDidDoc(DID, kp);
    const store = new GlobalStore();
    const indexer = makeIndexer(store, depsReturningDoc(doc), async () => okHttp(200, car));
    const JS = 'jetstream.test';

    // A normal event advances the cursor to its time_us.
    await indexer.testOnJetstreamEvent(jetstreamNotify(record, { timeUs: 1_785_000_000_000_000 }));
    expect(store.getCursor(JS)).toBe(1_785_000_000_000_000);

    // An OUT-OF-ORDER (older) event must NOT move the cursor backward - that would
    // re-deliver and, worse, a persisted backward cursor loses forward progress.
    await indexer.testOnJetstreamEvent(jetstreamNotify(record, { timeUs: 1_780_000_000_000_000 }));
    expect(store.getCursor(JS)).toBe(1_785_000_000_000_000);

    // A wildly-future time_us (garbage / hostile) must NOT be persisted - a
    // reconnect from it would SKIP everything between here and that value.
    const farFuture = (Date.now() + 10 * 3_600_000) * 1000; // 10h ahead, in microseconds
    await indexer.testOnJetstreamEvent(jetstreamNotify(record, { timeUs: farFuture }));
    expect(store.getCursor(JS)).toBe(1_785_000_000_000_000);

    // A normal forward event still advances it.
    await indexer.testOnJetstreamEvent(jetstreamNotify(record, { timeUs: 1_785_000_000_500_000 }));
    expect(store.getCursor(JS)).toBe(1_785_000_000_500_000);
  });
});
