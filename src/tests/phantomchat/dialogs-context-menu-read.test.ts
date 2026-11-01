import 'fake-indexeddb/auto';
import {beforeAll, describe, expect, it, vi} from 'vitest';

const resetUnread = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@lib/phantomchat/phantomchat-message-handler', () => ({resetUnreadForPeer: resetUnread}));
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
