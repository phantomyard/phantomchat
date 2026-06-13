/**
 * Unit tests for profile-cache + own-profile-sync.
 *
 * Covers:
 *   - localStorage cache load/save/clear
 *   - Legacy nostra-profile-extras migration
 *   - Cache-first hydration dispatches nostra_identity_updated
 *   - Background refresh with cache newer → no update
 *   - Background refresh with relay newer → update
 *   - Optimistic save merges with existing cache
 */
import {describe, it, expect, beforeEach, vi, afterEach} from 'vitest';

// Mock rootScope BEFORE importing the modules under test so the dispatch spy
// captures all events.
const dispatchSingleSpy = vi.fn();
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEventSingle: (...args: any[]) => dispatchSingleSpy(...args),
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  }
}));

// Mock the relay fetch so we can control what the "relay" returns.
const fetchOwnKind0Spy = vi.fn();
vi.mock('@lib/nostra/nostr-profile', async() => {
  return {
    fetchOwnKind0: (...args: any[]) => fetchOwnKind0Spy(...args)
  };
});

import {
  loadCachedProfile,
  saveCachedProfile,
  clearCachedProfile
} from '@lib/nostra/profile-cache';
import {
  hydrateOwnProfileFromCache,
  refreshOwnProfileFromRelays,
  saveOwnProfileLocal
} from '@lib/nostra/own-profile-sync';

function mockLocalStorage(): void {
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for(const k of Object.keys(store)) delete store[k]; }
  });
}

describe('profile-cache', () => {
  beforeEach(() => {
    mockLocalStorage();
    dispatchSingleSpy.mockReset();
    fetchOwnKind0Spy.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when no cache is present', () => {
    expect(loadCachedProfile()).toBeNull();
  });

  it('round-trips a saved profile', () => {
    const input = {
      profile: {name: 'alice', about: 'hi', website: 'https://alice.test'},
      created_at: 1700000000
    };
    saveCachedProfile(input);
    const loaded = loadCachedProfile();
    expect(loaded).toEqual(input);
  });

  it('migrates legacy nostra-profile-extras to the new cache key', () => {
    localStorage.setItem('nostra-profile-extras', JSON.stringify({
      website: 'https://legacy.test',
      lud16: 'alice@legacy.test'
    }));

    const loaded = loadCachedProfile();
    expect(loaded).not.toBeNull();
    expect(loaded!.profile.website).toBe('https://legacy.test');
    expect(loaded!.profile.lud16).toBe('alice@legacy.test');
    expect(loaded!.created_at).toBe(0);
    // Legacy key must be removed after migration
    expect(localStorage.getItem('nostra-profile-extras')).toBeNull();
    // New key must contain the migrated data
    expect(localStorage.getItem('nostra-profile-cache')).not.toBeNull();
  });

  it('clears both new and legacy keys', () => {
    saveCachedProfile({profile: {name: 'x'}, created_at: 1});
    localStorage.setItem('nostra-profile-extras', '{}');

    clearCachedProfile();

    expect(localStorage.getItem('nostra-profile-cache')).toBeNull();
    expect(localStorage.getItem('nostra-profile-extras')).toBeNull();
  });
});

describe('own-profile-sync: hydrate', () => {
  beforeEach(() => {
    mockLocalStorage();
    dispatchSingleSpy.mockReset();
    fetchOwnKind0Spy.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null and dispatches nothing when cache is empty', () => {
    const result = hydrateOwnProfileFromCache();
    expect(result).toBeNull();
    expect(dispatchSingleSpy).not.toHaveBeenCalled();
  });

  it('dispatches nostra_identity_updated from the cache', () => {
    saveCachedProfile({
      profile: {
        name: 'alice',
        display_name: 'Alice',
        about: 'Hi there',
        website: 'https://alice.test',
        lud16: 'alice@ln.test',
        picture: 'https://img.test/a.png',
        nip05: 'alice@verified.test'
      },
      created_at: 1700000000
    });

    const result = hydrateOwnProfileFromCache();
    expect(result).not.toBeNull();
    expect(dispatchSingleSpy).toHaveBeenCalledTimes(1);
    const [eventName, payload] = dispatchSingleSpy.mock.calls[0];
    expect(eventName).toBe('nostra_identity_updated');
    expect(payload.displayName).toBe('Alice');
    expect(payload.about).toBe('Hi there');
    expect(payload.website).toBe('https://alice.test');
    expect(payload.lud16).toBe('alice@ln.test');
    expect(payload.picture).toBe('https://img.test/a.png');
    expect(payload.nip05).toBe('alice@verified.test');
  });
});

