/*
 * Unit tests for the P2P badge data source (#52): TransportStatus.stateFor.
 * Guards the badge verdict — a peer is 'p2p' ONLY while a LIVE direct channel to
 * it is open right now (as reported by the registered live probe). Advertised
 * capability is NOT enough, and neither is a past direct delivery — green means
 * CONNECTED AT THIS MOMENT. Everyone else is 'relay'.
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import {TransportStatus} from '@lib/phantomchat/transport/transport-status';

const PEER = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('TransportStatus (P2P badge verdict)', () => {
  let ts: TransportStatus;

  beforeEach(() => {
    ts = new TransportStatus();
    (globalThis as any).window = globalThis;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is relay when no live probe is registered', () => {
    expect(ts.stateFor(PEER)).toBe('relay');
  });

  it('is relay when the live probe reports no open channel (null)', () => {
    ts.setLiveProbe(() => null);
    expect(ts.stateFor(PEER)).toBe('relay');
  });

  it('is p2p ONLY while the live probe reports an open direct channel', () => {
    let live: string | null = null;
    ts.setLiveProbe((pk) => (pk === PEER ? live : null));

    // No channel yet → relay.
    expect(ts.stateFor(PEER)).toBe('relay');

    // Channel comes up → p2p.
    live = 'webrtc';
    expect(ts.stateFor(PEER)).toBe('p2p');

    // A different peer with no channel stays relay.
    expect(ts.stateFor(OTHER)).toBe('relay');

    // Channel drops → back to relay (no stale green).
    live = null;
    expect(ts.stateFor(PEER)).toBe('relay');
  });

  it('a past direct delivery does NOT keep the badge green once the channel is gone', () => {
    // record() is audit-only now; it must NOT drive the verdict.
    ts.setLiveProbe(() => null); // no live channel
    ts.record(PEER, 'webrtc');   // we once delivered direct...
    expect(ts.stateFor(PEER)).toBe('relay'); // ...but the channel is gone → no badge
  });

  it('setLiveProbe notifies subscribers so mounted badges re-evaluate', () => {
    const cb = vi.fn();
    ts.subscribe(cb);
    ts.setLiveProbe(() => 'webrtc');
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('record still notifies subscribers only when it crosses the direct/relay line', () => {
    const cb = vi.fn();
    ts.subscribe(cb);

    ts.record(PEER, 'relay');   // relay → relay: no crossing
    expect(cb).toHaveBeenCalledTimes(0);

    ts.record(PEER, 'webrtc');  // relay → direct: crossing
    expect(cb).toHaveBeenCalledTimes(1);

    ts.record(PEER, 'webrtc'); // direct → direct: no crossing
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
