import '../setup';
import {describe, it, expect, beforeEach} from 'vitest';

// Import the module directly (no heavy mocks needed)
import {_useHistoryStorage, _changeHistoryStorageKey, _deleteHistoryStorage, _iterateHistoryStorages} from '@stores/historyStorages';

describe('historyStorages', () => {
  beforeEach(() => {
    // Purge in-memory cache so tests don't cross-contaminate
    _iterateHistoryStorages((key, value) => {
      _deleteHistoryStorage(key);
    });
  });

  describe('_useHistoryStorage', () => {
    it('caches stores by key', () => {
      const [s1] = _useHistoryStorage('history_42_undefined' as any);
      const [s2] = _useHistoryStorage('history_42_undefined' as any);
      expect(s1).toBe(s2);
    });
  });

  describe('_changeHistoryStorageKey', () => {
    it('migrates a cache entry from old key to new key', () => {
      const oldKey = 'history_42_undefined' as any;
      const newKey = 'history_42_inputMessagesFilterEmpty' as any;

      const [s1, set1] = _useHistoryStorage(oldKey);
      set1('count', 7);

      _changeHistoryStorageKey(oldKey, newKey);
      const [s2] = _useHistoryStorage(newKey);

      expect(s2.count).toBe(7);
      const [sGone] = _useHistoryStorage(oldKey);
      expect(sGone.count).toBeNull();
    });

    it('is a no-op when key and newKey are identical', () => {
      const key = 'history_42_undefined' as any;
      const [s1, set1] = _useHistoryStorage(key);
      set1('count', 5);

      _changeHistoryStorageKey(key, key);

      const [s2] = _useHistoryStorage(key);
      expect(s2.count).toBe(5);
    });
  });
});
