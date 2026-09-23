import { Secp256k1Keypair, formatMultikey, parseMultikey } from '@atproto/crypto';
import type { Keypair } from '@atproto/crypto';
import { LocalKeyCommitSigner, type CommitSigner } from './commit-signer.js';
import { log } from '../log.js';

/**
 * The PDS's own signing key (pull-pds-spec.md §10; env `PDS_SIGNING_KEY`, with
 * the legacy `AGG_SIGNING_KEY` still honoured as a deprecated alias).
 *
 * Under the pull-PDS model the PDS signs every commit with its own key, and
 * that key's public half is what each publisher advertises as its did.json
 * `#atproto` (spec §2.1). So we need, for one key:
 *   - a `CommitSigner` to sign commit bytes (via LocalKeyCommitSigner),
 *   - the `did:key` (recorded on each stored commit),
 *   - the `publicKeyMultibase` (published in the descriptor + expected in docs).
 *
 * KEY_MODE:
 *   - `shared` (spec default): one key signs every repo. Cheapest onboarding,
 *     but see FINDINGS F-D3 - the PDS can forge into any repo.
 * Per-publisher keys are not implemented; unsupported modes fail at boot.
 */
export interface PdsKey {
  signer: CommitSigner;
  didKey: string;
  /** `publicKeyMultibase` - the `z...` form for did.json `#atproto`. */
  publicKeyMultibase: string;
  jwtAlg: string;
}

/** Build a PdsKey from an existing @atproto/crypto keypair. */
export function pdsKeyFromKeypair(kp: Keypair): PdsKey {
  const didKey = kp.did();
  const parsed = parseMultikey(didKey.slice('did:key:'.length));
  return {
    signer: new LocalKeyCommitSigner(kp),
    didKey,
    publicKeyMultibase: formatMultikey(parsed.jwtAlg, parsed.keyBytes),
    jwtAlg: kp.jwtAlg,
  };
}

/**
 * Load the shared PDS signing key from `PDS_SIGNING_KEY` (canonical) or the
 * legacy `AGG_SIGNING_KEY` (deprecated alias, kept for live deployments; a
 * one-line deprecation warning is logged when the old name is used). With
 * neither set, generate an ephemeral one in dev (QUESTIONS.md D1). The env
 * value is a hex-encoded secp256k1 private key (the form
 * `Secp256k1Keypair.import` accepts).
 *
 * We log the public identifiers of an ephemeral key so the experiment harness
 * can paste them into a publisher's did.json. We never log the private key.
 */
export async function loadSharedPdsKey(
  env: NodeJS.ProcessEnv = process.env,
): Promise<PdsKey> {
  const canonical = env.PDS_SIGNING_KEY?.trim();
  const legacy = env.AGG_SIGNING_KEY?.trim();
  const raw = canonical || legacy;
  let kp: Secp256k1Keypair;
  if (raw && raw.length > 0) {
    if (!canonical && legacy) {
      log.warn(
        'AGG_SIGNING_KEY is deprecated - renamed to PDS_SIGNING_KEY; the old name still works but will be removed in a future release',
      );
    }
    kp = await Secp256k1Keypair.import(raw, { exportable: true });
    log.info('loaded PDS signing key from env', { didKey: kp.did() });
  } else {
    kp = await Secp256k1Keypair.create({ exportable: true });
    const key = pdsKeyFromKeypair(kp);
    log.warn(
      'PDS_SIGNING_KEY not set - generated an EPHEMERAL dev key. Set PDS_SIGNING_KEY to persist.',
      {
        didKey: key.didKey,
        publicKeyMultibase: key.publicKeyMultibase,
      },
    );
    return key;
  }
  return pdsKeyFromKeypair(kp);
}

/** @deprecated Backwards-compat alias for the pre-rename name. Use PdsKey. */
export type AggregatorKey = PdsKey;

/** @deprecated Backwards-compat alias for the pre-rename name. Use pdsKeyFromKeypair. */
export const aggregatorKeyFromKeypair = pdsKeyFromKeypair;
