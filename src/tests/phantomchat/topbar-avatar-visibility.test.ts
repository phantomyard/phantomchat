import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect} from 'vitest';
import {shouldShowTopbarAvatar} from '@lib/phantomchat/topbar-avatar';

describe('top bar avatar visibility', () => {
  it('hides the avatar when the left bar has a single item', () => {
    expect(shouldShowTopbarAvatar(1)).toBe(false);
  });

  it('hides the avatar when the left bar is empty', () => {
    expect(shouldShowTopbarAvatar(0)).toBe(false);
  });

  it('shows the avatar with two contacts', () => {
    expect(shouldShowTopbarAvatar(2)).toBe(true);
  });

  it('shows the avatar with a contact and a group', () => {
    expect(shouldShowTopbarAvatar(3)).toBe(true);
  });

  it('tolerates negative garbage counts by hiding', () => {
    expect(shouldShowTopbarAvatar(-1)).toBe(false);
  });
});
