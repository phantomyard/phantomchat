/**
 * #267 — preferred chat folder on startup (device-local setting).
 *
 * Pins the pure decision logic in @lib/folders-default:
 *  - All Chats stays the fallback when nothing is preferred, when the
 *    preferred folder no longer exists, and for a normalized "All Chats"
 *    preference (storing FOLDER_ID_ALL is the same as no preference).
 *  - A deep link to a chat always wins over the preference.
 */

import {describe, it, expect} from 'vitest';
import {
  DEFAULT_CHAT_FOLDER_SETTING_KEY,
  effectiveDefaultFolderId,
  startupFolderId
} from '@lib/folders-default';
import {FOLDER_ID_ALL, FOLDER_ID_GROUPS} from '@appManagers/constants';

const AVAILABLE = [FOLDER_ID_ALL, FOLDER_ID_GROUPS, 10];

describe('effectiveDefaultFolderId', () => {
  it('falls back to All Chats when nothing is preferred', () => {
    expect(effectiveDefaultFolderId(undefined, AVAILABLE)).toBe(FOLDER_ID_ALL);
  });

  it('normalizes an All Chats preference to the fallback', () => {
    expect(effectiveDefaultFolderId(FOLDER_ID_ALL, AVAILABLE)).toBe(FOLDER_ID_ALL);
  });

  it('falls back to All Chats when the preferred folder no longer exists', () => {
    expect(effectiveDefaultFolderId(999, AVAILABLE)).toBe(FOLDER_ID_ALL);
  });

  it('keeps a preferred folder that exists (custom and system)', () => {
    expect(effectiveDefaultFolderId(10, AVAILABLE)).toBe(10);
    expect(effectiveDefaultFolderId(FOLDER_ID_GROUPS, AVAILABLE)).toBe(FOLDER_ID_GROUPS);
  });

  it('ignores non-integer garbage instead of throwing', () => {
    expect(effectiveDefaultFolderId(NaN, AVAILABLE)).toBe(FOLDER_ID_ALL);
    expect(effectiveDefaultFolderId(1.5 as any, AVAILABLE)).toBe(FOLDER_ID_ALL);
  });
});

describe('startupFolderId', () => {
  it('deep link takes precedence over a valid preference', () => {
    expect(startupFolderId({
      preferred: 10,
      availableFilterIds: AVAILABLE,
      launchedWithDeepLink: true
    })).toBe(FOLDER_ID_ALL);
  });

  it('applies the preference on a normal launch', () => {
    expect(startupFolderId({
      preferred: 10,
      availableFilterIds: AVAILABLE,
      launchedWithDeepLink: false
    })).toBe(10);
  });

  it('falls back to All Chats when the preferred folder vanished before boot', () => {
    expect(startupFolderId({
      preferred: 10,
      availableFilterIds: [FOLDER_ID_ALL, FOLDER_ID_GROUPS],
      launchedWithDeepLink: false
    })).toBe(FOLDER_ID_ALL);
  });
});

describe('setting key', () => {
  it('lives under the common app settings store', () => {
    expect(DEFAULT_CHAT_FOLDER_SETTING_KEY).toBe('defaultChatFolderId');
  });
});
