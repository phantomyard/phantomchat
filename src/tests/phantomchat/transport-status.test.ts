/*
 * Unit tests for the P2P badge data source (#52): TransportStatus.stateFor.
 * Guards the badge verdict — ONLY a peer whose last delivery actually landed on
 * a direct tier is 'p2p'. Advertised capability alone is NOT enough (green means
 * ESTABLISHED, not merely possible); everyone else is 'relay'.
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TransportStatus} from '@lib/phantomchat/transport/transport-status';

const PEER = 'a'.repeat(64);

describe('TransportStatus (P2P badge verdict)', () => {
  let ts: TransportStatus;

  beforeEach(() => {
    ts = new TransportStatus();
    (globalThis as any).window = globalThis;
    delete (globalThis as any).__phantomchatCapability;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as any).__phantomchatCapability;
  });

  it('is relay for an unknown peer (no advert, no delivery)', () => {
    expect(ts.stateFor(PEER)).toBe('relay');
    expect(ts.deliveredDirect(PEER)).toBe(false);
  });

  it('is relay after a relay-tier delivery', () => {
    ts.record(PEER, 'relay');
    expect(ts.stateFor(PEER)).toBe('relay');
  });

  it('flips to p2p after a direct-tier delivery (local-ws / webrtc / dht)', () => {
    for(const tier of ['local-ws', 'webrtc', 'dht'] as const) {
      const fresh = new TransportStatus();
      fresh.record(PEER, tier);
      expect(fresh.deliveredDirect(PEER)).toBe(true);
      expect(fresh.stateFor(PEER)).toBe('p2p');
    }
  });

  it('is NOT p2p on advertised capability alone — established delivery required', () => {
    // A peer that advertised a P2P node but we have never actually reached over a
    // direct tier must stay relay (no badge). Capability != established.
    (globalThis as any).__phantomchatCapability = {has: (pk: string) => pk === PEER};
    expect(ts.stateFor(PEER)).toBe('relay');

    // ...and it only flips to p2p once a real delivery lands on a direct tier.
    ts.record(PEER, 'webrtc');
    expect(ts.stateFor(PEER)).toBe('p2p');
  });

  it('notifies subscribers only when a delivery crosses the direct/relay line', () => {
    const cb = vi.fn();
    ts.subscribe(cb);

    ts.record(PEER, 'relay');   // relay → relay: no crossing
    expect(cb).toHaveBeenCalledTimes(0);

    ts.record(PEER, 'webrtc');  // relay → direct: crossing
    expect(cb).toHaveBeenCalledTimes(1);

    ts.record(PEER, 'local-ws'); // direct → direct: no crossing
    expect(cb).toHaveBeenCalledTimes(1);

    ts.record(PEER, 'relay');    // direct → relay: crossing
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops notifications', () => {
    const cb = vi.fn();
    const off = ts.subscribe(cb);
    off();
    ts.record(PEER, 'webrtc');
    expect(cb).toHaveBeenCalledTimes(0);
  });
});
