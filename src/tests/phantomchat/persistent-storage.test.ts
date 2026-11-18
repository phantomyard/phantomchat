import {describe, it, expect, vi} from 'vitest';
import {requestPersistentStorage} from '@lib/phantomchat/persistent-storage';

describe('requestPersistentStorage', () => {
  it('asks once and reports a grant', async() => {
    const persist = vi.fn(async() => true);
    expect(await requestPersistentStorage({persisted: async() => false, persist})).toBe('granted');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('does not ask again when storage is already persistent', async() => {
    const persist = vi.fn(async() => true);
    expect(await requestPersistentStorage({persisted: async() => true, persist})).toBe('persisted');
    expect(persist).not.toHaveBeenCalled();
  });

  it('reports a denial without throwing', async() => {
    expect(await requestPersistentStorage({persisted: async() => false, persist: async() => false})).toBe('denied');
  });

  it('is a no-op where the API is missing', async() => {
    expect(await requestPersistentStorage(undefined)).toBe('unsupported');
    expect(await requestPersistentStorage({})).toBe('unsupported');
  });

  it('swallows a rejecting persist()', async() => {
    expect(await requestPersistentStorage({persist: async() => { throw new Error('nope'); }})).toBe('error');
  });
});
