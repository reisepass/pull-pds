import { CID } from 'multiformats';
import { Repo, cborToLexRecord } from '@atproto/repo';
import type { Pds } from '../pds-websub/app.js';

/**
 * The read + sync XRPC handlers. Standard atproto, no
 * deviations, so third-party tooling consumes the repos unmodified. Each handler
 * returns a small typed result the HTTP layer serialises (JSON or CAR bytes).
 *
 * §6.3 endpoints (createAccount, createSession, applyWrites, OAuth, …) are not
 * here; the router returns 501 for them. Their absence is the feature.
 */

export interface XrpcResult {
  status: number;
  /** JSON body, or raw bytes for CAR responses. */
  json?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
}

export function ok(json: unknown): XrpcResult {
  return { status: 200, json };
}
export function car(bytes: Uint8Array): XrpcResult {
  return { status: 200, bytes, contentType: 'application/vnd.ipld.car' };
}
export function xrpcError(status: number, error: string, message?: string): XrpcResult {
  return { status, json: { error, ...(message ? { message } : {}) } };
}

// --- com.atproto.server.describeServer ------------------------------------

export function describeServer(pds: Pds): XrpcResult {
  // Must NOT advertise account creation (spec §6.2). No invite/phone required
  // because there is nothing to create.
  return ok({
    did: pds.config.pdsDid,
    availableUserDomains: [],
    inviteCodeRequired: false,
    phoneVerificationRequired: false,
    // Signal explicitly that this is a read/sync-only, pull-PDS.
    contact: {},
    links: {},
  });
}

// --- com.atproto.sync.* ----------------------------------------------------

export async function getRepo(pds: Pds, did: string, since?: string): Promise<XrpcResult> {
  const mgr = await pds.repoFor(did);
  if (mgr.isEmpty()) return xrpcError(404, 'RepoNotFound', `no repo for ${did}`);
  const bytes = since ? await mgr.carSince(since) : await mgr.fullCar();
  return car(bytes);
}

export async function getLatestCommit(pds: Pds, did: string): Promise<XrpcResult> {
  const mgr = await pds.repoFor(did);
  const root = mgr.getRoot();
  const rev = mgr.getRev();
  if (!root || !rev) return xrpcError(404, 'RepoNotFound', `no repo for ${did}`);
  return ok({ cid: root.toString(), rev });
}

export async function getRecord(
  pds: Pds,
  did: string,
  collection: string,
  rkey: string,
): Promise<XrpcResult> {
  const mgr = await pds.repoFor(did);
  if (mgr.isEmpty()) return xrpcError(404, 'RepoNotFound', `no repo for ${did}`);
  const proof = await mgr.recordProofCar(collection, rkey);
  if (!proof) return xrpcError(404, 'RecordNotFound', `no record ${collection}/${rkey}`);
  // com.atproto.sync.getRecord returns the covering-proof CAR.
  return car(proof);
}

export async function getRepoStatus(pds: Pds, did: string): Promise<XrpcResult> {
  const mgr = await pds.repoFor(did);
  if (mgr.isEmpty() && !pds.meta.has(did)) {
    return xrpcError(404, 'RepoNotFound', `no repo for ${did}`);
  }
  const active = pds.meta.isActive(did);
  const rev = mgr.getRev();
  const status = pds.meta.status(did);
  return ok({
    did,
    active,
    ...(status ? { status } : {}),
    ...(rev ? { rev } : {}),
  });
}

export async function listRepos(pds: Pds, limit = 500, cursor?: string): Promise<XrpcResult> {
  // `listDids()` returns DIDs sorted ascending, so pagination is a "strictly
  // greater than the cursor" scan. This is robust to a stale cursor whose exact
  // DID was since deleted (F-10): an `indexOf(cursor)+1` returns -1+1=0 and
  // silently RESTARTS from the top - an infinite loop for a crawler. A
  // greater-than scan instead resumes at the right place or ends cleanly.
  const dids = pds.meta.listDids();
  const start = cursor ? lowerBoundGt(dids, cursor) : 0;
  const page = dids.slice(start, start + limit);
  const repos = await Promise.all(
    page.map(async (did) => {
      const mgr = await pds.repoFor(did);
      return {
        did,
        head: mgr.getRoot()?.toString() ?? null,
        rev: mgr.getRev() ?? null,
        active: pds.meta.isActive(did),
        ...(pds.meta.status(did) ? { status: pds.meta.status(did) } : {}),
      };
    }),
  );
  const next = page.length === limit ? page[page.length - 1] : undefined;
  return ok({ ...(next ? { cursor: next } : {}), repos });
}

