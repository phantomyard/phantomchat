import {describe, it, expect} from 'vitest';
import {
  getSymmetricKey,
  encryptV2,
  decryptV2,
  wrapV2,
  unwrapV2,
  rewrapV2,
  wrapEditV2,
  wrapReceiptV2,
  isV2Event,
  isLegacyWrap,
  clearConversationKeyCache
} from '@lib/phantomchat/nostr-crypto';
import {generateSecretKey, getPublicKey, getEventHash, verifyEvent} from 'nostr-tools/pure';

describe('PhantomChat Protocol v2 (AES-256-GCM)', () => {
  // Generate fresh keys per test to avoid shared cache state
  function freshKeys() {
    const skA = generateSecretKey();
    const pkA = getPublicKey(skA);
    const skB = generateSecretKey();
    const pkB = getPublicKey(skB);
    return {skA, pkA, skB, pkB};
  }

  describe('getSymmetricKey', () => {
    it('derives same key for both parties', async() => {
      const {skA, pkA, skB, pkB} = freshKeys();
      const keyA = await getSymmetricKey(skA, pkB);
      const keyB = await getSymmetricKey(skB, pkA);
      // Both should derive the same CryptoKey (ECDH is commutative)
      const rawA = new Uint8Array(await crypto.subtle.exportKey('raw', keyA.key));
      const rawB = new Uint8Array(await crypto.subtle.exportKey('raw', keyB.key));
      expect(rawA).toEqual(rawB);
    });

    it('derives different keys for different peers', async() => {
      const {skA, pkB} = freshKeys();
      const skC = generateSecretKey();
      const pkC = getPublicKey(skC);
      const keyAB = await getSymmetricKey(skA, pkB);
      const keyAC = await getSymmetricKey(skA, pkC);
      const rawAB = new Uint8Array(await crypto.subtle.exportKey('raw', keyAB.key));
      const rawAC = new Uint8Array(await crypto.subtle.exportKey('raw', keyAC.key));
      expect(rawAB).not.toEqual(rawAC);
    });
  });

  describe('encryptV2 / decryptV2', () => {
    it('roundtrip returns original plaintext', async() => {
      const {skA, pkB} = freshKeys();
      const {key} = await getSymmetricKey(skA, pkB);
      const ciphertext = await encryptV2('hello world', key);
      const plaintext = await decryptV2(ciphertext, key);
      expect(plaintext).toBe('hello world');
    });

    it('handles unicode content', async() => {
      const {skA, pkB} = freshKeys();
      const {key} = await getSymmetricKey(skA, pkB);
      const msg = 'Ciao mondo! Emoji test... 日本語テスト';
      const ciphertext = await encryptV2(msg, key);
      const plaintext = await decryptV2(ciphertext, key);
      expect(plaintext).toBe(msg);
    });

    it('handles empty string', async() => {
      const {skA, pkB} = freshKeys();
      const {key} = await getSymmetricKey(skA, pkB);
      const ciphertext = await encryptV2('', key);
      const plaintext = await decryptV2(ciphertext, key);
      expect(plaintext).toBe('');
    });

    it('produces different ciphertext for same plaintext (random IV)', async() => {
      const {skA, pkB} = freshKeys();
      const {key} = await getSymmetricKey(skA, pkB);
      const ct1 = await encryptV2('same message', key);
      const ct2 = await encryptV2('same message', key);
      expect(ct1).not.toBe(ct2);
    });

    it('fails to decrypt with wrong key', async() => {
      const {skA, pkB} = freshKeys();
      const {key: keyA} = await getSymmetricKey(skA, pkB);
      const skC = generateSecretKey();
      const pkC = getPublicKey(skC);
      const {key: keyC} = await getSymmetricKey(skC, pkC);
      const ciphertext = await encryptV2('secret', keyA);
      await expect(decryptV2(ciphertext, keyC)).rejects.toThrow();
    });
  });

  describe('wrapV2 / unwrapV2', () => {
    it('produces kind 1059 event', async() => {
      const {skA, pkB} = freshKeys();
      const {event} = await wrapV2(skA, pkB, 'test message');
      expect(event.kind).toBe(1059);
    });

    it('event has v2 version tag', async() => {
      const {skA, pkB} = freshKeys();
      const {event} = await wrapV2(skA, pkB, 'test message');
      expect(isV2Event(event)).toBe(true);
    });

    it('event pubkey is ephemeral (not sender)', async() => {
      const {skA, pkA, pkB} = freshKeys();
      const {event} = await wrapV2(skA, pkB, 'test message');
      expect(event.pubkey).not.toBe(pkA); // ephemeral, not sender
      expect(event.pubkey).not.toBe(pkB); // not recipient either
    });

    it('recipient can unwrap', async() => {
      const {skA, skB, pkB} = freshKeys();
      const {event, rumorId} = await wrapV2(skA, pkB, 'hello from A');
      const rumor = await unwrapV2(event, skB);
      expect(rumor.content).toBe('hello from A');
      expect(rumor.kind).toBe(14);
      expect(rumor.id).toBe(rumorId);
    });

    it('returns the exact rumor hashed into rumorId, even when the outer envelope timestamp differs (retry passthrough)', async() => {
      const {skA, pkA, skB, pkB} = freshKeys();
      // wrapV2 calls Date.now() twice: once for the inner rumor's created_at
      // (which rumorId is hashed over) and once, later, for the outer envelope.
      // Force every call into a distinct second so the two timestamps differ —
      // exactly the race that broke the delivery-retry layer.
      const realDateNow = Date.now;
      let call = 0;
      Date.now = () => 1_700_000_000_000 + (call++) * 1500;
      let event, rumorId, rumor;
      try {
        ({event, rumorId, rumor} = await wrapV2(skA, pkB, 'retry passthrough'));
      } finally {
        Date.now = realDateNow;
      }

      // The returned rumor IS the object that was hashed into rumorId.
      expect(rumor).toBeDefined();
      expect(rumor.id).toBe(rumorId);
      expect(getEventHash(rumor as any)).toBe(rumorId);
      expect(rumor.pubkey).toBe(pkA); // real sender, not the ephemeral outer key

      // Regression guard: the outer envelope carries a DIFFERENT timestamp, so a
      // rumor reconstructed from event.created_at (the old bug) hashes wrong.
      expect(event.created_at).not.toBe(rumor.created_at);
      const reconstructedFromOuter = {
        kind: 14, content: 'retry passthrough', pubkey: pkA,
        created_at: event.created_at, tags: event.tags, id: rumorId
      };
      expect(getEventHash(reconstructedFromOuter as any)).not.toBe(rumorId);

      // The verbatim rumor survives a retry re-wrap and unwraps to the same id.
      const rewrapped = await rewrapV2(skA, pkB, rumor as any);
      const out = await unwrapV2(rewrapped, skB);
      expect(out.id).toBe(rumorId);
      expect(out.content).toBe('retry passthrough');
    });

    it('sender can unwrap (self-send)', async() => {
      const {skA, pkA, skB, pkB} = freshKeys();
      // Pre-derive the symmetric key so it's in cache for self-send unwrap
      await getSymmetricKey(skA, pkB);
      const {event} = await wrapV2(skA, pkB, 'self message');
      const rumor = await unwrapV2(event, skA);
      expect(rumor.content).toBe('self message');
      expect(rumor.pubkey).toBe(pkA);
    });

    it('fails with no matching key in cache', async() => {
      const {skA, pkB} = freshKeys();
      const {event} = await wrapV2(skA, pkB, 'secret');
      // Clear cache so no key is available for decryption
      clearConversationKeyCache();
      const skC = generateSecretKey();
      await expect(unwrapV2(event, skC)).rejects.toThrow();
    });

    it('includes replyTo tag when provided', async() => {
      const {skA, pkB} = freshKeys();
      const {event} = await wrapV2(skA, pkB, 'reply', {eventId: 'abc123'});
      const eTag = event.tags.find((t: string[]) => t[0] === 'e');
      expect(eTag).toBeDefined();
      expect(eTag![1]).toBe('abc123');
    });

    it('has valid Schnorr signature', async() => {
      const {skA, pkA, pkB} = freshKeys();
      const {event} = await wrapV2(skA, pkB, 'signed');
      expect(verifyEvent(event as any)).toBe(true);
    });
  });

  describe('rewrapV2', () => {
    it('produces new event with same rumor content', async() => {
      const {skA, skB, pkB} = freshKeys();
      const {event: original} = await wrapV2(skA, pkB, 'test rewrap');
      const rumor = await unwrapV2(original, skB);
      const rewrapped = await rewrapV2(skA, pkB, rumor as any);
      expect(rewrapped.kind).toBe(1059);
      expect(isV2Event(rewrapped as any)).toBe(true);
    });

    it('recipient can unwrap rewrapped event', async() => {
      const {skA, skB, pkB} = freshKeys();
      const {event: original} = await wrapV2(skA, pkB, 'original msg');
      const rumor = await unwrapV2(original, skB);
      const rewrapped = await rewrapV2(skA, pkB, rumor as any);
      const decrypted = await unwrapV2(rewrapped, skB);
      expect(decrypted.content).toBe('original msg');
      expect(decrypted.id).toBe(rumor.id);
    });

    it('different from original (fresh outer event)', async() => {
      const {skA, skB, pkB} = freshKeys();
      const {event: original} = await wrapV2(skA, pkB, 'compare');
      const rumor = await unwrapV2(original, skB);
      const rewrapped = await rewrapV2(skA, pkB, rumor as any);
      expect(rewrapped.id).not.toBe(original.id);
    });
  });

  describe('wrapEditV2', () => {
    it('produces kind 1059 with edit marker tag', async() => {
      const {skA, pkB} = freshKeys();
      const event = await wrapEditV2(skA, pkB, 'original-msg-id', 'new content');
      expect(event.kind).toBe(1059);
      expect(isV2Event(event)).toBe(true);
      const editTag = event.tags.find((t: string[]) => t[0] === 'phantomchat-edit');
      expect(editTag).toBeDefined();
      expect(editTag![1]).toBe('original-msg-id');
    });

    it('recipient can unwrap and see edit content', async() => {
      const {skA, skB, pkB} = freshKeys();
      const event = await wrapEditV2(skA, pkB, 'orig-id', 'edited text');
      const rumor = await unwrapV2(event, skB);
      expect(rumor.content).toBe('edited text');
      const editTag = rumor.tags.find((t: string[]) => t[0] === 'phantomchat-edit');
      expect(editTag![1]).toBe('orig-id');
    });
  });

  describe('wrapReceiptV2', () => {
    it('produces kind 1059 with receipt-type tag', async() => {
      const {skA, pkB} = freshKeys();
      const event = await wrapReceiptV2(skA, pkB, 'msg-event-id', 'delivery');
      expect(event.kind).toBe(1059);
      expect(isV2Event(event)).toBe(true);
      const receiptTag = event.tags.find((t: string[]) => t[0] === 'receipt-type');
      expect(receiptTag).toBeDefined();
      expect(receiptTag![1]).toBe('delivery');
    });

    it('recipient can unwrap receipt', async() => {
      const {skA, skB, pkB} = freshKeys();
      const event = await wrapReceiptV2(skA, pkB, 'msg-id', 'read');
      const rumor = await unwrapV2(event, skB);
      expect(rumor.content).toBe('');
      const receiptTag = rumor.tags.find((t: string[]) => t[0] === 'receipt-type');
      expect(receiptTag![1]).toBe('read');
    });
  });

  describe('isV2Event / isLegacyWrap', () => {
    it('identifies v2 events', async() => {
      const {skA, pkB} = freshKeys();
      const {event} = await wrapV2(skA, pkB, 'v2 test');
      expect(isV2Event(event)).toBe(true);
      expect(isLegacyWrap(event)).toBe(false);
    });

    it('identifies legacy NIP-17 events', async() => {
      const {wrapNip17Message} = await import('@lib/phantomchat/nostr-crypto');
      const {skA, pkB} = freshKeys();
      const {wraps} = wrapNip17Message(skA, pkB, 'legacy test');
      expect(isV2Event(wraps[0])).toBe(false);
      expect(isLegacyWrap(wraps[0])).toBe(true);
    });
  });

  describe('cross-party encryption', () => {
    it('A sends to B, B decrypts', async() => {
      const {skA, pkA, skB, pkB} = freshKeys();
      const {event} = await wrapV2(skA, pkB, 'message from A to B');
      const rumor = await unwrapV2(event, skB);
      expect(rumor.content).toBe('message from A to B');
      expect(rumor.pubkey).toBe(pkA);
    });

    it('B sends to A, A decrypts', async() => {
      const {skA, pkA, skB, pkB} = freshKeys();
      const {event} = await wrapV2(skB, pkA, 'message from B to A');
      const rumor = await unwrapV2(event, skA);
      expect(rumor.content).toBe('message from B to A');
      expect(rumor.pubkey).toBe(pkB);
    });

    it('simulated conversation', async() => {
      const {skA, pkA, skB, pkB} = freshKeys();

      const {event: e1} = await wrapV2(skA, pkB, 'Hey Bob!');
      const r1 = await unwrapV2(e1, skB);
      expect(r1.content).toBe('Hey Bob!');

      const {event: e2} = await wrapV2(skB, pkA, 'Hi Alice!');
      const r2 = await unwrapV2(e2, skA);
      expect(r2.content).toBe('Hi Alice!');

      const longMsg = 'This is a longer message with special chars: àáâãäå & <html> and emoji 🎉🚀';
      const {event: e3} = await wrapV2(skA, pkB, longMsg);
      const r3 = await unwrapV2(e3, skB);
      expect(r3.content).toBe(longMsg);
    });
  });

  describe('performance comparison', () => {
    it('v2 wrap is significantly faster than NIP-17', async() => {
      const iterations = 50;
      const {skA, pkB} = freshKeys();

      // Time NIP-17 wrap
      const {wrapNip17Message} = await import('@lib/phantomchat/nostr-crypto');
      const start17 = performance.now();
      for(let i = 0; i < iterations; i++) {
        wrapNip17Message(skA, pkB, `test message ${i}`);
      }
      const elapsed17 = performance.now() - start17;

      // Time v2 wrap
      const startV2 = performance.now();
      for(let i = 0; i < iterations; i++) {
        await wrapV2(skA, pkB, `test message ${i}`);
      }
      const elapsedV2 = performance.now() - startV2;

      console.log(`NIP-17: ${elapsed17.toFixed(1)}ms for ${iterations} wraps (${(elapsed17 / iterations).toFixed(2)}ms/wrap)`);
      console.log(`v2:     ${elapsedV2.toFixed(1)}ms for ${iterations} wraps (${(elapsedV2 / iterations).toFixed(2)}ms/wrap)`);
      console.log(`Speedup: ${(elapsed17 / elapsedV2).toFixed(1)}×`);

      expect(elapsedV2).toBeLessThan(elapsed17);
    });
  });

  describe('cold-cache unwrap (simulates fresh process)', () => {
    it('recipient can unwrap after pre-deriving key (warmSymmetricKeyCache)', async() => {
      const {skA, pkA, skB, pkB} = freshKeys();
      // Sender wraps (populates sender's cache)
      const {event} = await wrapV2(skA, pkB, 'cold cache msg');
      // Clear all caches (simulates bot restart / new browser tab)
      clearConversationKeyCache();
      // Recipient pre-derives key for the sender (simulates warmSymmetricKeyCache at startup)
      await getSymmetricKey(skB, pkA);
      // Now unwrap should work with the warmed key
      const rumor = await unwrapV2(event, skB);
      expect(rumor.content).toBe('cold cache msg');
    });
  });
});

