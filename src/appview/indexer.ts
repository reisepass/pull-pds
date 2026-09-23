import { WebSocket } from 'ws';
import { cborDecodeAll } from '@atproto/lex-cbor';
import {
  verifyRepoCar,
  readCarWithRoot,
  cborToLex,
  cborToLexRecord,
  verifyCommitSig,
  def,
  MemoryBlockstore,
  MST,
} from '@atproto/repo';
import type { Commit } from '@atproto/repo';
import { CID } from 'multiformats';
import { IndexStore } from './index-store.js';
import { resolveDidWeb, type ResolvedDidWeb } from '../identity/didweb.js';
import { defaultResolverDeps } from '../identity/didweb.js';
import type { ResolverConfig } from '../config.js';
import { log } from '../log.js';
import { trace, traceEnabled } from '../trace.js';

/**
 * The AppView indexer (PHASE-3 B2). For each configured PDS host it:
 *   1. discovers repos via `com.atproto.sync.listRepos`,
 *   2. backfills each via `com.atproto.sync.getRepo` (verifying the whole CAR
 *      against the key in that repo's *own DID document*, not the PDS's word),
 *   3. stays live on `com.atproto.sync.subscribeRepos` from a persisted cursor,
 *      verifying every `#commit` signature before indexing.
 *
 * The signature is always checked against `expected_key(did)` resolved from the
 * publisher's did:web document. An unverifiable commit is counted and skipped,
 * never indexed - that is the property that makes the aggregate trustworthy.
 */
export interface IndexerConfig {
  /** PDS hosts to index, e.g. ["p2.0rs.org","p3.0rs.org"]. No privileged access. */
  pdsHosts: string[];
  resolverConfig: ResolverConfig;
}

export class Indexer {
  private sockets: WebSocket[] = [];
  private running = false;
  /** Cache of resolved publisher identities (did -> signing did:key). */
  private readonly keyCache = new Map<string, string>();

  constructor(
    readonly store: IndexStore,
    private readonly config: IndexerConfig,
  ) {}

  /** Backfill every host, then go live. Resolves once backfill is done. */
  async start(): Promise<void> {
    this.running = true;
    for (const host of this.config.pdsHosts) {
      try {
        await this.backfillHost(host);
      } catch (err) {
        log.error('backfill failed', { host, err: (err as Error).message });
      }
    }
    for (const host of this.config.pdsHosts) {
      this.subscribe(host);
    }
    log.info('indexer live', { hosts: this.config.pdsHosts });
  }

  stop(): void {
    this.running = false;
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.sockets = [];
  }

  // --- signing-key resolution ----------------------------------------------

  /** The did:key that a publisher's did:web document advertises as #atproto. */
  private async signingKeyFor(did: string): Promise<string | null> {
    const cached = this.keyCache.get(did);
    if (cached) return cached;
    try {
      const identity: ResolvedDidWeb = await resolveDidWeb(did, this.config.resolverConfig, defaultResolverDeps());
      this.keyCache.set(did, identity.atprotoKey.didKey);
      return identity.atprotoKey.didKey;
    } catch (err) {
      log.warn('could not resolve publisher DID doc', { did, err: (err as Error).message });
      return null;
    }
  }

  // --- backfill -------------------------------------------------------------

  private async backfillHost(host: string): Promise<void> {
    const base = `https://${host}`;
    const repos = await this.listRepos(base);
    log.info('discovered repos', { host, count: repos.length });
    for (const did of repos) {
      await this.backfillRepo(host, base, did);
    }
  }