/** Index of the first element strictly greater than `cursor` in a sorted array. */
function lowerBoundGt(sorted: string[], cursor: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! <= cursor) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function listBlobs(): XrpcResult {
  // We carry no blobs (spec §6.2 - stub/empty).
  return ok({ cids: [] });
}

export function getBlob(): XrpcResult {
  return xrpcError(404, 'BlobNotFound', 'this PDS carries no blobs');
}

// --- com.atproto.repo.* (unauthenticated reads) ----------------------------

export async function repoGetRecord(
  pds: Pds,
  did: string,
  collection: string,
  rkey: string,
): Promise<XrpcResult> {
  const mgr = await pds.repoFor(did);
  const root = mgr.getRoot();
  if (!root) return xrpcError(404, 'RepoNotFound', `no repo for ${did}`);
  const repo = await Repo.load(mgr.storage.asRepoStorage(), root);
  const value = await repo.getRecord(collection, rkey);
  if (value == null) return xrpcError(404, 'RecordNotFound', `no record ${collection}/${rkey}`);
  const cid = await repo.data.get(`${collection}/${rkey}`);
  return ok({
    uri: `at://${did}/${collection}/${rkey}`,
    cid: cid?.toString() ?? null,
    value,
  });
}

export async function repoListRecords(
  pds: Pds,
  did: string,
  collection: string,
  limit = 50,
  cursor?: string,
): Promise<XrpcResult> {
  const mgr = await pds.repoFor(did);
  const root = mgr.getRoot();
  if (!root) return xrpcError(404, 'RepoNotFound', `no repo for ${did}`);
  const repo = await Repo.load(mgr.storage.asRepoStorage(), root);
  const records: Array<{ uri: string; cid: string; value: unknown }> = [];
  for await (const entry of repo.walkRecords()) {
    if (entry.collection !== collection) continue;
    if (cursor && entry.rkey <= cursor) continue;
    records.push({
      uri: `at://${did}/${entry.collection}/${entry.rkey}`,
      cid: entry.cid.toString(),
      value: entry.record,
    });
    if (records.length >= limit) break;
  }
  const next = records.length === limit ? lastRkey(records) : undefined;
  return ok({ ...(next ? { cursor: next } : {}), records });
}

export async function describeRepo(pds: Pds, did: string): Promise<XrpcResult> {
  const mgr = await pds.repoFor(did);
  const root = mgr.getRoot();
  if (!root) return xrpcError(404, 'RepoNotFound', `no repo for ${did}`);
  const repo = await Repo.load(mgr.storage.asRepoStorage(), root);
  const collections = new Set<string>();
  for await (const entry of repo.walkRecords()) collections.add(entry.collection);
  return ok({
    did,
    handle: hostFromDid(did),
    didDoc: null,
    collections: [...collections].sort(),
    handleIsCorrect: true,
  });
}

// --- 6.3 deliberately-absent endpoints -------------------------------------

export function notImplemented(nsid: string): XrpcResult {
  return xrpcError(501, 'MethodNotImplemented', `${nsid} is intentionally not implemented on a pull-PDS`);
}

function lastRkey(records: Array<{ uri: string }>): string {
  const uri = records[records.length - 1]!.uri;
  return uri.slice(uri.lastIndexOf('/') + 1);
}

function hostFromDid(did: string): string {
  return decodeURIComponent(did.slice('did:web:'.length));
}

/** Re-export for the descriptor route to build a getRecord response by CID. */
export async function readRecordByCid(mgrStorage: SqliteLike, cid: string): Promise<unknown | null> {
  const bytes = mgrStorage.getBlockBytes(CID.parse(cid));
  if (!bytes) return null;
  try {
    return cborToLexRecord(bytes);
  } catch {
    return null;
  }
}

interface SqliteLike {
  getBlockBytes(cid: CID): Uint8Array | null;
}
