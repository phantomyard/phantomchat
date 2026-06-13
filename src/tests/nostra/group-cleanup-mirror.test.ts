/**
 * Regression coverage for INV-group-no-orphan-mirror-peer (Phase 2b.5).
 *
 * `ensureGroupChatInjected` (nostra-groups-sync.ts) writes the group Chat
 * into `apiManagerProxy.mirrors.peers[peerId]` + `mirrors.chats[chatId]`
 * + `appChatsManager.saveApiChat(...)` on every send/receive so tweb's
 * bubble pipeline can resolve the peer. That was shipped in PR #87 for
 * FIND-dbe8fdd2 but had no symmetric cleanup: when `GroupAPI.leaveGroup`
 * / `handleRemoveMember(targetPubkey=self)` deleted the group-store
 * record, the Chat entry remained in `mirrors.peers`, producing an
 * orphan that the regression-tier invariant detects and that causes the
 * "left" group to briefly re-render in the chat list on refresh.
 *
 * `cleanupGroupChatInjection` deletes both mirror entries and is invoked
 * on every leave / remove-self path to make leave idempotent with
 * create.
 */
import '../setup';
import {describe, it, expect, beforeEach, vi} from 'vitest';

const proxy: {mirrors: {peers: Record<number, any>; chats: Record<number, any>}} = {
  mirrors: {peers: {}, chats: {}}
};

vi.mock('@config/debug', async() => {
  const actual = await vi.importActual<typeof import('@config/debug')>('@config/debug');
  return {...actual, MOUNT_CLASS_TO: {apiManagerProxy: proxy}};
});
vi.mock('@lib/rootScope', () => ({
  default: {dispatchEvent: vi.fn(), dispatchEventSingle: vi.fn(), managers: {appChatsManager: {saveApiChat: vi.fn()}}}
}));

describe('cleanupGroupChatInjection', () => {
  beforeEach(() => {
    proxy.mirrors.peers = {};
    proxy.mirrors.chats = {};
  });

  it('removes the group peer + chat from mirrors', async() => {
    const {cleanupGroupChatInjection} = await import('@lib/nostra/nostra-groups-sync');
    const groupPeerId = -5338364139046749;
    const chatId = Math.abs(groupPeerId);
    proxy.mirrors.peers[groupPeerId] = {id: chatId, _: 'chat', title: 'g'};
    proxy.mirrors.chats[chatId] = {id: chatId, _: 'chat', title: 'g'};

    await cleanupGroupChatInjection(groupPeerId);

    expect(proxy.mirrors.peers[groupPeerId]).toBeUndefined();
    expect(proxy.mirrors.chats[chatId]).toBeUndefined();
  });

  it('is a no-op when no injection exists (idempotent)', async() => {
    const {cleanupGroupChatInjection} = await import('@lib/nostra/nostra-groups-sync');
    await expect(cleanupGroupChatInjection(-7777777777777)).resolves.not.toThrow();
    expect(Object.keys(proxy.mirrors.peers)).toHaveLength(0);
  });

  it('only removes the targeted group peer, not unrelated peers', async() => {
    const {cleanupGroupChatInjection} = await import('@lib/nostra/nostra-groups-sync');
    const target = -5000000000000001;
    const otherGroup = -5000000000000002;
    const p2pPeer = 3772835907436560; // positive: P2P peer, not a group
    proxy.mirrors.peers[target] = {id: Math.abs(target)};
    proxy.mirrors.peers[otherGroup] = {id: Math.abs(otherGroup)};
    proxy.mirrors.peers[p2pPeer] = {id: p2pPeer};
    proxy.mirrors.chats[Math.abs(target)] = {id: Math.abs(target)};
    proxy.mirrors.chats[Math.abs(otherGroup)] = {id: Math.abs(otherGroup)};

    await cleanupGroupChatInjection(target);

    expect(proxy.mirrors.peers[target]).toBeUndefined();
    expect(proxy.mirrors.peers[otherGroup]).toBeDefined();
    expect(proxy.mirrors.peers[p2pPeer]).toBeDefined();
    expect(proxy.mirrors.chats[Math.abs(target)]).toBeUndefined();
    expect(proxy.mirrors.chats[Math.abs(otherGroup)]).toBeDefined();
  });
});
