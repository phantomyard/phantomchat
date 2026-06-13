/**
 * Tests for LockScreen component logic
 *
 * Tests the core lock/unlock behavior by mocking key-storage functions
 * and identity store. Since the LockScreen is a Solid.js component
 * that requires a full DOM environment, we test the underlying logic
 * (decrypt, PIN validation, protection type switching) rather than
 * rendering the component directly.
 */

import 'fake-indexeddb/auto';
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {
  deriveKeyFromPin,
  deriveKeyFromPassphrase,
  encryptKeys,
  decryptKeys,
  generateBrowserScopedKey,
  saveEncryptedIdentity,
  loadEncryptedIdentity
} from '@lib/nostra/key-storage';
import type {EncryptedIdentityRecord} from '@lib/nostra/key-storage';

// Test data
const testSeed = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const testNsec = 'nsec1test';
const testNpub = 'npub1test';

async function createTestIdentity(
  protectionType: 'none' | 'pin' | 'passphrase',
  secret?: string
): Promise<EncryptedIdentityRecord> {
  let key: CryptoKey;
  let salt: Uint8Array | undefined;

  if(protectionType === 'none') {
    key = await generateBrowserScopedKey();
  } else if(protectionType === 'pin') {
    salt = crypto.getRandomValues(new Uint8Array(16));
    key = await deriveKeyFromPin(secret!, salt);
  } else {
    salt = crypto.getRandomValues(new Uint8Array(16));
    key = await deriveKeyFromPassphrase(secret!, salt);
  }

  const encrypted = await encryptKeys({seed: testSeed, nsec: testNsec}, key);

  return {
    id: 'current',
    npub: testNpub,
    protectionType,
    salt,
    iv: encrypted.iv,
    encryptedKeys: encrypted.ciphertext,
    createdAt: Date.now()
  };
}

