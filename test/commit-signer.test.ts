import { describe, it, expect } from 'vitest';
import { verifySignature } from '@atproto/crypto';
import {
  LocalKeyCommitSigner,
  RemoteCommitSigner,
  asKeypair,
} from '../src/repo/commit-signer.js';
import { newKeypair } from './helpers.js';

describe('CommitSigner seam', () => {
  it('LocalKeyCommitSigner signs bytes that verify against its did:key', async () => {
    const kp = await newKeypair();
    const signer = new LocalKeyCommitSigner(kp);
    const msg = new TextEncoder().encode('unsigned-commit-bytes');

    const sig = await signer.sign(msg);
    expect(signer.jwtAlg).toBe('ES256K');
    expect(signer.signingDidKey()).toBe(kp.did());
    expect(await verifySignature(signer.signingDidKey(), msg, sig)).toBe(true);
  });

  it('asKeypair adapts a signer to the @atproto/repo Keypair shape', async () => {
    const kp = await newKeypair();
    const signer = new LocalKeyCommitSigner(kp);
    const adapted = asKeypair(signer);

    expect(adapted.did()).toBe(kp.did());
    expect(adapted.jwtAlg).toBe('ES256K');
    const msg = new TextEncoder().encode('x');
    expect(await verifySignature(adapted.did(), msg, await adapted.sign(msg))).toBe(true);
  });

  it('RemoteCommitSigner delegates signing but reports the holder did:key', async () => {
    // The "remote" key stands in for the did:web holder's key living off-server.
    const holder = await newKeypair();
    let handedBytes: Uint8Array | null = null;
    const signer = new RemoteCommitSigner('ES256K', holder.did(), async (bytes) => {
      handedBytes = bytes;
      return holder.sign(bytes); // the holder signs, out of band
    });

    const msg = new TextEncoder().encode('bytes-the-server-built');
    const sig = await signer.sign(msg);

    expect(handedBytes).not.toBeNull();
    expect(signer.signingDidKey()).toBe(holder.did());
    // A signature produced remotely still verifies against the holder's did:key,
    // which is exactly what the server records alongside the commit.
    expect(await verifySignature(signer.signingDidKey(), msg, sig)).toBe(true);
  });

  it('both signer models are interchangeable at the interface', async () => {
    const kp = await newKeypair();
    const local = new LocalKeyCommitSigner(kp);
    const remote = new RemoteCommitSigner('ES256K', kp.did(), (b) => kp.sign(b));
    const msg = new TextEncoder().encode('same-bytes');

    // Same key behind both -> both signatures verify against the same did:key.
    expect(await verifySignature(local.signingDidKey(), msg, await local.sign(msg))).toBe(true);
    expect(await verifySignature(remote.signingDidKey(), msg, await remote.sign(msg))).toBe(true);
    expect(local.signingDidKey()).toBe(remote.signingDidKey());
  });
});
