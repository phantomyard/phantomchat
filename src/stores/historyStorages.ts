import type {HistoryStorage, HistoryStorageKey} from '@appManagers/appMessagesManager';
import {createStore} from 'solid-js/store';
import createHistoryStorage from '@appManagers/utils/messages/createHistoryStorage';
import {MOUNT_CLASS_TO} from '@config/debug';
import SlicedArray from '@helpers/slicedArray';

type S = ReturnType<typeof createStore<HistoryStorage>>;

const cache: {
  [key in HistoryStorageKey]: S
} = {};

export default function useHistoryStorage(key: HistoryStorageKey) {
  if(!key) return;
  return _useHistoryStorage(key)[0];
}

export function _useHistoryStorage(key: HistoryStorageKey) {
  return cache[key] ??= createStore(createHistoryStorage(key));
}

export function _deleteHistoryStorage(key: HistoryStorageKey) {
  delete cache[key];
}

export function _changeHistoryStorageKey(key: HistoryStorageKey, newKey: HistoryStorageKey) {
  if(key === newKey) return;
  cache[newKey] = cache[key];
  delete cache[key];
}

export function _iterateHistoryStorages(callback: (key: HistoryStorageKey, value: S) => void) {
  for(const i in cache) {
    callback(i as HistoryStorageKey, cache[i as HistoryStorageKey]);
  }
}

// * Total number of items a SlicedArray holds across all of its slices.
// * SlicedArray.length only reports the first slice, which is not a reliable
// * measure of "how complete is this history" when comparing snapshots.
export function countHistoryItems(sliced: SlicedArray<any> | undefined) {
  return sliced ? sliced.slices.reduce((total, slice) => total + slice.length, 0) : 0;
}

// * Apply one serialized history-storage snapshot from the worker's
// * "mirror everything at once" pass into the main-thread store.
// *
// * A worker snapshot can arrive partial or zeroed — e.g. after a SharedWorker
// * reconnect on app backgrounding / bfcache restore, or after device-sync
// * calls invalidateHistoryCache. For P2P chats the message bodies live in
// * IndexedDB (the VMT reads them straight from there), so the mirrored
// * SlicedArray can be shorter than what is already rendered on the main
// * thread. Replacing wholesale would blank the open conversation (issue #99).
// * We only adopt the incoming history when it is at least as complete as the
// * one we already hold; otherwise we keep the richer in-memory history — and
// * its matching count — intact.
// *
// * NOTE: the `>=` guard deliberately keeps the stale (larger) history on a
// * *legitimate* remote shrink too — e.g. the peer genuinely deleted messages.
// * That is safe because a real deletion arrives separately as a `delete` /
// * `history_reload` mirror op that reconciles the store downstream, so we
// * never strand deleted bubbles; we only refuse the ambiguous full-snapshot
// * shrink that caused #99.
export function applyMirroredHistoryStorage(key: HistoryStorageKey, historyStorage: any) {
  const [existingHistoryStorage, setHistoryStorage] = _useHistoryStorage(key);

  if(historyStorage.searchHistorySerialized) {
    setHistoryStorage(
      'searchHistory',
      SlicedArray.fromJSON<`${PeerId}_${number}`>(historyStorage.searchHistorySerialized)
    );
    delete historyStorage.searchHistorySerialized;
  } else {
    const incomingHistory = SlicedArray.fromJSON<number>(historyStorage.historySerialized);
    delete historyStorage.historySerialized;

    if(countHistoryItems(incomingHistory) >= countHistoryItems(existingHistoryStorage.history)) {
      setHistoryStorage('history', incomingHistory);
    } else {
      // Keep the richer in-memory history — and its matching count — intact.
      delete historyStorage.count;
    }
  }

  setHistoryStorage(historyStorage);
}

MOUNT_CLASS_TO && (MOUNT_CLASS_TO.historyStorages = cache);
