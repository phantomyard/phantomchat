// @vitest-environment jsdom
/**
 * Behavioral test for the presence RECEIVE side (phantomchat-presence.ts),
 * PING/PONG model.
 *
 * A PONG from a TRACKED contact (proof our gift-wrap reached them) must flip
 * that contact's tweb user status to `userStatusOnline`; a pong from an
 * UNTRACKED author must be ignored. A PING from a tracked contact (they're
 * demonstrably alive) does the same, as does onPeerActivity (any inbound
 * message). This is what turns "last seen recently" into a REAL Online badge.
 */

import {describe, it, expect, beforeEach, vi} from 'vitest';

// Polyfill Number.prototype.toPeerId (tweb runtime addition, not in test env).
if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(this: number) { return Number(this); };
}

const PEER = 'b'.repeat(64);
const UNTRACKED = 'c'.repeat(64);
const PEER_ID = 7;

describe('phantomchat presence receive (ping/pong)', () => {
  let presence: any;
  let fakeUser: any;
  let dispatched: any[];
  let workerStatusCalls: any[];

  beforeEach(async() => {
    vi.resetModules();
    dispatched = [];
    workerStatusCalls = [];
    vi.doMock('@stores/peers', () => ({reconcilePeer: vi.fn()}));
    vi.doMock('@lib/rootScope', () => ({
      default: {
        dispatchEvent: (...a: any[]) => dispatched.push(a),
        addEventListener: () => {},
        managers: {
          appUsersManager: {
            updateP2PUserStatus: (...a: any[]) => workerStatusCalls.push(a)
          }
        }
      }
    }));

    const {MOUNT_CLASS_TO} = await import('@config/debug');
    fakeUser = {_: 'user', id: PEER_ID};
    (MOUNT_CLASS_TO as any).apiManagerProxy = {
      getPeer: () => fakeUser,
      mirrors: {peers: {}}
    };

    presence = await import('@lib/phantomchat/phantomchat-presence');
  });

  it('marks a tracked peer online on a pong', () => {
    presence.trackPeerPresence(PEER, PEER_ID);
    presence.onRemotePong(PEER, 'nonce-1');
    expect(fakeUser.status?._).toBe('userStatusOnline');
    // It also notifies the topbar/profile to refresh the status string.
    expect(dispatched.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores a pong from an untracked author', () => {
    presence.onRemotePong(UNTRACKED, 'nonce-x');
    expect(fakeUser.status).toBeUndefined();
  });

  it('marks a tracked peer online on an inbound ping', () => {
    presence.trackPeerPresence(PEER, PEER_ID);
    presence.onRemotePing(PEER);
    expect(fakeUser.status?._).toBe('userStatusOnline');
  });

  it('onPeerActivity marks a tracked peer online', () => {
    presence.trackPeerPresence(PEER, PEER_ID);
    presence.onPeerActivity(PEER);
    expect(fakeUser.status?._).toBe('userStatusOnline');
  });

  it('does not throw on malformed input', () => {
    expect(() => presence.onRemotePong('', '')).not.toThrow();
    expect(() => presence.onRemotePing('')).not.toThrow();
    expect(() => presence.onPeerActivity('')).not.toThrow();
  });

  it('writes the status into the WORKER store (the topbar read-path) on a pong', () => {
    presence.trackPeerPresence(PEER, PEER_ID);
    presence.onRemotePong(PEER, 'nonce-2');
    // updateP2PUserStatus(peerId, isOnline, tsSec, onlineUntilSec)
    expect(workerStatusCalls.length).toBeGreaterThanOrEqual(1);
    const [peerId, isOnline] = workerStatusCalls[0];
    expect(peerId).toBe(PEER_ID);
    expect(isOnline).toBe(true);
  });
});
