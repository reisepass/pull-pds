import { describe, it, expect } from 'vitest';
import { Pds } from '../src/pds-websub/app.js';
import { pdsConfigFromEnv } from '../src/pds-websub/config.js';
import { IngestPipeline } from '../src/pds-websub/ingest.js';
import type { GuardedResponse } from '../src/net/guarded-fetch.js';
import { newKeypair } from './helpers.js';

/**
 * Two pings for the same DID arriving simultaneously must not interleave into a
 * corrupt repo or a duplicate rev (OVERNIGHT §3 concurrency). The Pds
 * serialises ingest per DID; we prove it by racing two ingests through a
 * deliberately slow feed transport and asserting the commit chain stays linear.
 */

const SELF = 'https://pds.example';
const HOST = 'node.test.example';
const DID = `did:web:${HOST}`;
const COLL = 'app.omniroute.errorReport';
const TOPIC = `https://${HOST}/atproto/feed.json`;

async function makeAgg() {
  process.env.ALLOW_LOCALHOST = '0';
  const config = pdsConfigFromEnv(
    { selfEndpoint: SELF, allowedCollections: [COLL], dataDir: ':memory:', minPingIntervalSec: 0 },
    { SELF_ENDPOINT: SELF } as NodeJS.ProcessEnv,
  );
  const pds = await Pds.create(config);

  let n = 0;
  const didDoc = JSON.stringify({
    id: DID,
    alsoKnownAs: [`at://${HOST}`],
    verificationMethod: [{ id: `${DID}#atproto`, type: 'Multikey', controller: DID, publicKeyMultibase: pds.pdsKey.publicKeyMultibase }],
    service: [{ id: `${DID}#atproto_pds`, type: 'AtprotoPersonalDataServer', serviceEndpoint: SELF }],
  });
  const slowTransport = async (url: string): Promise<GuardedResponse> => {
    await new Promise((r) => setTimeout(r, 10));
    if (url.endsWith('/.well-known/did.json')) {
      return { status: 200, headers: new Map(), body: new TextEncoder().encode(didDoc), url, peerAddress: '203.0.113.5' };
    }
    // Each feed fetch returns a distinct value so both pings want to commit.
    n += 1;
    const body = JSON.stringify({
      $type: 'app.pullpds.feed',
      did: DID,
      records: [{ collection: COLL, rkey: 'current', record: { $type: COLL, count429: n } }],
    });
    return { status: 200, headers: new Map([['content-type', 'application/json']]), body: new TextEncoder().encode(body), url, peerAddress: '203.0.113.5' };
  };

  // Replace the pipeline with one over the slow transport, sharing all state.
  (pds as any).pipeline = new IngestPipeline(pds.config, pds.resolverConfig, {
    resolverDeps: { resolver: async () => ['203.0.113.5'], transport: slowTransport },
    feedTransport: slowTransport,
    repoFor: (did) => pds.repoFor(did),
    firehose: pds.firehose,
    pdsKey: pds.pdsKey,
    etagStore: pds.meta,
    seenStore: pds.meta,
    nowIso: () => new Date().toISOString(),
  });
  return pds;
}

describe('concurrent ingest for the same DID', () => {
  it('serialises: no duplicate rev, commit chain stays linear', async () => {
    const pds = await makeAgg();
    // Fire two pings for the SAME DID simultaneously.
    const [a, b] = await Promise.all([pds.ingest(TOPIC), pds.ingest(TOPIC)]);

    // Both should be handled; at least one commits. Neither corrupts.
    const outcomes = [a, b];
    const committed = outcomes.filter((o) => o.status === 'committed');
    expect(committed.length).toBeGreaterThanOrEqual(1);

    // The stored commit log is strictly monotonic with unique revs.
    const mgr = await pds.repoFor(DID);
    const commits = mgr.storage.listCommits();
    const revs = commits.map((c) => c.rev);
    expect(new Set(revs).size).toBe(revs.length); // no duplicate rev
    for (let i = 1; i < revs.length; i++) expect(revs[i]! > revs[i - 1]!).toBe(true);

    // The repo root is readable and the firehose seq is monotonic.
    expect(mgr.getRoot()).not.toBeNull();
    const seqs = pds.sequencer.readSince(0, 1000).map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]! > seqs[i - 1]!).toBe(true);
    pds.meta.close();
  });

  it('three racing pings still yield a valid linear chain', async () => {
    const pds = await makeAgg();
    await Promise.all([pds.ingest(TOPIC), pds.ingest(TOPIC), pds.ingest(TOPIC)]);
    const mgr = await pds.repoFor(DID);
    const revs = mgr.storage.listCommits().map((c) => c.rev);
    expect(new Set(revs).size).toBe(revs.length);
    // Load the repo to confirm the MST/commit chain is intact and readable.
    const state = await mgr.currentState();
    expect(state.size).toBe(1); // single rkey 'current'
    pds.meta.close();
  });
});
