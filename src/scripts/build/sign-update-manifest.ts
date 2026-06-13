#!/usr/bin/env tsx
/**
 * Signs dist/update-manifest.json with Ed25519, producing dist/update-manifest.json.sig.
 * Reads private key from UPDATE_SIGNING_KEY env var (base64-encoded 32-byte seed).
 * Intended for CI; fail loudly if key not present.
 */
import {readFileSync, writeFileSync} from 'fs';
import {join} from 'path';
import * as ed from '@noble/ed25519';
import {sha512} from '@noble/hashes/sha2.js';
import {assertSigningKeyMatchesBaked} from './verify-signing-key';
import {TRUSTED_PUBKEY_B64} from '../../lib/update/signing/trusted-pubkey.generated';

ed.hashes.sha512 = sha512;

async function main() {
  const keyB64 = process.env.UPDATE_SIGNING_KEY;
  if(!keyB64 || keyB64.length === 0) {
    console.error('UPDATE_SIGNING_KEY env var not set — refusing to produce empty signature.');
    process.exit(1);
  }
  const priv = Uint8Array.from(Buffer.from(keyB64, 'base64'));
  if(priv.length !== 32) {
    console.error(`UPDATE_SIGNING_KEY must decode to 32 bytes, got ${priv.length}`);
    process.exit(1);
  }

  // Guard: the CI key must derive to the pubkey baked into the shipping
  // bundle. A mismatch here means clients will silently reject every
  // signed manifest — detect at release time, not months later in prod.
  await assertSigningKeyMatchesBaked(priv, TRUSTED_PUBKEY_B64);

  const manifestPath = join('dist', 'update-manifest.json');
  const sigPath = join('dist', 'update-manifest.json.sig');
  const manifestBytes = readFileSync(manifestPath);
  const sig = await ed.signAsync(manifestBytes as unknown as Uint8Array, priv);
  writeFileSync(sigPath, Buffer.from(sig).toString('base64'));
  console.log(`Signed ${manifestPath} → ${sigPath} (64-byte Ed25519)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
