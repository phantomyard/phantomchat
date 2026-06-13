/**
 * Tests for virtual peer detection helpers
 */

import '../setup';
import {isVirtualPeerSync, VIRTUAL_PEER_BASE} from '@lib/nostra/nostra-bridge';

// --- isVirtualPeerSync tests ---

describe('isVirtualPeerSync', () => {
  const base = Number(VIRTUAL_PEER_BASE);

  test('VIRTUAL_PEER_BASE is 1e15', () => {
    expect(VIRTUAL_PEER_BASE).toBe(BigInt(10 ** 15));
    expect(base).toBe(1e15);
  });

  test('returns true for peerId equal to VIRTUAL_PEER_BASE', () => {
    expect(isVirtualPeerSync(base)).toBe(true);
  });

  test('returns true for peerId above VIRTUAL_PEER_BASE', () => {
    expect(isVirtualPeerSync(base + 1)).toBe(true);
    expect(isVirtualPeerSync(base + 999999)).toBe(true);
  });

  test('returns false for peerId below VIRTUAL_PEER_BASE', () => {
    expect(isVirtualPeerSync(base - 1)).toBe(false);
    expect(isVirtualPeerSync(100)).toBe(false);
    expect(isVirtualPeerSync(0)).toBe(false);
  });

  test('returns false for negative peerId', () => {
    expect(isVirtualPeerSync(-1)).toBe(false);
    expect(isVirtualPeerSync(-base)).toBe(false);
    expect(isVirtualPeerSync(-999999)).toBe(false);
  });

  test('returns false for typical Telegram peer IDs', () => {
    // Normal Telegram user IDs are well below 1e15
    expect(isVirtualPeerSync(12345)).toBe(false);
    expect(isVirtualPeerSync(0x7FFFFFFF)).toBe(false);
    expect(isVirtualPeerSync(999999999)).toBe(false);
  });

  test('returns true for very large virtual peer IDs', () => {
    expect(isVirtualPeerSync(base + 1e12)).toBe(true);
  });
});

