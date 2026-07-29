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
 * The mirror-all branch in apiManagerProxy.ts now UNIONs instead of replacing:
 * it never shrinks a non-empty in-memory history with a smaller/empty snapshot.
 *
 * These tests replicate that branch verbatim against the *real* history store
 * and the *real* SlicedArray, and a source guard asserts the production code
 * still carries the union logic (so a revert fails CI).
 */

import '../setup';
import {describe, it, expect, beforeEach} from 'vitest';
import {readFileSync} from 'fs';
import {resolve} from 'path';

import SlicedArray from '@helpers/slicedArray';
import {
  _useHistoryStorage,
  _deleteHistoryStorage,
  _iterateHistoryStorages
} from '@stores/historyStorages';

// * Mirror of the helper added to apiManagerProxy.ts.
function countHistoryItems(sliced: SlicedArray<any> | undefined) {
  return sliced ? sliced.slices.reduce((total, slice) => total + slice.length, 0) : 0;
}

// * Verbatim replica of the mirror-all history branch (union guard).
function applyMirroredHistory(key: string, historyStorage: any) {
  const [existingHistoryStorage, setHistoryStorage] = _useHistoryStorage(key as any);

  const incomingHistory = SlicedArray.fromJSON<number>(historyStorage.historySerialized);
  delete historyStorage.historySerialized;

  if(countHistoryItems(incomingHistory) >= countHistoryItems(existingHistoryStorage.history)) {
    setHistoryStorage('history', incomingHistory);
  } else {
    delete historyStorage.count;
  }

  setHistoryStorage(historyStorage);
}

function makeHistory(ids: number[]) {
  const sliced = new SlicedArray<number>();
  if(ids.length) sliced.insertSlice(ids);
  return sliced;
}

// * A serialized worker snapshot, shaped like what mirrorAllMessages sends.
function makeSnapshot(ids: number[], count: number) {
  return {
    type: 'history',
    key: 'history_1000000000000042_undefined',
    count,
    historySerialized: makeHistory(ids).toJSON()
  };
}

const KEY = 'history_1000000000000042_undefined';

describe('issue #99 — history mirror union guard', () => {
  beforeEach(() => {
    const keys: string[] = [];
    _iterateHistoryStorages((key) => keys.push(key as string));
    keys.forEach((key) => _deleteHistoryStorage(key as any));
  });

  it('adopts an incoming snapshot into an empty store', () => {
    applyMirroredHistory(KEY, makeSnapshot([3, 2, 1], 3));

    const [store] = _useHistoryStorage(KEY as any);
    expect(countHistoryItems(store.history)).toBe(3);
  });

  it('does NOT shrink a populated history with an empty snapshot', () => {
    applyMirroredHistory(KEY, makeSnapshot([3, 2, 1], 3));
    // Simulate the backgrounding re-mirror arriving zeroed.
    applyMirroredHistory(KEY, makeSnapshot([], 0));

    const [store] = _useHistoryStorage(KEY as any);
    expect(countHistoryItems(store.history)).toBe(3);
  });

  it('does NOT shrink a populated history with a partial snapshot', () => {
    applyMirroredHistory(KEY, makeSnapshot([5, 4, 3, 2, 1], 5));
    // A partial snapshot (only the newest two) must not blank the rest.
    applyMirroredHistory(KEY, makeSnapshot([2, 1], 2));

    const [store] = _useHistoryStorage(KEY as any);
    expect(countHistoryItems(store.history)).toBe(5);
  });

  it('preserves the existing count when a partial snapshot is rejected', () => {
    applyMirroredHistory(KEY, makeSnapshot([3, 2, 1], 3));
    applyMirroredHistory(KEY, makeSnapshot([], 0));

    const [store] = _useHistoryStorage(KEY as any);
    expect(store.count).toBe(3);
  });

  it('adopts a larger snapshot (real growth still flows through)', () => {
    applyMirroredHistory(KEY, makeSnapshot([3, 2, 1], 3));
    applyMirroredHistory(KEY, makeSnapshot([5, 4, 3, 2, 1], 5));

    const [store] = _useHistoryStorage(KEY as any);
    expect(countHistoryItems(store.history)).toBe(5);
  });

  it('source guard: production mirror branch still carries the union logic', () => {
    const src = readFileSync(
      resolve(__dirname, '../../lib/apiManagerProxy.ts'),
      'utf8'
    );
    expect(src).toContain('countHistoryItems');
    expect(src).toMatch(/countHistoryItems\(incomingHistory\)\s*>=\s*countHistoryItems\(existingHistoryStorage\.history\)/);
  });
});
