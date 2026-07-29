/**
 * Regression tests for issue #99 — messages vanish after backgrounding / bfcache.
 *
 * Root cause: on a SharedWorker reconnect (which happens when the PWA is
 * backgrounded or restored from bfcache) the worker re-mirrors all history
 * storages at once. For P2P chats the mirrored SlicedArray can be partial or
 * zeroed (message bodies live in IndexedDB, read directly by the VMT; the
 * cache can also be invalidated by device-sync), so blindly replacing the
 * main-thread history store blanked the open conversation.
 *
 * The fix lives in applyMirroredHistoryStorage (@stores/historyStorages): the
 * mirror-all branch now UNIONs instead of replacing — it never shrinks a
 * non-empty in-memory history with a smaller/empty snapshot. These tests call
 * that *real* helper against the *real* history store and SlicedArray, so a
 * revert of the union guard fails them directly (no source-string guard).
 */

import '../setup';
import {describe, it, expect, beforeEach} from 'vitest';

import SlicedArray from '@helpers/slicedArray';
import {
  _useHistoryStorage,
  _deleteHistoryStorage,
  _iterateHistoryStorages,
  applyMirroredHistoryStorage,
  countHistoryItems
} from '@stores/historyStorages';

function makeHistory(ids: number[]) {
  const sliced = new SlicedArray<number>();
  if(ids.length) sliced.insertSlice(ids);
  return sliced;
}

// * A serialized worker snapshot, shaped like what mirrorAllMessages sends.
function makeSnapshot(ids: number[], count: number) {
  return {
    type: 'history',
    key: KEY,
    count,
    historySerialized: makeHistory(ids).toJSON()
  } as any;
}

const KEY = 'history_1000000000000042_undefined';

describe('issue #99 — history mirror union guard', () => {
  beforeEach(() => {
    const keys: string[] = [];
    _iterateHistoryStorages((key) => keys.push(key as string));
    keys.forEach((key) => _deleteHistoryStorage(key as any));
  });

  it('adopts an incoming snapshot into an empty store', () => {
    applyMirroredHistoryStorage(KEY as any, makeSnapshot([3, 2, 1], 3));

    const [store] = _useHistoryStorage(KEY as any);
    expect(countHistoryItems(store.history)).toBe(3);
  });

  it('does NOT shrink a populated history with an empty snapshot', () => {
    applyMirroredHistoryStorage(KEY as any, makeSnapshot([3, 2, 1], 3));
    // Simulate the backgrounding re-mirror arriving zeroed.
    applyMirroredHistoryStorage(KEY as any, makeSnapshot([], 0));

    const [store] = _useHistoryStorage(KEY as any);
    expect(countHistoryItems(store.history)).toBe(3);
  });

  it('does NOT shrink a populated history with a partial snapshot', () => {
    applyMirroredHistoryStorage(KEY as any, makeSnapshot([5, 4, 3, 2, 1], 5));
    // A partial snapshot (only the newest two) must not blank the rest.
    applyMirroredHistoryStorage(KEY as any, makeSnapshot([2, 1], 2));

    const [store] = _useHistoryStorage(KEY as any);
    expect(countHistoryItems(store.history)).toBe(5);
  });

  it('preserves the existing count when a partial snapshot is rejected', () => {
    applyMirroredHistoryStorage(KEY as any, makeSnapshot([3, 2, 1], 3));
    applyMirroredHistoryStorage(KEY as any, makeSnapshot([], 0));

    const [store] = _useHistoryStorage(KEY as any);
    expect(store.count).toBe(3);
  });

  it('adopts a larger snapshot (real growth still flows through)', () => {
    applyMirroredHistoryStorage(KEY as any, makeSnapshot([3, 2, 1], 3));
    applyMirroredHistoryStorage(KEY as any, makeSnapshot([5, 4, 3, 2, 1], 5));

    const [store] = _useHistoryStorage(KEY as any);
    expect(countHistoryItems(store.history)).toBe(5);
  });
});
