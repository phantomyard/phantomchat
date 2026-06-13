import {describe, it, expect} from 'vitest';
import {encryptFile, decryptFile, bytesToHex, hexToBytes} from '@lib/nostra/file-crypto';

describe('file-crypto', () => {
  it('round-trips encrypt/decrypt', async() => {
    const plaintext = new TextEncoder().encode('hello nostra');
    const blob = new Blob([plaintext], {type: 'text/plain'});
    const {ciphertext, keyHex, ivHex, sha256Hex} = await encryptFile(blob);

    expect(keyHex).toHaveLength(64);
    expect(ivHex).toHaveLength(24);
    expect(sha256Hex).toHaveLength(64);
    expect(ciphertext.size).toBeGreaterThan(plaintext.byteLength); // GCM tag adds 16 bytes

    const ctBytes = new Uint8Array(await ciphertext.arrayBuffer());
    const decrypted = await decryptFile(ctBytes, keyHex, ivHex);
    const decryptedText = new TextDecoder().decode(new Uint8Array(await decrypted.arrayBuffer()));
    expect(decryptedText).toBe('hello nostra');
  });

  it('produces a different key+iv on every call', async() => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const a = await encryptFile(blob);
    const b = await encryptFile(blob);
    expect(a.keyHex).not.toBe(b.keyHex);
    expect(a.ivHex).not.toBe(b.ivHex);
  });

  it('sha256Hex is the hash of the ciphertext, not the plaintext', async() => {
    const plaintextBytes = new Uint8Array([10, 20, 30, 40]);
    const blob = new Blob([plaintextBytes]);
    const {ciphertext, sha256Hex} = await encryptFile(blob);

    const ctBytes = new Uint8Array(await ciphertext.arrayBuffer());
    const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', ctBytes));
    expect(sha256Hex).toBe(bytesToHex(expected));
  });

  it('hex helpers round-trip', () => {
    const bytes = new Uint8Array([0, 15, 16, 255]);
    expect(bytesToHex(bytes)).toBe('000f10ff');
    expect(hexToBytes('000f10ff')).toEqual(bytes);
  });

  it('decryptFile throws on tampered ciphertext', async() => {
    const blob = new Blob([new Uint8Array([1, 2, 3])]);
    const {ciphertext, keyHex, ivHex} = await encryptFile(blob);
    const bytes = new Uint8Array(await ciphertext.arrayBuffer());
    bytes[0] ^= 0xff;
    await expect(decryptFile(bytes, keyHex, ivHex)).rejects.toThrow();
  });
});
