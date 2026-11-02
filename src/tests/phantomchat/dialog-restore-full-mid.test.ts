import 'fake-indexeddb/auto';
import {describe, expect, it, vi} from 'vitest';
import DialogsStorage from '@lib/storages/dialogs';
import getServerMessageId from '@appManagers/utils/messageId/getServerMessageId';

// Exercise the real cold-restore entry point, including its lookup after save.
// The old conversion inserted mid % 2^32 next to getDialogs' real top mid.
describe('cached dialog restore preserves PhantomChat history anchors (#325)', () => {
  it.each([
    [1_000_000_000_000_001, true],
    [-8_000_000_000_000_001, true],
    [-12_000_000_000_000_002, true],
    [42, false],
    [-42, false]
  ])('peer %s', (peerId, phantomChat) => {
    const mid = 1_793_639_334_616_956;
    const dialog = {peerId, top_message: mid, topMessage: {mid}};
    const saveDialog = vi.fn();
    const reloadConversation = vi.fn();
    const getMessageByPeer = vi.fn(() => dialog.topMessage);
    const storage = Object.assign(Object.create(DialogsStorage.prototype), {
      saveDialog,
      appMessagesManager: {saveMessages: vi.fn(), getMessageByPeer, reloadConversation}
    });
    storage.setDialogsFromState([dialog]);
    const expected = phantomChat ? mid : getServerMessageId(mid);
    expect(saveDialog).toHaveBeenCalledWith({dialog: expect.objectContaining({top_message: expected}), ignoreOffsetDate: true});
    expect(getMessageByPeer).toHaveBeenCalledWith(peerId, expected);
    expect(reloadConversation).not.toHaveBeenCalled();
  });
});
