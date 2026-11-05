import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import 'fake-indexeddb/auto';

// Like the real worker, injectP2PUser mirrors back a flagless user that
// REPLACES the main-thread mirror entry (appUsersManager.mirrorUser).
const {injectP2PUser, hasUser} = vi.hoisted(() => ({
  injectP2PUser: vi.fn(async(pubkey: string, peerId: number, name: string) => {
    const proxy = (globalThis as any).__testProxy;
    if(proxy) proxy.mirrors.peers[peerId] = {_: 'user', id: peerId, pFlags: {}, first_name: name, p2pPubkey: pubkey};
  }),
  hasUser: vi.fn(async() => false)
}));
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn(),
    dispatchEventSingle: vi.fn(),
    addEventListener: vi.fn(),
    managers: {appUsersManager: {hasUser, injectP2PUser, updateP2PUserName: vi.fn(async() => {})}}
  }
}));
vi.mock('@lib/phantomchat/nostr-profile', () => ({fetchNostrProfile: vi.fn(async(): Promise<null> => null), profileToDisplayName: vi.fn((): null => null)}));
vi.mock('@stores/peers', () => ({reconcilePeer: vi.fn()}));
vi.mock('@lib/phantomchat/phantomchat-bridge', () => ({
  PhantomChatBridge: {getInstance: () => ({deriveAvatarFromPubkeySync: (): undefined => undefined})}
}));

afterAll(() => {
  vi.restoreAllMocks();
});

import {PEER_PROFILE_CACHE_PREFIX} from '@lib/phantomchat/peer-profile-cache';

let MOUNT_CLASS_TO: any;
let ensureSenderUserInjected: typeof import('@lib/phantomchat/ensure-sender-user-injected')['ensureSenderUserInjected'];
beforeAll(async() => {
  // Fresh module graph so the module under test binds to the mocked rootScope.
  vi.resetModules();
  ({MOUNT_CLASS_TO} = await import('@config/debug'));
  ({ensureSenderUserInjected} = await import('@lib/phantomchat/ensure-sender-user-injected'));
});

const HEX = 'c'.repeat(64);
const PEER_ID = 1234567;

describe('ensureSenderUserInjected keeps the cached kind-0 bot flag (#451)', () => {
  let proxy: any;
  beforeEach(() => {
    localStorage.clear();
    proxy = {mirrors: {peers: {}}};
    (MOUNT_CLASS_TO as any).apiManagerProxy = proxy;
    (globalThis as any).__testProxy = proxy;
    hasUser.mockResolvedValue(false);
  });

  it('a legacy Phantom peer rebuilt on an incoming message after reload keeps pFlags.bot', async() => {
    localStorage.setItem(PEER_PROFILE_CACHE_PREFIX + HEX, JSON.stringify({profile: {name: 'Robbie', bot: true}, created_at: 1}));
    await ensureSenderUserInjected({senderPubkey: HEX, peerId: PEER_ID});
    expect(proxy.mirrors.peers[PEER_ID]?.pFlags?.bot).toBe(true);
    expect(injectP2PUser).toHaveBeenCalled();
  });

  it('a peer with no cached bot flag stays a plain user', async() => {
    localStorage.setItem(PEER_PROFILE_CACHE_PREFIX + HEX, JSON.stringify({profile: {name: 'Alice'}, created_at: 1}));
    await ensureSenderUserInjected({senderPubkey: HEX, peerId: PEER_ID});
    expect(proxy.mirrors.peers[PEER_ID]?.pFlags?.bot).toBeUndefined();
  });

  it('a mirror re-sync to the worker does not leave a flagless user in the mirror', async() => {
    proxy.mirrors.peers[PEER_ID] = {_: 'user', id: PEER_ID, pFlags: {bot: true}, first_name: 'Robbie', p2pPubkey: HEX};
    await ensureSenderUserInjected({senderPubkey: HEX, peerId: PEER_ID});
    expect(injectP2PUser).toHaveBeenCalled();
    expect(proxy.mirrors.peers[PEER_ID]?.pFlags?.bot).toBe(true);
    expect(proxy.mirrors.peers[PEER_ID]?.first_name).toBe('Robbie');
  });
});
