import 'fake-indexeddb/auto';
import {beforeAll, describe, expect, it, vi} from 'vitest';

const resetUnread = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@lib/phantomchat/phantomchat-message-handler', () => ({resetUnreadForPeer: resetUnread}));

const setGroupUnreadMark = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@lib/phantomchat/group-api', () => ({getGroupAPI: () => ({setGroupUnreadMarkByPeerId: setGroupUnreadMark})}));
vi.mock('@lib/appDialogsManager', () => ({default: {}, DIALOG_LIST_ELEMENT_TAG: 'A'}));
vi.mock('@lib/appImManager', () => ({default: {}}));

// The menu handler is real; popup rendering and app boot are outside this gesture.
vi.mock('@lib/apiManagerProxy', () => ({default: {}}));
vi.mock('@components/popups', () => ({default: class {}}));
vi.mock('@components/popups/deleteDialog', () => ({default: class {}}));
vi.mock('@components/popups/mute', () => ({default: class {}}));
vi.mock('@components/popups/limit', () => ({default: vi.fn()}));
vi.mock('@components/chat/removeFee', () => ({openRemoveFeePopup: vi.fn()}));
vi.mock('@components/peerActionsMenu', () => ({peerEditMenuButton: vi.fn()}));

vi.mock('@helpers/dom/createContextMenu', () => ({default: vi.fn()}));
vi.mock('@components/createSubmenuTrigger', () => ({default: vi.fn()}));
vi.mock('@lib/langPack', () => ({i18n: vi.fn(), _i18n: vi.fn()}));
vi.mock('@components/toast', () => ({toastNew: vi.fn()}));

let Menu: typeof import('@components/dialogsContextMenu').default;
beforeAll(async() => {
  ({default: Menu} = await import('@components/dialogsContextMenu'));
}, 30000);

describe('direct-chat Mark as Read context-menu gesture', () => {
  it.each([
    {unread_count: 0, pFlags: {unread_mark: true}},
    {unread_count: 3, pFlags: {}}
  ])('clears %j through both receive-counter reset and explicit Worker read', async(state) => {
    resetUnread.mockClear();
    const peerId = 1_000_000_000_000_001;
    const markDialogUnread = vi.fn().mockResolvedValue(undefined);
    const menu = new Menu({appMessagesManager: {markDialogUnread}} as any) as any;
    menu.peerId = peerId;
    menu.dialog = {_: 'dialog', peerId, ...state};
    await menu.onUnreadClick();
    expect(resetUnread).toHaveBeenCalledWith(peerId);
    expect(markDialogUnread).toHaveBeenCalledWith({peerId, read: true});
    expect(resetUnread.mock.invocationCallOrder[0]).toBeLessThan(markDialogUnread.mock.invocationCallOrder[0]);
  });
});

// Issue #355 item 1, shape (a). The group branch of onUnreadClick is
// conversation-scoped: its "mark read" half calls resetUnreadForPeer, which
// clears every topic in the peer. A topic gesture carries a threadId and must
// stay thread-scoped, so it has to fall through to the readHistory branch.
// The seeded shape is the one getAnyDialog really returns for a group topic
// (`_: 'forumTopic'`, group-range peer, threadId set) — not `_: 'dialog'`.
describe('group topic Mark as Read context-menu gesture', () => {
  it('stays thread-scoped instead of clearing the whole group peer', async() => {
    resetUnread.mockClear();
    setGroupUnreadMark.mockClear();
    const peerId = -2_000_000_000_000_042;
    const threadId = 42;
    const markDialogUnread = vi.fn().mockResolvedValue(undefined);
    const readHistory = vi.fn().mockResolvedValue(undefined);
    const menu = new Menu({appMessagesManager: {markDialogUnread, readHistory}} as any) as any;
    menu.peerId = peerId;
    menu.threadId = threadId;
    menu.dialog = {_: 'forumTopic', peerId, threadId, unread_count: 3, top_message: 77, pFlags: {}};
    await menu.onUnreadClick();
    expect(readHistory).toHaveBeenCalledWith({peerId, maxId: 77, threadId});
    expect(markDialogUnread).not.toHaveBeenCalled();
    expect(resetUnread).not.toHaveBeenCalled();
    expect(setGroupUnreadMark).not.toHaveBeenCalled();
  });
});

describe('threaded (topic) Mark as Read context-menu gesture', () => {
  it('does not clear the whole conversation when a threadId is set', async() => {
    resetUnread.mockClear();
    const peerId = 1_000_000_000_000_002;
    const threadId = 42;
    const markDialogUnread = vi.fn().mockResolvedValue(undefined);
    const readHistory = vi.fn().mockResolvedValue(undefined);
    const menu = new Menu({appMessagesManager: {markDialogUnread, readHistory}} as any) as any;
    menu.peerId = peerId;
    menu.threadId = threadId;
    menu.dialog = {_: 'dialog', peerId, unread_count: 3, top_message: 12345, pFlags: {}};
    await menu.onUnreadClick();
    // #348: the explicit-read branch is conversation-scoped, so a topic gesture
    // must not reach it — it would clear every topic in the chat.
    expect(resetUnread).not.toHaveBeenCalled();
    expect(markDialogUnread).not.toHaveBeenCalledWith({peerId, read: true});
    expect(readHistory).toHaveBeenCalledWith({peerId, maxId: 12345, threadId});
  });
});
