import {describe, it, expect} from 'vitest';
import {isProtectedFolder} from '@lib/phantomchat/folders-protection';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_GROUPS
} from '@appManagers/constants';

describe('isProtectedFolder', () => {
  it('returns true for All/Archive/Groups', () => {
    expect(isProtectedFolder(FOLDER_ID_ALL)).toBe(true);
    expect(isProtectedFolder(FOLDER_ID_ARCHIVE)).toBe(true);
    expect(isProtectedFolder(FOLDER_ID_GROUPS)).toBe(true);
  });

  it('returns false for the removed Persons folder (id 2)', () => {
    expect(isProtectedFolder(2)).toBe(false);
  });

  it('returns false for user custom folder IDs', () => {
    expect(isProtectedFolder(4)).toBe(false);
    expect(isProtectedFolder(42)).toBe(false);
    expect(isProtectedFolder(999)).toBe(false);
  });
});
