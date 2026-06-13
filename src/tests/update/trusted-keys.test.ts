import {describe, it, expect, beforeAll} from 'vitest';
import * as ed from '@noble/ed25519';
import {sha512} from '@noble/hashes/sha2.js';
import {verifyCrossCert, type RotationSpec} from '@lib/update/signing/trusted-keys';
import {bytesToBase64} from '@lib/update/signing/verify';

beforeAll(() => {
  ed.hashes.sha512 = sha512;
});

describe('verifyCrossCert', () => {
  it('accepts a valid cross-cert (new pubkey signed by old priv)', async() => {
    const oldPriv = ed.utils.randomSecretKey();
    const oldPub = await ed.getPublicKeyAsync(oldPriv);
    const newPriv = ed.utils.randomSecretKey();
    const newPub = await ed.getPublicKeyAsync(newPriv);
    const sig = await ed.signAsync(newPub, oldPriv);
    const rot: RotationSpec = {
      newPubkey: bytesToBase64(newPub),
      newFingerprint: 'ed25519:xxx',
      crossCertSig: bytesToBase64(sig)
    };
    const ok = await verifyCrossCert(rot, bytesToBase64(oldPub));
    expect(ok).toBe(true);
  });

  it('rejects a cross-cert signed by wrong key', async() => {
    const oldPriv = ed.utils.randomSecretKey();
    const oldPub = await ed.getPublicKeyAsync(oldPriv);
    const evilPriv = ed.utils.randomSecretKey();
    const newPriv = ed.utils.randomSecretKey();
    const newPub = await ed.getPublicKeyAsync(newPriv);
    const sig = await ed.signAsync(newPub, evilPriv);
    const rot: RotationSpec = {
      newPubkey: bytesToBase64(newPub),
      newFingerprint: 'ed25519:xxx',
      crossCertSig: bytesToBase64(sig)
    };
    const ok = await verifyCrossCert(rot, bytesToBase64(oldPub));
    expect(ok).toBe(false);
  });

  it('rejects malformed rotation spec', async() => {
    const oldPriv = ed.utils.randomSecretKey();
    const oldPub = await ed.getPublicKeyAsync(oldPriv);
    const rot: RotationSpec = {
      newPubkey: '!!!bad',
      newFingerprint: 'ed25519:xxx',
      crossCertSig: '!!!bad'
    };
    const ok = await verifyCrossCert(rot, bytesToBase64(oldPub));
    expect(ok).toBe(false);
  });
});
