/**
 * appendLocalHistoryMessage — worker-side history persistence for locally
 * injected PhantomChat messages (P2P outgoing bubble, incoming relay message).
 *
 * Regression: the injection paths painted via a main-thread `history_append`
 * dispatch plus a mirror write, and only called `setMessageToStorage` — which
 * stores the message OBJECT but never inserts the mid into
 * `historyStorage.history` (the mid slice the chat view renders from on
 * reopen when the bottom slice is already cached). A sent (or live-received)
 * message showed in the preview and the open chat, but was MISSING after
 * leaving and reopening the chat, and only reappeared after a full app
 * restart forced a real getHistory from IndexedDB.
 *
 * These tests drive the REAL appendLocalHistoryMessage against a real
 * SlicedArray, so reverting to a plain setMessageToStorage fails them.
 */
import 'fake-indexeddb/auto';
import {describe, it, expect, vi, beforeEach} from 'vitest';
import SlicedArray, {SliceEnd} from '@helpers/slicedArray';
import {AppMessagesManager} from '@lib/appManagers/appMessagesManager';

const PEER_ID = 1234567890123456 as any;

function makeManager(existingMids: number[] = []) {
  const history = new SlicedArray<number>();
  // Seed a descending bottom-ended slice (newest first), mimicking a chat
  // whose bottom page is already cached — the reopen scenario.
  if(existingMids.length) {
    history.first.push(...existingMids);
    history.first.setEnd(SliceEnd.Bottom);
  }

  const historyStorage: any = {
    history,
    count: existingMids.length,
    _maxId: existingMids[0] ?? 0,
    get maxId() { return this._maxId; }
  };

  const manager = Object.create(AppMessagesManager.prototype) as AppMessagesManager;
  const setMessageToStorage = vi.fn();
  const setDialogTopMessage = vi.fn();
  Object.assign(manager as any, {
    getHistoryMessagesStorage: vi.fn(() => `${PEER_ID}_history`),
    setMessageToStorage,
    getHistoryStorage: vi.fn(() => historyStorage),
    setDialogTopMessage
  });

  return {manager, history, historyStorage, setMessageToStorage, setDialogTopMessage};
}

function makeMsg(mid: number) {
  return {_: 'message', mid, peerId: PEER_ID, date: mid} as any;
}

describe('appendLocalHistoryMessage', () => {
  let ctx: ReturnType<typeof makeManager>;

  beforeEach(() => {
    ctx = makeManager([10, 7, 5]);
  });

  it('stores the message object in the history messages storage', () => {
    const msg = makeMsg(8);
    ctx.manager.appendLocalHistoryMessage(msg);

    expect(ctx.setMessageToStorage).toHaveBeenCalledWith(`${PEER_ID}_history`, msg);
  });

  it('inserts the mid into the cached bottom slice in descending order', () => {
    ctx.manager.appendLocalHistoryMessage(makeMsg(8));

    expect([...ctx.history.first]).toEqual([10, 8, 7, 5]);
    expect(ctx.historyStorage.count).toBe(4);
  });

  it('unshifts a newest mid to the front and bumps maxId', () => {
    ctx.manager.appendLocalHistoryMessage(makeMsg(12));

    expect([...ctx.history.first]).toEqual([12, 10, 7, 5]);
    expect(ctx.historyStorage.maxId).toBe(12);
  });

  it('appends an oldest mid to the end of the slice', () => {
    ctx.manager.appendLocalHistoryMessage(makeMsg(3));

    expect([...ctx.history.first]).toEqual([10, 7, 5, 3]);
  });

  it('is idempotent for a mid already in the slice (relay echo / dedup)', () => {
    ctx.manager.appendLocalHistoryMessage(makeMsg(7));

    expect([...ctx.history.first]).toEqual([10, 7, 5]);
    expect(ctx.historyStorage.count).toBe(3);
    // Object store is still refreshed (delivery-state heals land there).
    expect(ctx.setMessageToStorage).toHaveBeenCalled();
  });

  it('handles an empty history storage (first message in a fresh chat)', () => {
    const fresh = makeManager([]);
    fresh.manager.appendLocalHistoryMessage(makeMsg(42));

    expect([...fresh.history.first]).toEqual([42]);
    expect(fresh.historyStorage.maxId).toBe(42);
  });

  it('bumps the dialog top_message via setDialogTopMessage', () => {
    const msg = makeMsg(8);
    ctx.manager.appendLocalHistoryMessage(msg);

    expect(ctx.setDialogTopMessage).toHaveBeenCalledWith(msg);
  });

  it('no-ops on a message without peerId or mid', () => {
    ctx.manager.appendLocalHistoryMessage({_: 'message'} as any);

    expect(ctx.setMessageToStorage).not.toHaveBeenCalled();
  });
});

