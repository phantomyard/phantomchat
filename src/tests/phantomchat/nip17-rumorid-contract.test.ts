import {describe, it, expect} from 'vitest';
import {generateSecretKey, getPublicKey, getEventHash} from 'nostr-tools/pure';
import {wrapNip17Message, rewrapNip17Message, unwrapNip17Message} from '@lib/phantomchat/nostr-crypto';

// Bug #3 (FIND-4e18d35d) — sender must save its row keyed by the rumor id so
// kind-7 reactions can reference a 64-hex `e` tag that strfry (and any
// NIP-01-conformant relay) accepts. The wrapper currently discards the rumor
// id; this contract test asserts it is returned alongside the wraps.
describe('wrapNip17Message rumor id contract', () => {
  const skA = generateSecretKey();
  const skB = generateSecretKey();
  const pkB = getPublicKey(skB);

  it('returns {wraps, rumorId} with a 64-hex rumorId', () => {
    const result = wrapNip17Message(skA, pkB, 'hello rumor id');
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(false);
    expect(result.wraps).toBeDefined();
    expect(Array.isArray(result.wraps)).toBe(true);
    expect(result.wraps.length).toBe(2);
    expect(typeof result.rumorId).toBe('string');
    expect(result.rumorId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rumorId equals the canonical hash of the unwrapped rumor', () => {
    const {wraps, rumorId} = wrapNip17Message(skA, pkB, 'canonical id match');
    const wrapForB = wraps.find((w) => w.tags.some((t: string[]) => t[0] === 'p' && t[1] === pkB))!;
    const rumor = unwrapNip17Message(wrapForB as any, skB);
    expect(rumor.id).toBe(rumorId);
    expect(getEventHash(rumor as any)).toBe(rumorId);
  });

  it('rumorId is identical across recipient- and self-wrap (same rumor under two seals)', () => {
    const {wraps, rumorId} = wrapNip17Message(skA, pkB, 'two seals same rumor');
    const pkA = getPublicKey(skA);
    const wrapForA = wraps.find((w) => w.tags.some((t: string[]) => t[0] === 'p' && t[1] === pkA))!;
    const wrapForB = wraps.find((w) => w.tags.some((t: string[]) => t[0] === 'p' && t[1] === pkB))!;
    const rumorFromA = unwrapNip17Message(wrapForA as any, skA);
    const rumorFromB = unwrapNip17Message(wrapForB as any, skB);
    expect(rumorFromA.id).toBe(rumorId);
    expect(rumorFromB.id).toBe(rumorId);
  });
});

// FIND-ghost-first-msg — the delivery-retry layer must re-wrap (fresh outer
// gift-wrap) rather than re-publish the identical event: relays won't
// re-forward a duplicate outer id to a live subscriber, so a verbatim resend
// can never rescue a ghosted first message. The re-wrap must keep the rumor id
// stable (receiver dedups → no double) while minting a NEW outer wrap id.
describe('rewrapNip17Message (retry re-wrap)', () => {
  const skA = generateSecretKey();
  const skB = generateSecretKey();
  const pkB = getPublicKey(skB);

  it('preserves the rumor id but mints a fresh outer wrap id', () => {
    const {wraps, rumorId, rumor} = wrapNip17Message(skA, pkB, 'ghost-proof');
    const origWrapForB = wraps.find((w) => w.tags.some((t: string[]) => t[0] === 'p' && t[1] === pkB))!;

    const fresh = rewrapNip17Message(skA, pkB, rumor);
    expect(fresh.length).toBe(2);
    const freshWrapForB = fresh.find((w) => w.tags.some((t: string[]) => t[0] === 'p' && t[1] === pkB))!;

    // Outer gift-wrap id MUST differ (or the relay drops it as a duplicate).
    expect(freshWrapForB.id).not.toBe(origWrapForB.id);

    // Inner rumor id MUST be identical (receiver dedups → never a double).
    const rumorFromOrig = unwrapNip17Message(origWrapForB as any, skB);
    const rumorFromFresh = unwrapNip17Message(freshWrapForB as any, skB);
    expect(rumorFromFresh.id).toBe(rumorId);
    expect(rumorFromFresh.id).toBe(rumorFromOrig.id);
    expect(rumorFromFresh.content).toBe(rumorFromOrig.content);
  });

  it('yields a different outer id on every successive re-wrap', () => {
    const {rumor} = wrapNip17Message(skA, pkB, 'twice');
    const a = rewrapNip17Message(skA, pkB, rumor)[0];
    const b = rewrapNip17Message(skA, pkB, rumor)[0];
    expect(a.id).not.toBe(b.id);
  });
});