describe('own-profile-sync: refresh from relays', () => {
  beforeEach(() => {
    mockLocalStorage();
    dispatchSingleSpy.mockReset();
    fetchOwnKind0Spy.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('skips update when cache is newer than relay', async() => {
    saveCachedProfile({
      profile: {name: 'local'},
      created_at: 2000
    });
    fetchOwnKind0Spy.mockResolvedValueOnce({
      profile: {name: 'remote'},
      created_at: 1000,
      pubkey: 'abc'
    });

    const result = await refreshOwnProfileFromRelays('abc');
    expect(result?.profile.name).toBe('local');
    // Cache kept; no update event fired for a stale relay version
    expect(dispatchSingleSpy).not.toHaveBeenCalled();
  });

  it('updates cache and dispatches when relay is newer', async() => {
    saveCachedProfile({
      profile: {name: 'local', about: 'old bio'},
      created_at: 1000
    });
    fetchOwnKind0Spy.mockResolvedValueOnce({
      profile: {name: 'remote', about: 'new bio', website: 'https://new.test'},
      created_at: 2000,
      pubkey: 'abc'
    });

    const result = await refreshOwnProfileFromRelays('abc');
    expect(result).not.toBeNull();
    expect(result!.profile.name).toBe('remote');
    expect(result!.profile.about).toBe('new bio');
    expect(result!.profile.website).toBe('https://new.test');
    expect(result!.created_at).toBe(2000);

    // Event dispatched with the fresh values
    expect(dispatchSingleSpy).toHaveBeenCalledTimes(1);
    const [eventName, payload] = dispatchSingleSpy.mock.calls[0];
    expect(eventName).toBe('nostra_identity_updated');
    expect(payload.displayName).toBe('remote');
    expect(payload.about).toBe('new bio');

    // Cache persisted
    const reloaded = loadCachedProfile();
    expect(reloaded?.profile.name).toBe('remote');
    expect(reloaded?.created_at).toBe(2000);
  });

  it('returns null if the relay fetch returns nothing', async() => {
    fetchOwnKind0Spy.mockResolvedValueOnce(null);
    const result = await refreshOwnProfileFromRelays('abc');
    expect(result).toBeNull();
    expect(dispatchSingleSpy).not.toHaveBeenCalled();
  });

  it('returns null and logs on fetch error', async() => {
    fetchOwnKind0Spy.mockRejectedValueOnce(new Error('net down'));
    const result = await refreshOwnProfileFromRelays('abc');
    expect(result).toBeNull();
    expect(dispatchSingleSpy).not.toHaveBeenCalled();
  });
});

describe('own-profile-sync: optimistic save', () => {
  beforeEach(() => {
    mockLocalStorage();
    dispatchSingleSpy.mockReset();
    fetchOwnKind0Spy.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('merges new fields with existing cache', () => {
    saveCachedProfile({
      profile: {
        name: 'alice',
        display_name: 'Alice',
        about: 'Old bio',
        website: 'https://old.test',
        lud16: 'alice@old.test'
      },
      created_at: 1000
    });

    saveOwnProfileLocal({
      name: 'alice',
      display_name: 'Alice',
      about: 'New bio',
      website: 'https://old.test', // unchanged
      lud16: 'alice@old.test'      // unchanged
    }, 2000);

    const reloaded = loadCachedProfile();
    expect(reloaded?.profile.about).toBe('New bio');
    expect(reloaded?.profile.website).toBe('https://old.test');
    expect(reloaded?.created_at).toBe(2000);

    expect(dispatchSingleSpy).toHaveBeenCalledTimes(1);
    const [, payload] = dispatchSingleSpy.mock.calls[0];
    expect(payload.about).toBe('New bio');
  });

  it('creates a new cache entry when none exists', () => {
    saveOwnProfileLocal({
      name: 'bob',
      display_name: 'Bob',
      website: 'https://bob.test'
    }, 3000);

    const reloaded = loadCachedProfile();
    expect(reloaded).not.toBeNull();
    expect(reloaded!.profile.name).toBe('bob');
    expect(reloaded!.created_at).toBe(3000);
  });
});
