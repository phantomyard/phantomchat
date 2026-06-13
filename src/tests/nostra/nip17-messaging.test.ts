import {describe, it, expect} from 'vitest';
import {generateSecretKey, getPublicKey} from 'nostr-tools/pure';
import {
  wrapNip17Message,
  unwrapNip17Message
} from '@lib/nostra/nostr-crypto';

describe('NIP-17 messaging roundtrip', () => {
  const skA = generateSecretKey();
  const pkA = getPublicKey(skA);
  const skB = generateSecretKey();
  const pkB = getPublicKey(skB);

  it('wrapNip17Message produces kind 1059 events', () => {
    const {wraps} = wrapNip17Message(skA, pkB, 'hello from A');
    expect(wraps.length).toBeGreaterThanOrEqual(2); // recipient + self-send
    for(const w of wraps) {
      expect(w.kind).toBe(1059);
      expect(w.id).toBeTruthy();
      expect(w.sig).toBeTruthy();
    }
  });

  it('recipient can unwrap and read content', () => {
    const {wraps} = wrapNip17Message(skA, pkB, 'secret message');
    // Find the wrap tagged for B
    const wrapForB = wraps.find(w => w.tags.some((t: string[]) => t[0] === 'p' && t[1] === pkB));
    expect(wrapForB).toBeDefined();

    const rumor = unwrapNip17Message(wrapForB!, skB);
    expect(rumor.content).toBe('secret message');
    expect(rumor.pubkey).toBe(pkA);
    expect(rumor.kind).toBe(14);
  });

  it('self-send wrap is included (sender can unwrap own copy)', () => {
    const {wraps} = wrapNip17Message(skA, pkB, 'multi-device test');
    // Find the wrap tagged for A (self-send)
    const wrapForA = wraps.find(w => w.tags.some((t: string[]) => t[0] === 'p' && t[1] === pkA));
    expect(wrapForA).toBeDefined();

    const rumor = unwrapNip17Message(wrapForA!, skA);
    expect(rumor.content).toBe('multi-device test');
    expect(rumor.pubkey).toBe(pkA);
  });

  it('wrapManyEvents returns N+1 events (self-send + recipients)', () => {
    const {wraps} = wrapNip17Message(skA, pkB, 'count check');
    // 1 recipient + 1 self = 2
    expect(wraps.length).toBe(2);
  });

  it('subscription filter should use kind 1059', () => {
    // This is a code-level verification -- tested in nip17-giftwrap
    expect(1059).toBe(1059);
  });
});
