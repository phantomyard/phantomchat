/**
 * Build-time guard: the UPDATE_SIGNING_KEY used by CI must derive to the
 * pubkey baked in trusted-pubkey.generated.ts. If these drift apart, every
 * client ships with a pubkey that cannot verify the manifests the server
 * signs — the exact silent failure that froze the v0.18.x update flow.
 */
import * as ed from '@noble/ed25519';
import {sha512} from '@noble/hashes/sha2.js';

ed.hashes.sha512 = sha512;

export async function derivePubkeyB64(priv: Uint8Array): Promise<string> {
  const pub = await ed.getPublicKeyAsync(priv);
  return Buffer.from(pub).toString('base64');
}

export async function assertSigningKeyMatchesBaked(
  priv: Uint8Array,
  expectedPubB64: string
): Promise<void> {
  const derived = await derivePubkeyB64(priv);
  if(derived === expectedPubB64) return;
  throw new Error(
    'Signing key mismatch: UPDATE_SIGNING_KEY derives pubkey ' +
    `"${derived}" but trusted-pubkey.generated.ts has "${expectedPubB64}". ` +
    'Either the baked file was overwritten accidentally (revert it) or a legitimate ' +
    'key rotation happened — in that case, regenerate via `pnpm gen-signing-key` ' +
    'AND update the UPDATE_SIGNING_KEY GitHub Actions secret in the same release.'
  );
}
