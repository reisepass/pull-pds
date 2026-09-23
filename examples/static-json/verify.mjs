// Cold read: resolve the publisher identity, fetch a CAR, verify its signature
// and Merkle tree, then print the records. No access to server secrets/storage.
import { readCarWithRoot, verifyRepo, MemoryBlockstore } from '@atproto/repo';
import { resolveDidWeb } from '../../dist/src/identity/didweb.js';
import { DEFAULT_RESOLVER_CONFIG } from '../../dist/src/config.js';
import { guardedFetch } from '../../dist/src/net/guarded-fetch.js';

const did = process.env.PUBLISHER_DID;
if (!did) throw new Error('Set PUBLISHER_DID to the publisher did:web identity.');
const identity = await resolveDidWeb(did, { ...DEFAULT_RESOLVER_CONFIG, skipEndpointCheck: true });
const url = new URL('/xrpc/com.atproto.sync.getRepo', identity.pdsEndpoint);
url.searchParams.set('did', did);
const response = await guardedFetch(url.href, { timeoutMs: 15_000, maxBytes: 16 * 1024 * 1024, maxRedirects: 0 });
if (response.status !== 200) throw new Error(`getRepo failed: HTTP ${response.status}`);
const { root, blocks } = await readCarWithRoot(response.body);
const verified = await verifyRepo(blocks, root, did, identity.atprotoKey.didKey);
const store = new MemoryBlockstore(blocks);
const records = [];
for (const entry of verified.creates) records.push({
  collection: entry.collection, rkey: entry.rkey, cid: entry.cid.toString(), record: await store.attemptReadRecord(entry.cid),
});
console.log(JSON.stringify({ did, commitCid: root.toString(), verified: true, records }, null, 2));
