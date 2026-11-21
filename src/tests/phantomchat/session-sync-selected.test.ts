import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
vi.mock('@lib/phantomchat/group-store', () => ({getGroupStore: () => ({getByPeerId: async() => ({groupId: 'selected-session'})})}));
vi.mock('@lib/phantomchat/virtual-peers-db', () => ({getPubkey: async() => 'contact-pubkey'}));
import {installLaunchDialogs} from '@lib/phantomchat/phantomchat-launch-dialogs';
import {enableSessionSync, resetSessionSync, getChatSyncStatus, setGroupsSyncStatus} from '@lib/phantomchat/session-sync-state';

const PEER = -12_000_000_000_000_004;
beforeEach(() => { enableSessionSync(async() => true); setGroupsSyncStatus('ready'); });
afterEach(() => resetSessionSync());
function install(catchUp = vi.fn().mockResolvedValue('ran')) {
  const listeners: Record<string, (payload: unknown) => void> = {};
  const reload = vi.fn().mockResolvedValue(undefined);
  const invalidate = vi.fn().mockResolvedValue(undefined);
  const dispatch = vi.fn();
  const im = {chat: {peerId: 0}, addEventListener: (name: string, listener: any) => { listeners[name] = listener; }};
  installLaunchDialogs({
    rootScope: {dispatchEvent: dispatch, managers: {dialogsStorage: {getFolderDialogs: async() => []}, appMessagesManager: {reloadConversation: reload, invalidateHistoryCache: invalidate}}},
    appImManager: im,
    chatAPI: {catchUpConversation: catchUp}, launchedWithDeepLink: true, isMobile: () => false
  });
  return {listeners, reload, invalidate, dispatch, im, catchUp};
}
describe('selected session production wiring', () => {
  it('checks a session immediately and only unlocks after history refresh', async() => {
    let release: (outcome: string) => void;
    const h = install(vi.fn(() => new Promise((resolve) => { release = resolve; })));
    h.listeners.peer_changed({peerId: PEER});
    expect(getChatSyncStatus(PEER)).toBe('syncing');
    await vi.waitFor(() => expect(h.catchUp).toHaveBeenCalledWith('group:selected-session', false));
    release('ran');
    await vi.waitFor(() => expect(getChatSyncStatus(PEER)).toBe('ready'));
    expect(h.invalidate).toHaveBeenCalledWith(PEER);
    expect(h.reload).toHaveBeenCalledWith(PEER);
    expect(h.dispatch).toHaveBeenCalledWith('history_reload', PEER);
  });

  it('a failed relay check keeps sending blocked', async() => {
    const h = install(vi.fn().mockResolvedValue('failed'));
    h.listeners.peer_changed({peerId: PEER});
    await vi.waitFor(() => expect(getChatSyncStatus(PEER)).toBe('failed'));
    expect(h.reload).not.toHaveBeenCalled();
  });

  it('an old chat finishing after switching cannot unlock the selected chat', async() => {
    let release: (outcome: string) => void;
    const h = install(vi.fn().mockImplementationOnce(() => new Promise((resolve) => { release = resolve; })).mockResolvedValue('failed'));
    h.listeners.peer_changed({peerId: PEER});
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    h.listeners.peer_changed({peerId: 123});
    await vi.waitFor(() => expect(getChatSyncStatus(123)).toBe('failed'));
    release('ran');
    await vi.waitFor(() => expect(getChatSyncStatus(PEER)).toBe('ready'));
    expect(getChatSyncStatus(123)).toBe('failed');
  });

  it('late work after logout cannot change the replacement account status', async() => {
    let release: (outcome: string) => void;
    const h = install(vi.fn(() => new Promise((resolve) => { release = resolve; })));
    h.listeners.peer_changed({peerId: PEER});
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    enableSessionSync(async() => true);
    release('ran');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getChatSyncStatus(PEER)).toBe('syncing');
  });
});
