/**
 * setMessageToStorage never-clobber guard (2026-10-05 restart regression).
 *
 * PhantomChat media lives in the phantomchat store (fileMetadata on the row)
 * and is built into tweb message objects by every stored-row → tweb-message
 * builder. tweb never re-fetches a cached history window, so the moment a
 * media-LESS copy of an already-cached media-bearing mid lands in the
 * messages storage, the bubble renders as an empty `is-message-empty` shell
 * forever — even though the store still has the fileMetadata. Several
 * builders shipped that clobber (dialog previews, cleared dialogs, search);
 * those are fixed at the source, and this guard is the backstop for any
 * writer that slips through.
 *
 * Media is append-only in this app (no edit can remove it), so carrying the
 * cached media over is always correct.
 */
import '../setup';
import 'fake-indexeddb/auto';
import {describe, it, expect, vi, beforeEach} from 'vitest';

// The mirror write isn't initialised under jsdom — stub the port.
const mockInvokeVoid = vi.fn();
vi.mock('@lib/mainWorker/mainMessagePort', () => ({
  default: {
    getInstance: () => ({invokeVoid: mockInvokeVoid})
  }
}));

import {AppMessagesManager} from '@lib/appManagers/appMessagesManager';

const PEER_ID = 1234567890123456 as any;
const MID = 1700000123; // timestamp-based phantomchat mid (< MESSAGE_ID_OFFSET)

function makeStorage(peerId: number) {
  const storage: any = new Map();
  storage.type = 'history';
  storage.peerId = peerId;
  storage.key = `${peerId}_history`;
  return storage;
}

function makeManager() {
  const main = makeStorage(PEER_ID);
  const global = makeStorage(0); // GLOBAL_HISTORY_PEER_ID = NULL_PEER_ID = 0
  const manager = Object.create(AppMessagesManager.prototype) as AppMessagesManager;
  Object.assign(manager as any, {
    getMessagesStorage: vi.fn((s: any) => s),
    getGlobalHistoryMessagesStorage: vi.fn(() => global)
  });
  return {manager, main, global};
}

function mediaMessage(mid: number) {
  return {
    _: 'message',
    mid,
    peerId: PEER_ID,
    date: mid,
    message: 'voice caption',
    media: {_: 'messageMediaDocument', document: {_: 'document', id: `p2p_${mid}`}}
  } as any;
}

function bareMessage(mid: number, text = 'preview text') {
  return {_: 'message', mid, peerId: PEER_ID, date: mid, message: text} as any;
}

describe('setMessageToStorage never-clobber guard', () => {
  beforeEach(() => {
    mockInvokeVoid.mockClear();
  });

  it('a media-less copy cannot overwrite a cached media-bearing message — media carries over', () => {
    const {manager, main} = makeManager();
    const incoming = bareMessage(MID);

    manager.setMessageToStorage(main as any, mediaMessage(MID));
    manager.setMessageToStorage(main as any, incoming);

    const stored = (main as any).get(MID);
    expect(stored.media).toBeDefined();
    expect(stored.media._).toBe('messageMediaDocument');
    // The caller's object is healed too — dialog.topMessage references it,
    // so the sidebar preview gets the media, not just the cache entry.
    expect(incoming.media).toBeDefined();
    expect(incoming.media._).toBe('messageMediaDocument');
  });

  it('a media-bearing incoming message is stored as-is (no guard interference)', () => {
    const {manager, main} = makeManager();
    const fresh = mediaMessage(MID);

    manager.setMessageToStorage(main as any, bareMessage(MID));
    manager.setMessageToStorage(main as any, fresh);

    const stored = (main as any).get(MID);
    expect(stored).toBe(fresh);
    expect(stored.media).toBe(fresh.media);
  });

  it('two media-less messages (text chat) store normally — guard never fires', () => {
    const {manager, main} = makeManager();

    manager.setMessageToStorage(main as any, bareMessage(MID, 'first'));
    manager.setMessageToStorage(main as any, bareMessage(MID, 'second'));

    const stored = (main as any).get(MID);
    expect(stored.message).toBe('second');
    expect(stored.media).toBeUndefined();
  });

  it('service messages are exempt from the carry-over (own id space)', () => {
    const {manager, main} = makeManager();
    const service = {_: 'messageService', mid: MID, peerId: PEER_ID, date: MID, action: {_: 'messageActionChatCreate'}} as any;

    manager.setMessageToStorage(main as any, mediaMessage(MID));
    manager.setMessageToStorage(main as any, service);

    const stored = (main as any).get(MID);
    expect(stored._).toBe('messageService');
    expect(stored.media).toBeUndefined();
    expect((service as any).media).toBeUndefined();
  });

  it('messageMediaEmpty counts as "no media" and still carries the cached media over', () => {
    const {manager, main} = makeManager();
    const empty = bareMessage(MID);
    (empty as any).media = {_: 'messageMediaEmpty'};

    manager.setMessageToStorage(main as any, mediaMessage(MID));
    manager.setMessageToStorage(main as any, empty);

    const stored = (main as any).get(MID);
    expect(stored.media._).toBe('messageMediaDocument');
  });

  it('the carried media also lands in the worker mirror value', () => {
    const {manager, main} = makeManager();
    const incoming = bareMessage(MID);

    manager.setMessageToStorage(main as any, mediaMessage(MID));
    manager.setMessageToStorage(main as any, incoming);

    const mirrorCall = mockInvokeVoid.mock.calls.find((c) => (c[0] as any) === 'mirror');
    expect(mirrorCall).toBeDefined();
    // args: ('mirror', {name, key, value, accountNumber})
    const lastMirror = mockInvokeVoid.mock.calls.at(-1)![1] as any;
    expect(lastMirror.value.media).toBeDefined();
  });
});
