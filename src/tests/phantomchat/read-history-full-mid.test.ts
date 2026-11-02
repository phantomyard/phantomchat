import 'fake-indexeddb/auto';
import {beforeAll, describe, expect, it, vi} from 'vitest';
import getServerMessageId from '@appManagers/utils/messageId/getServerMessageId';

let AppMessagesManager: typeof import('@appManagers/appMessagesManager').AppMessagesManager;
beforeAll(async() => {
  ({AppMessagesManager} = await import('@appManagers/appMessagesManager'));
}, 30000);

describe('readHistory preserves PhantomChat chronological mids across the Worker bridge', () => {
  it.each([1_000_000_000_000_001, -8_000_000_000_000_001, -12_000_000_000_000_002, 42])('peer %s', async(peerId) => {
    const maxId = 1_793_543_210_123_456;
    const history = {};
    const invokeApi = vi.fn().mockResolvedValue({pts: 1, pts_count: 0});
    const localUpdate = vi.fn();
    const manager = Object.assign(Object.create(AppMessagesManager.prototype), {
      log: vi.fn(),
      getReadMaxIdIfUnread: () => 1,
      getHistoryStorage: () => history,
      apiManager: {invokeApi},
      apiUpdatesManager: {processLocalUpdate: localUpdate},
      appPeersManager: {
        isChannel: () => false,
        getInputPeerById: () => peerId < 0 ? {_: 'inputPeerChat', chat_id: -peerId} : {_: 'inputPeerUser', user_id: peerId},
        getOutputPeer: () => ({_: 'peerUser', user_id: peerId}),
        getPeerString: () => ''
      },
      rootScope: {dispatchEvent: vi.fn()}
    });
    await manager.readHistory({peerId, maxId, force: true});
    expect(invokeApi).toHaveBeenCalledWith('messages.readHistory', {
      peer: expect.anything(), max_id: peerId === 42 ? getServerMessageId(maxId) : maxId
    });
    expect(localUpdate).toHaveBeenCalledWith(expect.objectContaining({_: 'updateReadHistoryInbox', max_id: maxId}));
  });
});

describe('cold reply fetch preserves PhantomChat full mids and conversation context (#325)', () => {
  it.each([1_000_000_000_000_001, -8_000_000_000_000_001, -12_000_000_000_000_002, 42])('peer %s', async(peerId) => {
    const mid = 1_793_639_334_616_956;
    const resolve = vi.fn();
    const peer = {_: peerId < 0 ? 'inputPeerChat' : 'inputPeerUser', [peerId < 0 ? 'chat_id' : 'user_id']: Math.abs(peerId)};
    const invokeApiSingle = vi.fn().mockResolvedValue({messages: [{id: mid, mid}], users: [], chats: []});
    const manager = Object.assign(Object.create(AppMessagesManager.prototype), {
      needSingleMessages: new Map([[peerId, new Map([[mid, {resolve}]])]]),
      apiManager: {invokeApiSingle},
      appPeersManager: {isChannel: () => false, getInputPeerById: () => peer},
      appMessagesIdsManager: {generateMessageId: (id) => id},
      saveApiResult: vi.fn(), deletedMessages: new Set(),
      rootScope: {dispatchEvent: vi.fn()}
    });
    await manager.fetchSingleMessages();
    expect(invokeApiSingle).toHaveBeenCalledWith('messages.getMessages', {
      id: [{_: 'inputMessageID', id: peerId === 42 ? getServerMessageId(mid) : mid}],
      ...(peerId === 42 ? {} : {peer})
    });
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({id: mid}));
    expect(manager.deletedMessages.size).toBe(0);
  });
});
