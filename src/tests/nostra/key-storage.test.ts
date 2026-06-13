import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach} from 'vitest';
import {
  generateBrowserScopedKey,
  deriveKeyFromPin,
  deriveKeyFromPassphrase,
  encryptKeys,
  decryptKeys,
  saveEncryptedIdentity,
  loadEncryptedIdentity,
  deleteEncryptedIdentity
} from '@lib/nostra/key-storage';

describe('key-storage', () => {
  describe('generateBrowserScopedKey', () => {
    it('returns a CryptoKey', async() => {
      const key = await generateBrowserScopedKey();
      expect(key).toBeInstanceOf(CryptoKey);
    });

    it('returns a non-exportable key', async() => {
      const key = await generateBrowserScopedKey();
      expect(key.extractable).toBe(false);
    });

    it('key supports encrypt and decrypt', async() => {
      const key = await generateBrowserScopedKey();
      expect(key.usages).toContain('encrypt');
      expect(key.usages).toContain('decrypt');
    });
  });

  describe('deriveKeyFromPin', () => {
    it('returns a CryptoKey derived via PBKDF2', async() => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKeyFromPin('1234', salt);
      expect(key).toBeInstanceOf(CryptoKey);
    });

    it('produces deterministic key for same pin and salt', async() => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key1 = await deriveKeyFromPin('1234', salt);
      const key2 = await deriveKeyFromPin('1234', salt);
      // Encrypt same data with both keys, results should decrypt with either
      const testData = {seed: 'test seed', nsec: 'nsec1test'};
      const encrypted = await encryptKeys(testData, key1);
      const decrypted = await decryptKeys(encrypted.iv, encrypted.ciphertext, key2);
      expect(decrypted).toEqual(testData);
    });
  });

  describe('deriveKeyFromPassphrase', () => {
    it('returns a CryptoKey via PBKDF2', async() => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKeyFromPassphrase('mypassword', salt);
      expect(key).toBeInstanceOf(CryptoKey);
    });
  });

  describe('encryptKeys / decryptKeys', () => {
    it('roundtrip returns original data', async() => {
      const key = await generateBrowserScopedKey();
      const data = {seed: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', nsec: 'nsec1abc123'};
      const {iv, ciphertext} = await encryptKeys(data, key);
      const result = await decryptKeys(iv, ciphertext, key);
      expect(result).toEqual(data);
    });

    it('wrong key throws on decrypt', async() => {
      const key1 = await generateBrowserScopedKey();
      const key2 = await generateBrowserScopedKey();
      const data = {seed: 'test seed', nsec: 'nsec1test'};
      const {iv, ciphertext} = await encryptKeys(data, key1);
      await expect(decryptKeys(iv, ciphertext, key2)).rejects.toThrow();
    });

    it('iv is a Uint8Array of length 12', async() => {
      const key = await generateBrowserScopedKey();
      const data = {seed: 'test', nsec: 'nsec1test'};
      const {iv} = await encryptKeys(data, key);
      expect(iv).toBeInstanceOf(Uint8Array);
      expect(iv.length).toBe(12);
    });
  });

  describe('IndexedDB storage', () => {
    beforeEach(async() => {
      await deleteEncryptedIdentity();
    });

    it('saveEncryptedIdentity and loadEncryptedIdentity roundtrip', async() => {
      const key = await generateBrowserScopedKey();
      const data = {seed: 'test seed phrase', nsec: 'nsec1test'};
      const {iv, ciphertext} = await encryptKeys(data, key);

      const record = {
        id: 'current' as const,
        npub: 'npub1test',
        protectionType: 'none' as const,
        iv,
        encryptedKeys: ciphertext,
        createdAt: Date.now()
      };

      await saveEncryptedIdentity(record);
      const loaded = await loadEncryptedIdentity();
      expect(loaded).not.toBeNull();
      expect(loaded!.npub).toBe('npub1test');
      expect(loaded!.protectionType).toBe('none');
    });

    it('loadEncryptedIdentity returns null when nothing stored', async() => {
      const result = await loadEncryptedIdentity();
      expect(result).toBeNull();
    });

    it('deleteEncryptedIdentity removes stored data', async() => {
      const key = await generateBrowserScopedKey();
      const data = {seed: 'test', nsec: 'nsec1test'};
      const {iv, ciphertext} = await encryptKeys(data, key);

      await saveEncryptedIdentity({
        id: 'current',
        npub: 'npub1test',
        protectionType: 'none' as const,
        iv,
        encryptedKeys: ciphertext,
        createdAt: Date.now()
      });

      await deleteEncryptedIdentity();
      const result = await loadEncryptedIdentity();
      expect(result).toBeNull();
    });

    it('full roundtrip: generate key -> encrypt -> store -> load -> decrypt', async() => {
      const key = await generateBrowserScopedKey();
      const originalData = {seed: 'leader monkey parrot ring guide accident before fence cannon height naive bean', nsec: 'nsec1xyz'};
      const {iv, ciphertext} = await encryptKeys(originalData, key);

      await saveEncryptedIdentity({
        id: 'current',
        npub: 'npub1full',
        protectionType: 'none' as const,
        iv,
        encryptedKeys: ciphertext,
        createdAt: Date.now()
      });

      const loaded = await loadEncryptedIdentity();
      expect(loaded).not.toBeNull();

      const decrypted = await decryptKeys(loaded!.iv, loaded!.encryptedKeys, key);
      expect(decrypted).toEqual(originalData);
    });
  });
});
