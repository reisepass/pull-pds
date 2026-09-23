import { describe, it, expect } from 'vitest';
import { resolveDidWeb, DidWebError } from '../src/identity/didweb.js';
import type { GuardedResponse } from '../src/net/guarded-fetch.js';
import { GuardedFetchError } from '../src/net/guarded-fetch.js';
import { SqliteSequencerStore } from '../src/storage/sqlite-sequencer-store.js';
import { SqliteRepoStorage } from '../src/storage/sqlite-repo-store.js';
import { RepoManager } from '../src/repo/repo-manager.js';
import { Sequencer } from '../src/firehose/sequencer.js';
import { FirehoseService } from '../src/firehose/service.js';
import { pdsKeyFromKeypair } from '../src/repo/signing-key.js';
import { IngestPipeline } from '../src/pds-websub/ingest.js';
import type { IngestDeps } from '../src/pds-websub/ingest.js';
import { pdsConfigFromEnv } from '../src/pds-websub/config.js';
import { DEFAULT_RESOLVER_CONFIG } from '../src/config.js';
import { newKeypair, multikeyFor } from './helpers.js';

/**
 * Adversarial identity + binding sweep (ADVERSARIAL-TESTS.md "Identity and
 * binding"). The four binding checks are the load-bearing guarantee; these pin
 * host-normalization, credential, and cross-origin-redirect behaviours that a
 * bypass would exploit.
 */

const SELF = 'https://agg.example';
const HOST = 'node.test.example';
const DID = `did:web:${HOST}`;
const COLL = 'app.omniroute.errorReport';

const resolverConfig = { ...DEFAULT_RESOLVER_CONFIG, serviceEndpoint: SELF };

function docFor(multikey: string, opts: { endpoint?: string; id?: string } = {}): string {
  const id = opts.id ?? DID;
  return JSON.stringify({
    id,
    alsoKnownAs: [`at://${HOST}`],
    verificationMethod: [{ id: `${id}#atproto`, type: 'Multikey', controller: id, publicKeyMultibase: multikey }],
    service: [{ id: `${id}#atproto_pds`, type: 'AtprotoPersonalDataServer', serviceEndpoint: opts.endpoint ?? SELF }],
  });
}

describe('did.json resolution binding (transport-level)', () => {
  it('a cross-origin redirect on the did.json fetch is refused (never followed off-origin)', async () => {
    // A transport that mimics guardedFetch refusing a cross-host redirect.
    const transport = async (): Promise<GuardedResponse> => {
      throw new GuardedFetchError('cross-host-redirect', 'Refusing cross-host redirect node.test.example -> evil.example');
    };
    let code = 'NO-THROW';
    try {
      await resolveDidWeb(DID, resolverConfig, { resolver: async () => ['203.0.113.5'], transport });
    } catch (e) {
      code = e instanceof DidWebError ? e.code : `OTHER:${(e as Error).message}`;
    }
    expect(code).toBe('cross-host-redirect');
  });

  it('a did.json served with a mismatched id is rejected (binding check #4)', async () => {
    const multikey = await multikeyFor(await newKeypair());
    const transport = async (url: string): Promise<GuardedResponse> => ({
      status: 200,
      headers: new Map(),
      body: new TextEncoder().encode(docFor(multikey, { id: 'did:web:someone.else.example' })),
      url,
      peerAddress: '203.0.113.5',
    });
    let code = 'NO-THROW';
    try {
      await resolveDidWeb(DID, resolverConfig, { resolver: async () => ['203.0.113.5'], transport });
    } catch (e) {
      code = e instanceof DidWebError ? e.code : `OTHER:${(e as Error).message}`;
    }
    expect(code).toBe('invalid-document');
  });

  it('a did.json whose #atproto_pds points at another host is rejected (binding check #1)', async () => {
    const multikey = await multikeyFor(await newKeypair());
    const transport = async (url: string): Promise<GuardedResponse> => ({
      status: 200,
      headers: new Map(),
      body: new TextEncoder().encode(docFor(multikey, { endpoint: 'https://evil.example' })),
      url,
      peerAddress: '203.0.113.5',
    });
    let code = 'NO-THROW';
    try {
      await resolveDidWeb(DID, resolverConfig, { resolver: async () => ['203.0.113.5'], transport });
    } catch (e) {
      code = e instanceof DidWebError ? e.code : `OTHER:${(e as Error).message}`;
    }
    expect(code).toBe('wrong-service-endpoint');
  });
});

