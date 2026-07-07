// @ts-nocheck
import {describe, it, expect} from 'vitest';
import {PeerCapabilityRegistry, hasAnyCapability} from '@lib/phantomchat/transport/capability';

const PK = 'a'.repeat(64);

describe('PeerCapabilityRegistry (the #61 gate)', () => {
  it('is closed by default — no peer advertises', () => {
    const reg = new PeerCapabilityRegistry();
    expect(reg.has(PK)).toBe(false);
    expect(reg.get(PK)).toBeUndefined();
    expect(reg.advertisedPeers()).toEqual([]);
  });

  it('opens only when a real capability is set', () => {
    const reg = new PeerCapabilityRegistry();
    reg.set(PK, {webrtc: true});
    expect(reg.has(PK)).toBe(true);
    expect(reg.get(PK)).toEqual({webrtc: true});
    expect(reg.advertisedPeers()).toEqual([PK]);
  });

  it('treats an all-false capability record as no-P2P (gate stays closed)', () => {
    const reg = new PeerCapabilityRegistry();
    reg.set(PK, {webrtc: false});
    expect(reg.has(PK)).toBe(false);
  });

  it('clear() forgets a peer', () => {
    const reg = new PeerCapabilityRegistry();
    reg.set(PK, {webrtc: true});
    reg.clear(PK);
    expect(reg.has(PK)).toBe(false);
  });

  it('hasAnyCapability handles undefined and empty records', () => {
    expect(hasAnyCapability(undefined)).toBe(false);
    expect(hasAnyCapability({})).toBe(false);
    expect(hasAnyCapability({webrtc: true})).toBe(true);
    expect(hasAnyCapability({webrtc: false})).toBe(false);
  });
});