/**
 * Regression: the optimistic media bubble (voice note, attachment) used a
 * negative temp mid. Group bubbles sort by mid, so it rendered above the whole
 * loaded history, out of sight, until the chat was reopened.
 */
describe('optimistic media temp mid', () => {
  async function tempMidOfSend(now: number) {
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const invokeApi = vi.fn().mockResolvedValue({});
    const manager = Object.create(AppMessagesManager.prototype) as any;
    Object.assign(manager, {
      appPeersManager: {getPeerMigratedTo: () => 0},
      apiManager: {invokeApi},
      getHistoryMessagesStorage: () => new Map(),
      phantomchatSendFileCounter: 0,
      log: Object.assign(vi.fn(), {error: vi.fn()}),
      rootScope: {dispatchEvent: vi.fn()}
    });
    await manager.sendFileViaBridge({peerId: PEER_ID, file: new Blob(['x'], {type: 'audio/ogg'}), isVoiceMessage: true});
    const tempMid = invokeApi.mock.calls[0][1].tempMid as number;
    vi.restoreAllMocks();
    return tempMid;
  }

  it('sorts newer than a real mid minted earlier', async() => {
    const nowMs = 1793620000500;
    const earlierRealMid = (Math.floor(nowMs / 1000) - 1) * 1_000_000 + 999_999;
    expect(await tempMidOfSend(nowMs)).toBeGreaterThan(earlierRealMid);
  });
});

describe('replaceLocalTempMessage', () => {
  const TEMP = 1793620000500001;
  const REAL = 1793620000600002;

  function makeSwapManager(mids: number[], stored: Record<number, any>, topMessage: number | null = TEMP) {
    const history = new SlicedArray<number>();
    history.first.push(...mids);
    history.first.setEnd(SliceEnd.Bottom);
    const historyStorage: any = {history, count: mids.length, _maxId: mids[0], get maxId() { return this._maxId; }};
    const storage = new Map<number, any>(Object.entries(stored).map(([k, v]) => [+k, v]));
    const dialog: any = topMessage === null ? undefined : {_: 'dialog', peerId: PEER_ID, top_message: topMessage};
    const manager = Object.create(AppMessagesManager.prototype) as any;
    Object.assign(manager, {
      getHistoryMessagesStorage: () => storage,
      getHistoryStorage: () => historyStorage,
      getDialogOnly: () => dialog,
      deleteMessageFromStorage: (s: Map<number, any>, mid: number) => s.delete(mid),
      setMessageToStorage: (s: Map<number, any>, m: any) => s.set(m.mid, m),
      // setDialogTopMessage is deliberately not stubbed: the swap's rewind came from
      // its default dialog argument, which a stub hides.
      dialogsStorage: {generateIndexForDialog: vi.fn()},
      scheduleHandleNewDialogs: vi.fn()
    });
    return {manager, history, historyStorage, storage, dialog};
  }

  const temp = {...makeMsg(TEMP), id: TEMP, media: {_: 'messageMediaDocument'}};

  it('moves the temp row and its media to the real mid, so reopen shows one bubble', () => {
    const ctx = makeSwapManager([TEMP, 10], {[TEMP]: temp});
    ctx.manager.replaceLocalTempMessage(PEER_ID, TEMP, REAL);

    expect([...ctx.history.first]).toEqual([REAL, 10]);
    expect(ctx.storage.has(TEMP)).toBe(false);
    expect(ctx.storage.get(REAL)).toMatchObject({id: REAL, mid: REAL, media: temp.media});
    expect(ctx.historyStorage.count).toBe(2);
    expect(ctx.dialog.top_message).toBe(REAL);
    expect(ctx.historyStorage.maxId).toBe(REAL);
  });

  it('leaves the dialog on a newer message that arrived during the upload', () => {
    const NEWER = REAL + 1_000_000;
    const ctx = makeSwapManager([NEWER, TEMP, 10], {[TEMP]: temp}, NEWER);
    ctx.manager.replaceLocalTempMessage(PEER_ID, TEMP, REAL);

    expect([...ctx.history.first]).toEqual([NEWER, REAL, 10]);
    expect(ctx.dialog.top_message).toBe(NEWER);
    expect(ctx.historyStorage.maxId).toBe(NEWER);
  });

  it('moves maxId off the deleted temp mid when the peer has no dialog', () => {
    const ctx = makeSwapManager([TEMP, 10], {[TEMP]: temp}, null);
    ctx.manager.replaceLocalTempMessage(PEER_ID, TEMP, REAL);

    expect(ctx.historyStorage.maxId).toBe(REAL);
  });

  it('keeps a real row already loaded instead of clobbering it', () => {
    const real = {...makeMsg(REAL), id: REAL, media: {_: 'real'}};
    const ctx = makeSwapManager([REAL, TEMP, 10], {[TEMP]: temp, [REAL]: real});
    ctx.manager.replaceLocalTempMessage(PEER_ID, TEMP, REAL);

    expect([...ctx.history.first]).toEqual([REAL, 10]);
    expect(ctx.storage.get(REAL)).toBe(real);
    expect(ctx.historyStorage.count).toBe(2);
  });

  it('does nothing when the temp row is gone (after a reload)', () => {
    const ctx = makeSwapManager([10], {});
    ctx.manager.replaceLocalTempMessage(PEER_ID, TEMP, REAL);

    expect([...ctx.history.first]).toEqual([10]);
    expect(ctx.storage.has(REAL)).toBe(false);
  });
});

