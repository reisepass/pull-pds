import { describe, it, expect } from 'vitest';
import { verifyCommit } from '../src/verify/commit.js';
import { validateDidDocument, type ResolvedDidWeb } from '../src/identity/didweb.js';
import type { ResolverConfig } from '../src/config.js';
import {
  makeDidDoc,
  makeSignedCommit,
  newKeypair,
  TEST_ENDPOINT,
} from './helpers.js';

const config: ResolverConfig = {
  serviceEndpoint: TEST_ENDPOINT,
  fetchTimeoutMs: 1000,
  maxDocumentBytes: 64 * 1024,
  allowLocalhost: false,
};

const did = 'did:web:example.com';

/** Build a ResolvedDidWeb from a keypair, the way the resolver would. */
async function resolvedFor(kp: Awaited<ReturnType<typeof newKeypair>>): Promise<ResolvedDidWeb> {
  const doc = await makeDidDoc(did, kp);
  const { atprotoKey, pdsEndpoint, alsoKnownAs } = validateDidDocument(did, doc, config);
  return { did, host: 'example.com', atprotoKey, pdsEndpoint, alsoKnownAs, document: doc };
}

describe('verifyCommit', () => {
  it('accepts a commit signed by the doc #atproto key and records the key', async () => {
    const kp = await newKeypair();
    const identity = await resolvedFor(kp);
    const commit = await makeSignedCommit(did, kp);

    const result = await verifyCommit(commit, identity);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.did).toBe(did);
      expect(result.keyDidKey).toBe(kp.did());
      expect(result.keyMultikey).toBe(identity.atprotoKey.multikey);
      expect(result.jwtAlg).toBe('ES256K');
    }
  });

  it('rejects a commit signed by a different key', async () => {
    const kp = await newKeypair();
    const attacker = await newKeypair();
    const identity = await resolvedFor(kp); // doc advertises kp
    const commit = await makeSignedCommit(did, attacker); // but attacker signed

    const result = await verifyCommit(commit, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-signature');
  });

  it('rejects a tampered commit body', async () => {
    const kp = await newKeypair();
    const identity = await resolvedFor(kp);
    const commit = await makeSignedCommit(did, kp);
    // Mutate rev after signing; signature no longer covers the bytes.
    const tampered = { ...commit, rev: '3lqtamper0000' };

    const result = await verifyCommit(tampered, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-signature');
  });

  it('rejects when the commit did does not match the identity', async () => {
    const kp = await newKeypair();
    const identity = await resolvedFor(kp);
    const commit = await makeSignedCommit('did:web:other.example', kp);

    const result = await verifyCommit(commit, identity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('did-mismatch');
  });

  it('after key rotation, the old commit fails against the new doc (no audit log)', async () => {
    // DESIGN.md section 4: we verify against the *current* document, so a commit
    // signed by the pre-rotation key is orphaned once the doc advertises a new key.
    const oldKey = await newKeypair();
    const newKey = await newKeypair();
    const commit = await makeSignedCommit(did, oldKey);

    const rotatedIdentity = await resolvedFor(newKey); // doc now names newKey
    const result = await verifyCommit(commit, rotatedIdentity);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-signature');

    // The same commit still verifies against the pre-rotation identity, and the
    // recorded key is what lets a caller keep old history checkable.
    const oldIdentity = await resolvedFor(oldKey);
    const okResult = await verifyCommit(commit, oldIdentity);
    expect(okResult.ok).toBe(true);
    if (okResult.ok) expect(okResult.keyDidKey).toBe(oldKey.did());
  });
});
