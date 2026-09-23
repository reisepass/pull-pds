import { verifyCommitSig } from '@atproto/repo';
import type { Commit } from '@atproto/repo';
import type { ResolvedDidWeb } from '../identity/didweb.js';

/**
 * Result of verifying a commit against a resolved did:web identity.
 *
 * On success we record `keyMultikey` / `keyDidKey`: the exact key that verified
 * this commit, taken from the *current* document. did:web has no audit log
 * (DESIGN.md section 4), so this local record is the only thing that keeps a
 * repo's history checkable after the holder rotates its key. Callers persist it
 * alongside the accepted commit (BRIEF key-rotation note).
 */
export type CommitVerification =
  | {
      ok: true;
      did: string;
      keyMultikey: string;
      keyDidKey: string;
      jwtAlg: string;
    }
  | {
      ok: false;
      reason: CommitVerifyFailure;
      message: string;
    };

export type CommitVerifyFailure =
  | 'did-mismatch'
  | 'bad-signature'
  | 'verify-error';

/**
 * Verify a signed commit against the `#atproto` key in an already-resolved
 * did:web document.
 *
 * We verify against the current document only (DESIGN.md section 4: verify
 * against the current doc, accept that a rotation orphans prior history) and
 * report which key did the verifying so the caller can bind it to the commit.
 *
 * Crypto is delegated entirely to `@atproto/repo` / `@atproto/crypto` - the
 * commit is re-CBOR-encoded without its `sig` and checked against the did:key.
 * We never touch secp256k1 directly (BRIEF hard constraint).
 */
export async function verifyCommit(
  commit: Commit,
  identity: ResolvedDidWeb,
): Promise<CommitVerification> {
  // The commit must claim the identity we resolved. A commit signed by a valid
  // key but carrying a different `did` is not this node's commit.
  if (commit.did !== identity.did) {
    return {
      ok: false,
      reason: 'did-mismatch',
      message: `Commit did ${commit.did} != ${identity.did}`,
    };
  }

  const { didKey } = identity.atprotoKey;
  let valid: boolean;
  try {
    valid = await verifyCommitSig(commit, didKey);
  } catch (err) {
    // A malformed signature or key surfaces as a thrown error in the crypto
    // layer; treat it as a verification failure, never a crash.
    return {
      ok: false,
      reason: 'verify-error',
      message: `Verification threw: ${(err as Error).message}`,
    };
  }

  if (!valid) {
    return {
      ok: false,
      reason: 'bad-signature',
      message: 'Commit signature does not match #atproto key',
    };
  }

  return {
    ok: true,
    did: commit.did,
    keyMultikey: identity.atprotoKey.multikey,
    keyDidKey: didKey,
    jwtAlg: identity.atprotoKey.jwtAlg,
  };
}
