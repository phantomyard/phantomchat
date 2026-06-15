import {describe, it, expect} from 'vitest';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {
  wrapNip17Message,
  unwrapNip17Message,
  wrapNip17Receipt
} from '@lib/phantomchat/nostr-crypto';

describe('NIP-17 gift-wrap structure', () => {
  const skA = generateSecretKey();
  const pkA = getPublicKey(skA);
  const skB = generateSecretKey();
  const pkB = getPublicKey(skB);

  it('gift-wrap has kind 1059', () => {
    const {wraps} = wrapNip17Message(skA, pkB, 'kind test');
    for(const w of wraps) {
      expect(w.kind).toBe(1059);
    }
  });

  it('rumor kind is 14 (PrivateDirectMessage)', () => {
    const {wraps} = wrapNip17Message(skA, pkB, 'rumor kind test');
    const wrapForB = wraps.find(w => w.tags.some((t: string[]) => t[0] === 'p' && t[1] === pkB))!;
    const rumor = unwrapNip17Message(wrapForB, skB);
    expect(rumor.kind).toBe(14);
  });

  it('gift-wrap created_at is the real send time (no backdating)', () => {
    const {wraps} = wrapNip17Message(skA, pkB, 'timestamp test');
    const nowSec = Math.floor(Date.now() / 1000);
    // Backdating was removed: a wrap's created_at must be ~now, not randomized
    // up to 48h into the past. Truthful timestamps are what let the receiver
    // catch a dropped message with a tight `since` catch-up poll. Allow a small
    // slack for test execution time only.
    for(const w of wraps) {
      expect(w.created_at).toBeGreaterThan(nowSec - 5);
      expect(w.created_at).toBeLessThanOrEqual(nowSec + 1);
    }
  });

  it('unwrap fails on wrong recipient key', () => {
    const skC = generateSecretKey();
    const {wraps} = wrapNip17Message(skA, pkB, 'wrong key test');
    const wrapForB = wraps.find(w => w.tags.some((t: string[]) => t[0] === 'p' && t[1] === pkB))!;

    expect(() => unwrapNip17Message(wrapForB, skC)).toThrow();
  });

  it('receipt wrapping produces kind 1059 with receipt-type tag', () => {
    const wraps = wrapNip17Receipt(skA, pkB, 'abc123', 'delivery');
    expect(wraps.length).toBe(1); // no self-send for receipts
    expect(wraps[0].kind).toBe(1059);

    // Unwrap and verify receipt content
    const rumor = unwrapNip17Message(wraps[0], skB);
    expect(rumor.kind).toBe(14);
    // Should have receipt-type tag
    const receiptTag = rumor.tags.find((t: string[]) => t[0] === 'receipt-type');
    expect(receiptTag).toBeDefined();
    expect(receiptTag![1]).toBe('delivery');
    // Should have 'e' tag referencing original event
    const eTag = rumor.tags.find((t: string[]) => t[0] === 'e');
    expect(eTag).toBeDefined();
    expect(eTag![1]).toBe('abc123');
  });
});
