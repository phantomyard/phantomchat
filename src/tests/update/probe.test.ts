import {describe, it, expect, beforeAll, vi} from 'vitest';
import * as ed from '@noble/ed25519';
import {sha512} from '@noble/hashes/sha2.js';
import {bytesToBase64} from '@lib/update/signing/verify';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
});

async function makeSignedManifest(priv: Uint8Array, version = '0.13.0') {
  const manifest: any = {schemaVersion: 2, version, gitSha: 'aaa', published: '2026-01-01', swUrl: './sw.js', signingKeyFingerprint: 'ed25519:x', securityRelease: false, securityRollback: false, bundleHashes: {}, changelog: '', alternateSources: {}, rotation: null};
  const bytes = new TextEncoder().encode(JSON.stringify(manifest));
  const sig = await ed.signAsync(bytes, priv);
  return {json: JSON.stringify(manifest), sig: bytesToBase64(sig)};
}

describe('probe', () => {
  it('rejects manifest with invalid signature', async () => {
    const {probe} = await import('@lib/update/probe');
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const wrongPriv = ed.utils.randomSecretKey();
    const m = await makeSignedManifest(wrongPriv);
    global.fetch = vi.fn(async(url: string) => {
      if(url.endsWith('.sig')) return new Response(m.sig);
      return new Response(m.json);
    }) as any;
    const res = await probe(bytesToBase64(pub));
    expect(res.outcome).toBe('invalid-signature');
  });

  it('accepts manifest with valid signature from baked pubkey', async () => {
    const {probe} = await import('@lib/update/probe');
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const m = await makeSignedManifest(priv);
    global.fetch = vi.fn(async(url: string) => {
      if(url.endsWith('.sig')) return new Response(m.sig);
      return new Response(m.json);
    }) as any;
    const res = await probe(bytesToBase64(pub));
    expect(res.outcome).toBe('update-available');
    expect(res.manifest?.version).toBe('0.13.0');
  });

  it('returns outcome=up-to-date when version matches active', async () => {
    const {probe} = await import('@lib/update/probe');
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const m = await makeSignedManifest(priv, '0.13.0');
    global.fetch = vi.fn(async(url: string) => {
      if(url.endsWith('.sig')) return new Response(m.sig);
      return new Response(m.json);
    }) as any;
    const res = await probe(bytesToBase64(pub), '0.13.0');
    expect(res.outcome).toBe('up-to-date');
  });

  it('rejects downgrade (newVersion < activeVersion without securityRollback)', async () => {
    const {probe} = await import('@lib/update/probe');
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const m = await makeSignedManifest(priv, '0.10.0');
    global.fetch = vi.fn(async(url: string) => {
      if(url.endsWith('.sig')) return new Response(m.sig);
      return new Response(m.json);
    }) as any;
    const res = await probe(bytesToBase64(pub), '0.13.0');
    expect(res.outcome).toBe('downgrade-rejected');
  });
});
