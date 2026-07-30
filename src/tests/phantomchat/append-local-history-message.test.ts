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
