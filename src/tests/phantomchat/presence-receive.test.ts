// @vitest-environment jsdom
/**
 * Behavioral test for the presence RECEIVE side (phantomchat-presence.ts).
 *
 * A kind-30315 beat from a TRACKED contact must flip that contact's tweb user
 * status to `userStatusOnline`; a beat from an UNTRACKED author, or a non-30315
 * event, must be ignored. This is what turns "last seen recently" into a REAL
 * Online badge. onPeerActivity (fired on any inbound message) must do the same.
 */

import {describe, it, expect, beforeEach, vi} from 'vitest';

// Polyfill Number.prototype.toPeerId (tweb runtime addition, not in test env).
if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(this: number) { return Number(this); };
}

const PEER = 'b'.repeat(64);
const UNTRACKED = 'c'.repeat(64);
const OWN = 'a'.repeat(64);
const PEER_ID = 7;

function presenceEvent(over: Partial<any> = {}): any {
  return {
    id: 'evt-' + Math.random().toString(36).slice(2),
    kind: 30315,
    pubkey: PEER,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', 'general'], ['status', 'online'], ['p', OWN]],
    content: 'online',
    ...over
  };
}

describe('phantomchat presence receive', () => {
  let presence: any;
  let fakeUser: any;
  let dispatched: any[];

  beforeEach(async() => {
    vi.resetModules();
    dispatched = [];
    vi.doMock('@stores/peers', () => ({reconcilePeer: vi.fn()}));
    vi.doMock('@lib/rootScope', () => ({
      default: {dispatchEvent: (...a: any[]) => dispatched.push(a)}
    }));

    const {MOUNT_CLASS_TO} = await import('@config/debug');
    fakeUser = {_: 'user', id: PEER_ID};
    (MOUNT_CLASS_TO as any).apiManagerProxy = {
      getPeer: () => fakeUser,
      mirrors: {peers: {}}
    };

    presence = await import('@lib/phantomchat/phantomchat-presence');
  });

  it('marks a tracked peer online on a 30315 beat', () => {
    presence.trackPeerPresence(PEER, PEER_ID);
    presence.onRemotePresenceEvent(presenceEvent());
    expect(fakeUser.status?._).toBe('userStatusOnline');
    // It also notifies the topbar/profile to refresh the status string.
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores a beat from an untracked author', () => {
    presence.onRemotePresenceEvent(presenceEvent({pubkey: UNTRACKED}));
    expect(fakeUser.status).toBeUndefined();
  });

  it('ignores a non-30315 kind', () => {
    presence.trackPeerPresence(PEER, PEER_ID);
    presence.onRemotePresenceEvent(presenceEvent({kind: 7}));
    expect(fakeUser.status).toBeUndefined();
  });

  it('onPeerActivity marks a tracked peer online', () => {
    presence.trackPeerPresence(PEER, PEER_ID);
    presence.onPeerActivity(PEER);
    expect(fakeUser.status?._).toBe('userStatusOnline');
  });

  it('does not throw on a malformed event', () => {
    expect(() => presence.onRemotePresenceEvent(null)).not.toThrow();
    expect(() => presence.onRemotePresenceEvent({})).not.toThrow();
  });
});