  private async listRepos(base: string): Promise<string[]> {
    const out: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const url = new URL(`${base}/xrpc/com.atproto.sync.listRepos`);
      url.searchParams.set('limit', '500');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`listRepos ${res.status}`);
      const body = (await res.json()) as { repos: Array<{ did: string }>; cursor?: string };
      for (const r of body.repos) out.push(r.did);
      if (!body.cursor || body.repos.length === 0) break;
      cursor = body.cursor;
    }
    return out;
  }

  private async backfillRepo(host: string, base: string, did: string): Promise<void> {
    const signingKey = await this.signingKeyFor(did);
    if (!signingKey) {
      this.store.recordRejection({ at: new Date().toISOString(), did, sourcePds: host, rev: null, reason: 'did-doc-unresolvable' });
      return;
    }
    const url = new URL(`${base}/xrpc/com.atproto.sync.getRepo`);
    url.searchParams.set('did', did);
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      log.warn('getRepo failed', { host, did, status: res.status });
      return;
    }
    const car = new Uint8Array(await res.arrayBuffer());

    // Verify the WHOLE repo CAR against the publisher's own key. Throws if the
    // signature does not match - we then reject and index nothing.
    try {
      await verifyRepoCar(car, did, signingKey);
    } catch (err) {
      this.store.recordRejection({ at: new Date().toISOString(), did, sourcePds: host, rev: null, reason: `car-verify-failed: ${(err as Error).message}` });
      log.warn('repo CAR failed verification - not indexed', { host, did });
      return;
    }

    // Walk the verified repo and index every record.
    const { root, blocks } = await readCarWithRoot(car);
    const bs = new MemoryBlockstore(blocks);
    const commit = await bs.readObj(root, def.commit);
    const rev = commit.rev;
    const mst = MST.load(bs, commit.data);
    let n = 0;
    for await (const leaf of mst.walkLeavesFrom('')) {
      const { collection, rkey } = parseDataKey(leaf.key);
      const value = await bs.attemptReadRecord(leaf.value);
      if (!value) continue;
      this.store.putRecord({
        did,
        collection,
        rkey,
        cid: leaf.value.toString(),
        recordJson: JSON.stringify(value),
        rev,
        sourcePds: host,
        sigVerified: true,
        indexedAt: new Date().toISOString(),
      });
      n++;
    }
    this.store.bumpStat('commits_indexed');
    log.info('backfilled repo', { host, did, records: n });
  }

  // --- live firehose --------------------------------------------------------

  private subscribe(host: string): void {
    if (!this.running) return;
    const cursor = this.store.getCursor(host);
    const ws = new WebSocket(`wss://${host}/xrpc/com.atproto.sync.subscribeRepos?cursor=${cursor}`);
    ws.binaryType = 'arraybuffer';
    this.sockets.push(ws);

    ws.on('message', (data: ArrayBuffer | Buffer) => {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data);
      this.onFrame(host, bytes).catch((err) => log.error('frame handling failed', { host, err: (err as Error).message }));
    });
    ws.on('close', () => {
      if (this.running) {
        // Reconnect from the persisted cursor after a short delay.
        setTimeout(() => this.subscribe(host), 2_000);
      }
    });
    ws.on('error', (err) => log.warn('firehose socket error', { host, err: (err as Error).message }));
  }

  private async onFrame(host: string, bytes: Uint8Array): Promise<void> {
    let header: { op?: number; t?: string };
    let body: Record<string, unknown>;
    try {
      const parts = [...cborDecodeAll(bytes)] as unknown[];
      header = parts[0] as { op?: number; t?: string };
      body = parts[1] as Record<string, unknown>;
    } catch {
      return;
    }
    if (header.t !== '#commit') {
      // Advance the cursor on non-commit frames too (identity/account/sync).
      if (typeof body?.seq === 'number') this.store.setCursor(host, body.seq);
      return;
    }
    trace({ hop: 't_recv', host, did: body.repo, rev: body.rev, firehoseSeq: body.seq });
    await this.indexCommit(host, body);
  }

  private async indexCommit(host: string, body: Record<string, unknown>): Promise<void> {
    const seq = body.seq as number;
    const did = body.repo as string;
    const rev = body.rev as string;
    const blocksCar = body.blocks as Uint8Array;
    const ops = (body.ops as Array<{ action: string; path: string; cid: CID | null }>) ?? [];

    const signingKey = await this.signingKeyFor(did);
    if (!signingKey) {
      this.store.recordRejection({ at: new Date().toISOString(), did, sourcePds: host, rev, reason: 'did-doc-unresolvable' });
      if (typeof seq === 'number') this.store.setCursor(host, seq);
      return;
    }

    // Verify the commit signature against the publisher's key BEFORE indexing.
    try {
      const { blocks } = await readCarWithRoot(blocksCar);
      const commitCid = body.commit as CID;
      const commitBytes = blocks.get(commitCid);
      if (!commitBytes) throw new Error('commit block missing from frame CAR');
      const commit = def.commit.schema.parse(cborToLex(commitBytes)) as unknown as Commit;
      const ok = await verifyCommitSig(commit, signingKey);
      if (!ok) throw new Error('signature does not match published key');

      // Apply ops: create/update -> read record from the frame CAR + index;
      // delete -> remove from the index.
      for (const op of ops) {
        const { collection, rkey } = parseDataKey(op.path);
        if (op.action === 'delete') {
          this.store.deleteRecord(did, collection, rkey);
          continue;
        }
        if (!op.cid) continue;
        const cid = op.cid instanceof CID ? op.cid : CID.parse(String(op.cid));
        const recBytes = blocks.get(cid);
        if (!recBytes) continue;
        const value = cborToLexRecord(recBytes);
        this.store.putRecord({
          did,
          collection,
          rkey,
          cid: cid.toString(),
          recordJson: JSON.stringify(value),
          rev,
          sourcePds: host,
          sigVerified: true,
          indexedAt: new Date().toISOString(),
        });
        // Correlation: the record carries its own `seq`/`emittedAt` in-band, so
        // the trace ties this indexed row to the exact ping (PHASE-4 §3).
        if (traceEnabled()) {
          const v = value as Record<string, unknown>;
          trace({ hop: 't_indexed', host, did, rev, collection, rkey, seq: v['seq'], emittedAt: v['emittedAt'] });
        }
      }
      this.store.bumpStat('commits_indexed');
    } catch (err) {
      this.store.recordRejection({ at: new Date().toISOString(), did, sourcePds: host, rev, reason: `commit-verify-failed: ${(err as Error).message}` });
      log.warn('commit failed verification - not indexed', { host, did, rev, err: (err as Error).message });
    } finally {
      if (typeof seq === 'number') this.store.setCursor(host, seq);
    }
  }
}

function parseDataKey(key: string): { collection: string; rkey: string } {
  const slash = key.indexOf('/');
  if (slash === -1) return { collection: key, rkey: '' };
  return { collection: key.slice(0, slash), rkey: key.slice(slash + 1) };
}
