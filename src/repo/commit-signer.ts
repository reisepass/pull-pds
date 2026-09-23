import type { Keypair, Signer } from '@atproto/crypto';

/**
 * The one seam the two competing designs disagree about.
 *
 * DESIGN.md (self-sign): the did:web holder signs its own commit bytes; this
 * server only ever *receives* a signature it did not produce.
 * pull-pds-spec.md (pull-aggregator): the aggregator holds the key and signs
 * every commit itself (spec section 5 step 8).
 *
 * Everything in the commit pipeline *above* the signature - building the MST,
 * assembling the unsigned commit, DAG-CBOR encoding it - is byte-identical
 * between the two. Only "who turns these bytes into a signature" differs. This
 * interface quarantines that single decision so either model drops in without
 * touching the rest of the repo code.
 *
 * The shape is deliberately `@atproto/crypto`'s `Signer` plus a DID accessor,
 * so a `CommitSigner` is directly usable anywhere `@atproto/repo` wants a
 * `Keypair` (it only ever calls `.sign()`, `.jwtAlg`, and - for did:key
 * derivation - the DID).
 */
export interface CommitSigner extends Signer {
  /**
   * The `did:key` of the signing key, so callers can record which key signed a
   * commit and cross-check it against a resolved did:web `#atproto` entry.
   */
  signingDidKey(): string;
}

/**
 * Adapt a `CommitSigner` to the `@atproto/repo` `Keypair` shape. `@atproto/repo`
 * only needs `jwtAlg`, `sign()`, and `did()`; we back `did()` with the signer's
 * signing key so `formatInitCommit`/`signCommit` derive the correct did:key.
 */
export function asKeypair(signer: CommitSigner): Keypair {
  return {
    jwtAlg: signer.jwtAlg,
    sign: (msg) => signer.sign(msg),
    did: () => signer.signingDidKey(),
  };
}

/**
 * Aggregator-model signer: wraps a local `@atproto/crypto` keypair and signs
 * commit bytes directly. This is the pull-pds-spec.md `AGG_SIGNING_KEY` path.
 * Trivial by construction - the key material lives here.
 */
export class LocalKeyCommitSigner implements CommitSigner {
  readonly jwtAlg: string;

  constructor(private readonly keypair: Keypair) {
    this.jwtAlg = keypair.jwtAlg;
  }

  sign(msg: Uint8Array): Promise<Uint8Array> {
    return this.keypair.sign(msg);
  }

  signingDidKey(): string {
    return this.keypair.did();
  }
}

/** Produces a signature for the given commit bytes, out of band. */
export type RemoteSignFn = (unsignedCommitBytes: Uint8Array) => Promise<Uint8Array>;

/**
 * Self-sign-model signer: the key lives with the did:web holder, not here. The
 * server hands out unsigned commit bytes and receives a signature back (DESIGN.md
 * write shape B: server builds, client signs, server assembles). We hold only
 * the holder's *public* did:key - enough to satisfy `@atproto/repo`'s did()
 * derivation and to record/verify which key signed - and delegate the actual
 * signing to the injected `RemoteSignFn`.
 *
 * The seam is defined now; the transport that carries bytes out and a signature
 * back is deferred until the fork is decided (per NEXT-TASK.md section 3).
 */
export class RemoteCommitSigner implements CommitSigner {
  constructor(
    readonly jwtAlg: string,
    private readonly holderDidKey: string,
    private readonly signFn: RemoteSignFn,
  ) {}

  sign(msg: Uint8Array): Promise<Uint8Array> {
    return this.signFn(msg);
  }

  signingDidKey(): string {
    return this.holderDidKey;
  }
}
