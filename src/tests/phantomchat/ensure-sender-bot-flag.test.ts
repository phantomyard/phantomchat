import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import 'fake-indexeddb/auto';

const {injectP2PUser} = vi.hoisted(() => ({injectP2PUser: vi.fn(async() => {})}));
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn(),
    dispatchEventSingle: vi.fn(),
    addEventListener: vi.fn(),
    managers: {appUsersManager: {hasUser: vi.fn(async() => false), injectP2PUser, updateP2PUserName: vi.fn(async() => {})}}
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
});