/** #396 residuals from the temp-mid swap. */
describe('temp-mid swap residuals (#396)', () => {
  const TEMP = 1793620000500001;
  const REAL = 1793620000600002;

  function swapCtx(mids: number[], stored: Record<number, any>, count: number) {
    const history = new SlicedArray<number>();
    history.first.push(...mids);
    history.first.setEnd(SliceEnd.Bottom);
    const historyStorage: any = {history, count, _maxId: mids[0], get maxId() { return this._maxId; }};
    const storage = new Map<number, any>(Object.entries(stored).map(([k, v]) => [+k, v]));
    const manager = Object.create(AppMessagesManager.prototype) as any;
    Object.assign(manager, {
      getHistoryMessagesStorage: () => storage,
      getHistoryStorage: () => historyStorage,
      getDialogOnly: (): any => undefined,
      deleteMessageFromStorage: (s: Map<number, any>, mid: number) => s.delete(mid),
      setMessageToStorage: (s: Map<number, any>, m: any) => s.set(m.mid, m),
      dialogsStorage: {generateIndexForDialog: vi.fn()},
      scheduleHandleNewDialogs: vi.fn()
    });
    return {manager, historyStorage};
  }

  it('does not drift the count when a rebuilt slice already dropped the temp mid', () => {
    // The temp row is still stored, its mid is no longer in the slice, the
    // real mid is not there either: the swap replaces one counted row.
    const ctx = swapCtx([10, 7], {[TEMP]: {...makeMsg(TEMP), id: TEMP}}, 3);
    ctx.manager.replaceLocalTempMessage(PEER_ID, TEMP, REAL);
    expect(ctx.historyStorage.count).toBe(3);
  });

  it.each([0, 998, 999])('reserves concurrent temp mids past occupied rows and counter wrap (%i)', async(counter) => {
    const nowMs = 1793620000500;
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const occupied = nowMs * 1000 + 1;
    const storage = new Map<number, any>([[occupied, makeMsg(occupied)]]);
    const invokeApi = vi.fn().mockResolvedValue({});
    const manager = Object.create(AppMessagesManager.prototype) as any;
    Object.assign(manager, {
      appPeersManager: {getPeerMigratedTo: () => 0},
      apiManager: {invokeApi},
      getHistoryMessagesStorage: () => storage,
      phantomchatSendFileCounter: counter,
      log: Object.assign(vi.fn(), {error: vi.fn()}),
      rootScope: {dispatchEvent: vi.fn()}
    });
    await Promise.all([
      manager.sendFileViaBridge({peerId: PEER_ID, file: new Blob(['x'], {type: 'image/png'})}),
      manager.sendFileViaBridge({peerId: PEER_ID, file: new Blob(['y'], {type: 'image/png'})})
    ]);
    const minted = invokeApi.mock.calls.map((call: any[]) => call[1].tempMid);
    expect(new Set(minted).size).toBe(2);
    const tempMid = minted[0] as number;
    vi.restoreAllMocks();
    expect(tempMid).not.toBe(occupied);
    expect(storage.has(tempMid)).toBe(false);
  });
});