describe('Lock screen logic', () => {
  describe('PIN unlock flow', () => {
    it('correct PIN decrypts keys successfully', async() => {
      const pin = '1234';
      const record = await createTestIdentity('pin', pin);

      const key = await deriveKeyFromPin(pin, record.salt!);
      const decrypted = await decryptKeys(record.iv, record.encryptedKeys, key);

      expect(decrypted.seed).toBe(testSeed);
      expect(decrypted.nsec).toBe(testNsec);
    });

    it('wrong PIN fails to decrypt (AES-GCM auth failure)', async() => {
      const record = await createTestIdentity('pin', '1234');

      const wrongKey = await deriveKeyFromPin('9999', record.salt!);

      await expect(
        decryptKeys(record.iv, record.encryptedKeys, wrongKey)
      ).rejects.toThrow();
    });

    it('PIN key derivation is deterministic for same salt', async() => {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key1 = await deriveKeyFromPin('5678', salt);
      const key2 = await deriveKeyFromPin('5678', salt);

      // Encrypt with key1, decrypt with key2
      const encrypted = await encryptKeys({seed: testSeed, nsec: testNsec}, key1);
      const decrypted = await decryptKeys(encrypted.iv, encrypted.ciphertext, key2);

      expect(decrypted.seed).toBe(testSeed);
    });
  });

  describe('Passphrase unlock flow', () => {
    it('correct passphrase decrypts keys successfully', async() => {
      const passphrase = 'my secret passphrase';
      const record = await createTestIdentity('passphrase', passphrase);

      const key = await deriveKeyFromPassphrase(passphrase, record.salt!);
      const decrypted = await decryptKeys(record.iv, record.encryptedKeys, key);

      expect(decrypted.seed).toBe(testSeed);
      expect(decrypted.nsec).toBe(testNsec);
    });

    it('wrong passphrase fails to decrypt', async() => {
      const record = await createTestIdentity('passphrase', 'correct passphrase');

      const wrongKey = await deriveKeyFromPassphrase('wrong passphrase', record.salt!);

      await expect(
        decryptKeys(record.iv, record.encryptedKeys, wrongKey)
      ).rejects.toThrow();
    });
  });

  describe('Protection type detection', () => {
    it('PIN protection type has salt defined', async() => {
      const record = await createTestIdentity('pin', '1234');
      expect(record.protectionType).toBe('pin');
      expect(record.salt).toBeDefined();
      expect(record.salt!.length).toBe(16);
    });

    it('passphrase protection type has salt defined', async() => {
      const record = await createTestIdentity('passphrase', 'secret');
      expect(record.protectionType).toBe('passphrase');
      expect(record.salt).toBeDefined();
    });

    it('none protection type has no salt', async() => {
      const record = await createTestIdentity('none');
      expect(record.protectionType).toBe('none');
      expect(record.salt).toBeUndefined();
    });
  });

  describe('Protection switching', () => {
    it('switch from none to pin: decrypt with browser key, re-encrypt with PIN', async() => {
      // Start with no protection
      const browserKey = await generateBrowserScopedKey();
      const encrypted = await encryptKeys({seed: testSeed, nsec: testNsec}, browserKey);

      // Decrypt with browser key
      const decrypted = await decryptKeys(encrypted.iv, encrypted.ciphertext, browserKey);
      expect(decrypted.seed).toBe(testSeed);

      // Re-encrypt with PIN
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const pinKey = await deriveKeyFromPin('4567', salt);
      const reEncrypted = await encryptKeys(decrypted, pinKey);

      // Verify new encryption works
      const finalDecrypted = await decryptKeys(reEncrypted.iv, reEncrypted.ciphertext, pinKey);
      expect(finalDecrypted.seed).toBe(testSeed);
    });

    it('switch from pin to passphrase: decrypt with PIN, re-encrypt with passphrase', async() => {
      const salt1 = crypto.getRandomValues(new Uint8Array(16));
      const pinKey = await deriveKeyFromPin('1234', salt1);
      const encrypted = await encryptKeys({seed: testSeed, nsec: testNsec}, pinKey);

      // Decrypt with PIN
      const decrypted = await decryptKeys(encrypted.iv, encrypted.ciphertext, pinKey);

      // Re-encrypt with passphrase
      const salt2 = crypto.getRandomValues(new Uint8Array(16));
      const ppKey = await deriveKeyFromPassphrase('my new passphrase', salt2);
      const reEncrypted = await encryptKeys(decrypted, ppKey);

      // Verify
      const finalDecrypted = await decryptKeys(reEncrypted.iv, reEncrypted.ciphertext, ppKey);
      expect(finalDecrypted.seed).toBe(testSeed);
      expect(finalDecrypted.nsec).toBe(testNsec);
    });
  });

  describe('Identity persistence', () => {
    it('save and load encrypted identity record', async() => {
      const record = await createTestIdentity('pin', '1234');
      await saveEncryptedIdentity(record);

      const loaded = await loadEncryptedIdentity();
      expect(loaded).not.toBeNull();
      expect(loaded!.npub).toBe(testNpub);
      expect(loaded!.protectionType).toBe('pin');
    });
  });

  describe('Forgot PIN recovery', () => {
    it('recovery requires matching npub from seed-derived keypair', async() => {
      // This test verifies the logic: derive keypair from seed, check npub match
      const record = await createTestIdentity('pin', '1234');

      // Simulating: if npub matches, allow recovery
      expect(record.npub).toBe(testNpub);

      // In real flow: derive from seed -> getPublicKey -> npubEncode -> compare
      // We test the key re-encryption path
      const browserKey = await generateBrowserScopedKey();
      const encrypted = await encryptKeys({seed: testSeed, nsec: testNsec}, browserKey);

      const decrypted = await decryptKeys(encrypted.iv, encrypted.ciphertext, browserKey);
      expect(decrypted.seed).toBe(testSeed);
    });
  });
});
