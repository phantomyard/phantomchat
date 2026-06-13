/*
 * Nostra.chat — Own profile cache
 *
 * localStorage-backed cache of the user's own kind 0 metadata. Populated
 * from the relay on boot and on every save. Enables the profile edit tab
 * (and the sidebar menu entry) to render instantly with cached values on
 * subsequent sessions, including across devices once the fetch-sync
 * background refresh runs.
 *
 * The cache stores `created_at` alongside the profile so conflict
 * resolution can pick the newest version when multiple devices edit
 * the same identity concurrently.
 */

import type {NostrProfile} from './nostr-profile';

const CACHE_KEY = 'nostra-profile-cache';
const LEGACY_EXTRAS_KEY = 'nostra-profile-extras';

export interface CachedProfile {
  profile: NostrProfile;
  created_at: number;
}

export function loadCachedProfile(): CachedProfile | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if(raw) {
      const parsed = JSON.parse(raw);
      if(parsed && typeof parsed.created_at === 'number' && parsed.profile) {
        return parsed as CachedProfile;
      }
    }
  } catch{ /* ignore */ }

  // Legacy migration: the previous implementation (PR #11) stored
  // {website, lud16} under nostra-profile-extras with no created_at.
  // Read it once, convert, and delete the old key.
  try {
    const legacyRaw = localStorage.getItem(LEGACY_EXTRAS_KEY);
    if(legacyRaw) {
      const extras = JSON.parse(legacyRaw);
      localStorage.removeItem(LEGACY_EXTRAS_KEY);
      if(extras && (extras.website || extras.lud16)) {
        const migrated: CachedProfile = {
          profile: {
            website: extras.website || undefined,
            lud16: extras.lud16 || undefined
          },
          created_at: 0 // unknown — any fetched event will win
        };
        saveCachedProfile(migrated);
        return migrated;
      }
    }
  } catch{ /* ignore */ }

  return null;
}

export function saveCachedProfile(cached: CachedProfile): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cached));
  } catch{ /* storage full / disabled — silently drop */ }
}

export function clearCachedProfile(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(LEGACY_EXTRAS_KEY);
  } catch{ /* ignore */ }
}
