import { Secp256k1Keypair } from '@atproto/crypto';
import type { Keypair } from '@atproto/crypto';
import { signCommit, cidForRecord } from '@atproto/repo';
import type { Commit } from '@atproto/repo';
import type { DidDocument } from '../src/identity/didweb.js';

export const TEST_ENDPOINT = 'https://pds.test.example';

/** Format a keypair's public key as a `publicKeyMultibase` Multikey string. */
export async function multikeyFor(kp: Keypair): Promise<string> {
  // A did:key is `did:key:<multikey>`; the Multikey is exactly that suffix.
  return kp.did().slice('did:key:'.length);
}

/** Build a valid atproto did.json for `did`, signed-key material from `kp`. */
export async function makeDidDoc(
  did: string,
  kp: Keypair,
  opts: {
    endpoint?: string;
    handle?: string;
    overrides?: Partial<DidDocument>;
  } = {},
): Promise<DidDocument> {
  const multikey = await multikeyFor(kp);
  const doc: DidDocument = {
    id: did,
    alsoKnownAs: [`at://${opts.handle ?? 'node.test.example'}`],
    verificationMethod: [
      {
        id: `${did}#atproto`,
        type: 'Multikey',
        controller: did,
        publicKeyMultibase: multikey,
      },
    ],
    service: [
      {
        id: `${did}#atproto_pds`,
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: opts.endpoint ?? TEST_ENDPOINT,
      },
    ],
    ...opts.overrides,
  };
  return doc;
}

/** Build and sign a real v3 commit for `did` using `kp`. */
export async function makeSignedCommit(
  did: string,
  kp: Keypair,
  record: Record<string, unknown> = { hello: 'world' },
): Promise<Commit> {
  const dataCid = await cidForRecord(record);
  const unsigned = {
    did,
    version: 3 as const,
    data: dataCid,
    rev: '3lqtest000000',
    prev: null,
  };
  return signCommit(unsigned, kp);
}

/** Create a fresh exportable secp256k1 keypair. */
export function newKeypair(): Promise<Secp256k1Keypair> {
  return Secp256k1Keypair.create({ exportable: true });
}

export type { Keypair };
