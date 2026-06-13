/*
 * Guards the build-time invariant: UPDATE_SIGNING_KEY (CI secret) must
 * derive to the pubkey baked in trusted-pubkey.generated.ts. If they
 * disagree, no client can verify the produced .sig — exactly the silent
 * failure mode that left v0.18.0 → v0.18.2 unable to probe for updates.
 *
 * `assertSigningKeyMatchesBaked` is called from sign-update-manifest.ts
 * before any signature is written, so CI fails loudly on mismatch.
 */
import {describe, it, expect} from 'vitest';
import * as ed from '@noble/ed25519';
import {sha512} from '@noble/hashes/sha2.js';
import {assertSigningKeyMatchesBaked, derivePubkeyB64} from '@/scripts/build/verify-signing-key';

ed.hashes.sha512 = sha512;

async function makeKeypair(): Promise<{priv: Uint8Array; pubB64: string}> {
  const priv = ed.utils.randomSecretKey();
  const pubB64 = await derivePubkeyB64(priv);
  return {priv, pubB64};
}

describe('assertSigningKeyMatchesBaked', () => {
  it('passes when the private key derives to the expected baked pubkey', async() => {
    const {priv, pubB64} = await makeKeypair();
    await expect(assertSigningKeyMatchesBaked(priv, pubB64)).resolves.toBeUndefined();
  });

  it('throws with an actionable message when keys mismatch', async() => {
    const {priv} = await makeKeypair();
    const {pubB64: otherPub} = await makeKeypair();

    await expect(assertSigningKeyMatchesBaked(priv, otherPub)).rejects.toThrow(
      /Signing key mismatch/
    );
  });

  it('throws with both the derived and expected pubkeys in the message', async() => {
    const {priv, pubB64: derived} = await makeKeypair();
    const {pubB64: expected} = await makeKeypair();

    try {
      await assertSigningKeyMatchesBaked(priv, expected);
      throw new Error('should have thrown');
    } catch(err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain(derived);
      expect(msg).toContain(expected);
    }
  });
});

describe('derivePubkeyB64', () => {
  it('returns a base64 string of 44 chars for a 32-byte private key', async() => {
    const priv = ed.utils.randomSecretKey();
    const pubB64 = await derivePubkeyB64(priv);
    expect(pubB64).toHaveLength(44);
    expect(() => Buffer.from(pubB64, 'base64')).not.toThrow();
    expect(Buffer.from(pubB64, 'base64')).toHaveLength(32);
  });

  it('is deterministic for the same private key', async() => {
    const priv = ed.utils.randomSecretKey();
    const a = await derivePubkeyB64(priv);
    const b = await derivePubkeyB64(priv);
    expect(a).toBe(b);
  });
});