// ==================== Cross-repo shared test vector ====================
// This vector MUST match between phantombot and phantomchat. The deterministic
// inner half (ECDH → HKDF → AES-256-GCM key) is byte-pinned. The outer
// envelope is non-deterministic (ephemeral signing) so we assert it structurally.
//
// If this test diverges between repos, the protocol has drifted and DMs will
// silently fail to decrypt.

describe('PhantomChat Protocol v2 — cross-repo shared test vector', () => {
  // Fixed keys derived from minimal byte patterns for reproducibility.
  // NEVER use these in production — they're test-only.
  const senderSk = Uint8Array.from(Array.from({length: 32}, (_, i) => i + 1));
  const recipientSk = Uint8Array.from(Array.from({length: 32}, (_, i) => i + 2));
  const senderPk = getPublicKey(senderSk);
  const recipientPk = getPublicKey(recipientSk);

  // Deterministic inner half — these bytes MUST match across repos
  const EXPECTED_SYMMETRIC_KEY = '20be5fd3f2476eed59a6eeac45331d88e8f5a2204591f3604d57c87b1eada7fc';
  const EXPECTED_RUMOR_ID = '1012a22578e51593cad513f022acd569452a8a22a3560e9af260049edcdc4435';
  const PLAINTEXT = 'test vector plaintext';
  const FIXED_CREATED_AT = 1700000000;

  it('symmetric key derivation matches cross-repo vector', async() => {
    clearConversationKeyCache();
    const {key} = await getSymmetricKey(senderSk, recipientPk);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key));
    expect(Buffer.from(raw).toString('hex')).toBe(EXPECTED_SYMMETRIC_KEY);
  });

  it('rumor id matches cross-repo vector for fixed timestamp', () => {
    const rumor = {
      kind: 14,
      created_at: FIXED_CREATED_AT,
      tags: [['p', recipientPk], ['v', 'pc-v2']],
      content: PLAINTEXT,
      pubkey: senderPk
    };
    expect(getEventHash(rumor as any)).toBe(EXPECTED_RUMOR_ID);
  });

  it('full wrap/unwrap roundtrip with fixed keys produces correct rumor', async() => {
    clearConversationKeyCache();
    const realDateNow = Date.now;
    Date.now = () => FIXED_CREATED_AT * 1000;
    try {
      const {event, rumorId} = await wrapV2(senderSk, recipientPk, PLAINTEXT);

      // Outer envelope: structural checks (non-deterministic due to ephemeral signing)
      expect(event.kind).toBe(1059);
      expect(event.pubkey).not.toBe(senderPk); // ephemeral, not sender
      expect(event.pubkey).not.toBe(recipientPk);
      expect(event.tags.some((t: string[]) => t[0] === 'p' && t[1] === recipientPk)).toBe(true);
      expect(event.tags.some((t: string[]) => t[0] === 'v' && t[1] === 'pc-v2')).toBe(true);
      expect(verifyEvent(event as any)).toBe(true);

      // Inner half: rumorId must match the pinned vector
      expect(rumorId).toBe(EXPECTED_RUMOR_ID);

      // Unwrap recovers the correct rumor
      const rumor = await unwrapV2(event, recipientSk);
      expect(rumor.content).toBe(PLAINTEXT);
      expect(rumor.pubkey).toBe(senderPk);
      expect(rumor.id).toBe(EXPECTED_RUMOR_ID);
      expect(rumor.kind).toBe(14);
      expect(rumor.created_at).toBe(FIXED_CREATED_AT);
    } finally {
      Date.now = realDateNow;
    }
  });
});
