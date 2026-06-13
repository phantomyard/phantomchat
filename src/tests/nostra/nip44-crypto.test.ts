import {describe, it, expect} from 'vitest';
import {
  nip44Encrypt,
  nip44Decrypt,
  getConversationKey,
  createRumor,
  createSeal,
  createGiftWrap,
  unwrapGiftWrap,
  clearConversationKeyCache
} from '@lib/nostra/nostr-crypto';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {bytesToHex} from 'nostr-tools/utils';

describe('nostr-crypto', () => {
  const sk1 = generateSecretKey();
  const pk1 = getPublicKey(sk1);
  const sk2 = generateSecretKey();
  const pk2 = getPublicKey(sk2);

  describe('NIP-44 encrypt/decrypt', () => {
    it('roundtrip returns original plaintext', () => {
      const convKey = getConversationKey(sk1, pk2);
      const ciphertext = nip44Encrypt('hello world', convKey);
      const plaintext = nip44Decrypt(ciphertext, convKey);
      expect(plaintext).toBe('hello world');
    });

    it('recipient can decrypt with their own key', () => {
      const convKeySender = getConversationKey(sk1, pk2);
      const convKeyRecipient = getConversationKey(sk2, pk1);
      const ciphertext = nip44Encrypt('secret message', convKeySender);
      const plaintext = nip44Decrypt(ciphertext, convKeyRecipient);
      expect(plaintext).toBe('secret message');
    });

    it('handles unicode content', () => {
      const convKey = getConversationKey(sk1, pk2);
      const msg = 'Ciao mondo! Emoji test...';
      const ct = nip44Encrypt(msg, convKey);
      expect(nip44Decrypt(ct, convKey)).toBe(msg);
    });
  });

  describe('getConversationKey', () => {
    it('returns same key for same sender/recipient pair', () => {
      clearConversationKeyCache();
      const key1 = getConversationKey(sk1, pk2);
      const key2 = getConversationKey(sk1, pk2);
      expect(key1).toEqual(key2);
    });

    it('returns Uint8Array of length 32', () => {
      const key = getConversationKey(sk1, pk2);
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });
  });

  describe('NIP-17 gift-wrap', () => {
    it('createRumor produces kind 14 event with content and pubkey', () => {
      const rumor = createRumor('hello', sk1);
      expect(rumor.kind).toBe(14);
      expect(rumor.content).toBe('hello');
      expect(rumor.pubkey).toBe(pk1);
      expect(rumor.id).toBeDefined();
      expect((rumor as any).sig).toBeUndefined();
    });

    it('createRumor accepts custom tags', () => {
      const rumor = createRumor('hello', sk1, [['p', pk2]]);
      expect(rumor.tags).toContainEqual(['p', pk2]);
    });

    it('createSeal produces kind 13 signed event with encrypted content', () => {
      const rumor = createRumor('hello', sk1);
      const seal = createSeal(rumor, sk1, pk2);
      expect(seal.kind).toBe(13);
      expect(seal.sig).toBeDefined();
      expect(seal.pubkey).toBe(pk1);
      // Content should be encrypted (not plaintext JSON)
      expect(() => JSON.parse(seal.content)).toThrow();
    });

    it('createSeal has randomized created_at within past 48h', () => {
      const rumor = createRumor('hello', sk1);
      const seal = createSeal(rumor, sk1, pk2);
      const now = Math.floor(Date.now() / 1000);
      const twoDaysAgo = now - 48 * 60 * 60;
      expect(seal.created_at).toBeGreaterThanOrEqual(twoDaysAgo);
      expect(seal.created_at).toBeLessThanOrEqual(now);
    });

    it('createGiftWrap produces kind 1059 event with p tag', () => {
      const rumor = createRumor('hello', sk1);
      const seal = createSeal(rumor, sk1, pk2);
      const wrap = createGiftWrap(seal, pk2);
      expect(wrap.kind).toBe(1059);
      expect(wrap.tags).toContainEqual(['p', pk2]);
      expect(wrap.sig).toBeDefined();
      // Pubkey should be ephemeral (not sender)
      expect(wrap.pubkey).not.toBe(pk1);
    });

    it('unwrapGiftWrap recovers original rumor', () => {
      const rumor = createRumor('secret message', sk1, [['p', pk2]]);
      const seal = createSeal(rumor, sk1, pk2);
      const wrap = createGiftWrap(seal, pk2);
      const unwrapped = unwrapGiftWrap(wrap, sk2);
      expect(unwrapped.rumor.content).toBe('secret message');
      expect(unwrapped.rumor.kind).toBe(14);
      expect(unwrapped.seal.kind).toBe(13);
      expect(unwrapped.seal.pubkey).toBe(pk1);
    });

    it('full gift-wrap chain works end to end', () => {
      const message = 'This is a private message via NIP-17';
      const rumor = createRumor(message, sk1, [['p', pk2]]);
      const seal = createSeal(rumor, sk1, pk2);
      const wrap = createGiftWrap(seal, pk2);

      // Recipient unwraps
      const unwrapped = unwrapGiftWrap(wrap, sk2);
      expect(unwrapped.rumor.content).toBe(message);
      expect(unwrapped.rumor.pubkey).toBe(pk1);
    });
  });
});
