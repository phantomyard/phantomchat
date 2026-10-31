import {describe, it, expect} from 'vitest';
import {isProtectedFolder} from '@lib/phantomchat/folders-protection';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_SESSION,
  FOLDER_ID_GROUPS
} from '@appManagers/constants';

describe('isProtectedFolder', () => {
  it('returns true for All/Archives/Groups/Sessions', () => {
    expect(isProtectedFolder(FOLDER_ID_ALL)).toBe(true);
    expect(isProtectedFolder(FOLDER_ID_ARCHIVE)).toBe(true);
    expect(isProtectedFolder(FOLDER_ID_GROUPS)).toBe(true);
    expect(isProtectedFolder(FOLDER_ID_SESSION)).toBe(true);
  });

  it('returns false for the removed Persons folder (id 2)', () => {
    expect(isProtectedFolder(2)).toBe(false);
  });

  it('returns false for user custom folder IDs', () => {
    // 4 is Sessions, so the first custom id is START_LOCAL_ID (5). Id 5 was
    // the Session Archive for one preview build and is gone (owner batch 12).
    expect(isProtectedFolder(5)).toBe(false);
    expect(isProtectedFolder(6)).toBe(false);
    expect(isProtectedFolder(42)).toBe(false);
    expect(isProtectedFolder(999)).toBe(false);
  });
});
