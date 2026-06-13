import {describe, it, expect, beforeEach} from 'vitest';
import {
  getLastPublishedAt,
  setLastPublishedAt,
  getLastModifiedAt,
  setLastModifiedAt,
  LS_KEY_LAST_PUBLISHED,
  LS_KEY_LAST_MODIFIED
} from '@lib/nostra/folders-sync-state';

describe('folders-sync-state', () => {
  beforeEach(() => {
    localStorage.removeItem(LS_KEY_LAST_PUBLISHED);
    localStorage.removeItem(LS_KEY_LAST_MODIFIED);
  });

  it('returns 0 when no published timestamp stored', () => {
    expect(getLastPublishedAt()).toBe(0);
  });

  it('returns 0 when no modified timestamp stored', () => {
    expect(getLastModifiedAt()).toBe(0);
  });

  it('roundtrips published timestamp', () => {
    setLastPublishedAt(1234567890);
    expect(getLastPublishedAt()).toBe(1234567890);
  });

  it('roundtrips modified timestamp', () => {
    setLastModifiedAt(1234567891);
    expect(getLastModifiedAt()).toBe(1234567891);
  });

  it('localStorage keys match the expected spec strings', () => {
    expect(LS_KEY_LAST_PUBLISHED).toBe('nostra-folders-last-published');
    expect(LS_KEY_LAST_MODIFIED).toBe('nostra-folders-last-modified');
  });

  it('returns 0 for corrupted localStorage values (non-numeric)', () => {
    localStorage.setItem(LS_KEY_LAST_PUBLISHED, 'not-a-number');
    expect(getLastPublishedAt()).toBe(0);
  });
});
