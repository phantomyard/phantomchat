import {describe, it, expect} from 'vitest';
import {generateSecretKey, getPublicKey, getEventHash} from 'nostr-tools/pure';
import {wrapNip17Message, unwrapNip17Message} from '@lib/nostra/nostr-crypto';

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