// ---------------------------------------------------------------------------
// Ingest-level origin binding: the topic host is normalized and pinned, so
// case variation and URL credentials cannot get a record into another repo.
// ---------------------------------------------------------------------------

interface BindHarness {
  ingest: (topic: string) => Promise<import('../src/pds-websub/ingest.js').IngestOutcome>;
  rootOf: (did: string) => string | null;
  seqNow: () => number;
}

async function bindingHarness(): Promise<BindHarness> {
  const kp = await newKeypair();
  const pdsKey = pdsKeyFromKeypair(kp);
  const seq = new Sequencer(new SqliteSequencerStore());
  const firehose = new FirehoseService(seq);
  const managers = new Map<string, RepoManager>();
  const etags = new Map<string, string>();
  const seen = new Set<string>();

  const feedFor = (did: string) =>
    JSON.stringify({ $type: 'app.pullpds.feed', did, records: [{ collection: COLL, rkey: 'a', record: { $type: COLL, n: 1 } }] });

  const resolverTransport = async (url: string): Promise<GuardedResponse> => {
    // did.json for whatever host was resolved: always the canonical lowercase DID.
    const u = new URL(url);
    const host = u.hostname; // already lowercased by WHATWG URL
    const did = `did:web:${host}`;
    return { status: 200, headers: new Map(), body: new TextEncoder().encode(docFor(pdsKey.publicKeyMultibase, { id: did })), url, peerAddress: '203.0.113.5' };
  };
  const feedTransport = async (url: string): Promise<GuardedResponse> => {
    const u = new URL(url);
    const did = `did:web:${u.hostname}`;
    return { status: 200, headers: new Map([['content-type', 'application/json']]), body: new TextEncoder().encode(feedFor(did)), url, peerAddress: '203.0.113.5' };
  };

  const deps: IngestDeps = {
    resolverDeps: { resolver: async () => ['203.0.113.5'], transport: resolverTransport },
    feedTransport,
    repoFor: async (did) => {
      let m = managers.get(did);
      if (!m) {
        m = new RepoManager(new SqliteRepoStorage(did), pdsKey.signer);
        managers.set(did, m);
      }
      return m;
    },
    firehose,
    pdsKey,
    etagStore: { get: (d) => etags.get(d) ?? null, set: (d, e) => void etags.set(d, e) },
    seenStore: { has: (d) => seen.has(d), add: (d) => void seen.add(d) },
    nowIso: () => '2026-07-21T12:00:00Z',
  };
  const agg = pdsConfigFromEnv({ selfEndpoint: SELF, allowedCollections: [COLL] }, {} as NodeJS.ProcessEnv);
  const pipeline = new IngestPipeline(agg, resolverConfig, deps);
  return {
    ingest: (topic) => pipeline.ingest(topic),
    rootOf: (did) => managers.get(did)?.getRoot()?.toString() ?? null,
    seqNow: () => seq.currentSeq(),
  };
}

describe('ingest origin binding under host tricks', () => {
  it('a mixed-case topic host commits under the normalized lowercase DID only', async () => {
    const h = await bindingHarness();
    const out = await h.ingest('https://Node.Test.Example/atproto/feed.json');
    expect(out.status).toBe('committed');
    // The record landed in the lowercase DID, and NOT under a mixed-case DID.
    expect(h.rootOf('did:web:node.test.example')).not.toBeNull();
    expect(h.rootOf('did:web:Node.Test.Example')).toBeNull();
  });

  it('credentials embedded in the topic URL do not change the bound origin', async () => {
    const h = await bindingHarness();
    const out = await h.ingest('https://attacker:secret@node.test.example/atproto/feed.json');
    // The userinfo is stripped from hostname, so it binds to node.test.example.
    expect(out.status).toBe('committed');
    expect(h.rootOf('did:web:node.test.example')).not.toBeNull();
  });
});
