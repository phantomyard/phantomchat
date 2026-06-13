import {describe, it, expect, beforeAll} from 'vitest';
import * as ed from '@noble/ed25519';
import {sha512} from '@noble/hashes/sha2.js';
import {verifyDetachedSignature, fingerprintPubkey, base64ToBytes, bytesToBase64} from '@lib/update/signing/verify';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
});

describe('verifyDetachedSignature', () => {
  it('accepts a valid signature', async () => {
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const msg = new TextEncoder().encode('{"version":"1.0.0"}');
    const sig = await ed.signAsync(msg, priv);
    const ok = await verifyDetachedSignature(msg, bytesToBase64(sig), bytesToBase64(pub));
    expect(ok).toBe(true);
  });

  it('rejects a tampered message', async () => {
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const msg = new TextEncoder().encode('{"version":"1.0.0"}');
    const tampered = new TextEncoder().encode('{"version":"9.9.9"}');
    const sig = await ed.signAsync(msg, priv);
    const ok = await verifyDetachedSignature(tampered, bytesToBase64(sig), bytesToBase64(pub));
    expect(ok).toBe(false);
  });

  it('rejects a signature from a different key', async () => {
    const priv1 = ed.utils.randomSecretKey();
    const priv2 = ed.utils.randomSecretKey();
    const pub2 = await ed.getPublicKeyAsync(priv2);
    const msg = new TextEncoder().encode('data');
    const sig = await ed.signAsync(msg, priv1);
    const ok = await verifyDetachedSignature(msg, bytesToBase64(sig), bytesToBase64(pub2));
    expect(ok).toBe(false);
  });

  it('rejects malformed base64', async () => {
    const msg = new TextEncoder().encode('data');
    const ok = await verifyDetachedSignature(msg, '!!!not-base64!!!', 'also-not-base64');
    expect(ok).toBe(false);
  });
});

describe('fingerprintPubkey', () => {
  it('produces a stable 16-char hex fingerprint prefixed with ed25519:', async () => {
    const priv = ed.utils.randomSecretKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const fp = fingerprintPubkey(bytesToBase64(pub));
    expect(fp).toMatch(/^ed25519:[0-9a-f]{16}$/);
  });
});
