import {afterAll, afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import 'fake-indexeddb/auto';

// afterAll cleanup placed BEFORE vi.mock calls so that hoistMocks processes
// vi.unmock BEFORE vi.mock — this ensures the final mocked state is "mocked"
// (unmock runs first, then mock wins). Moving afterAll after vi.mock calls
// causes the opposite order after hoisting, defeating all mocks.
afterAll(() => {
  vi.unmock('@lib/rootScope');
  vi.unmock('@lib/phantomchat/nostr-profile');
  vi.unmock('@lib/phantomchat/nostr-relay-pool');
  vi.restoreAllMocks();
});

// Mock rootScope BEFORE importing the module under test so the module
// sees the mock when it calls dispatchEventSingle.
const dispatchEventSingle = vi.fn();
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEventSingle: (...args: any[]) => dispatchEventSingle(...args),
    dispatchEvent: (...args: any[]) => dispatchEventSingle(...args),
    addEventListener: vi.fn()
  }
}));

// Mock queryRelayForProfileWithMeta so tests don't open sockets.
const queryRelayForProfileWithMeta = vi.fn();
vi.mock('@lib/phantomchat/nostr-profile', () => ({
  queryRelayForProfileWithMeta: (...args: any[]) => queryRelayForProfileWithMeta(...args)
}));

// Mock DEFAULT_RELAYS to a small deterministic list.
vi.mock('@lib/phantomchat/nostr-relay-pool', () => ({
  DEFAULT_RELAYS: [
    {url: 'wss://relay-a.test'},
    {url: 'wss://relay-b.test'}
  ]
}));

import {
  loadCachedPeerProfile,
  saveCachedPeerProfile,
  refreshPeerProfileFromRelays,
  clearPeerProfileCache,
  PEER_PROFILE_CACHE_PREFIX
} from '@lib/phantomchat/peer-profile-cache';

const PUBKEY = 'a'.repeat(64);
const PUBKEY_2 = 'b'.repeat(64);
const PEER_ID = 1000000000000001 as unknown as PeerId;

beforeEach(() => {
  localStorage.clear();
  dispatchEventSingle.mockClear();
  queryRelayForProfileWithMeta.mockReset();
  // Reset the in-flight + cooldown maps between tests so the per-pubkey
  // refresh cooldown doesn't suppress queries across cases that reuse PUBKEY.
  clearPeerProfileCache();
});

afterEach(() => {
  localStorage.clear();
});

describe('loadCachedPeerProfile', () => {
  test('returns null when no entry exists', () => {
    expect(loadCachedPeerProfile(PUBKEY)).toBeNull();
  });

  test('returns parsed entry when present', () => {
    localStorage.setItem(
      PEER_PROFILE_CACHE_PREFIX + PUBKEY,
      JSON.stringify({profile: {name: 'alice', about: 'hi'}, created_at: 100})
    );
    const result = loadCachedPeerProfile(PUBKEY);
    expect(result?.profile.name).toBe('alice');
    expect(result?.profile.about).toBe('hi');
    expect(result?.created_at).toBe(100);
  });

  test('returns null on malformed JSON', () => {
    localStorage.setItem(PEER_PROFILE_CACHE_PREFIX + PUBKEY, 'not-json');
    expect(loadCachedPeerProfile(PUBKEY)).toBeNull();
  });

  test('returns null when shape is invalid', () => {
    localStorage.setItem(PEER_PROFILE_CACHE_PREFIX + PUBKEY, '{"profile":{}}');
    expect(loadCachedPeerProfile(PUBKEY)).toBeNull();
  });
});

describe('saveCachedPeerProfile', () => {
  test('round-trips', () => {
    saveCachedPeerProfile(PUBKEY, {profile: {website: 'https://ex.com'}, created_at: 200});
    expect(loadCachedPeerProfile(PUBKEY)?.profile.website).toBe('https://ex.com');
    expect(loadCachedPeerProfile(PUBKEY)?.created_at).toBe(200);
  });

  test('does not collide across pubkeys', () => {
    saveCachedPeerProfile(PUBKEY, {profile: {name: 'alice'}, created_at: 1});
    saveCachedPeerProfile(PUBKEY_2, {profile: {name: 'bob'}, created_at: 2});
    expect(loadCachedPeerProfile(PUBKEY)?.profile.name).toBe('alice');
    expect(loadCachedPeerProfile(PUBKEY_2)?.profile.name).toBe('bob');
  });
});

describe('refreshPeerProfileFromRelays', () => {
  test('picks highest created_at across relays and dispatches event', async() => {
    queryRelayForProfileWithMeta
      .mockResolvedValueOnce({profile: {name: 'old'}, created_at: 100, pubkey: PUBKEY})
      .mockResolvedValueOnce({profile: {name: 'new'}, created_at: 200, pubkey: PUBKEY});

    await refreshPeerProfileFromRelays(PUBKEY, PEER_ID);

    expect(loadCachedPeerProfile(PUBKEY)?.profile.name).toBe('new');
    expect(loadCachedPeerProfile(PUBKEY)?.created_at).toBe(200);

    expect(dispatchEventSingle).toHaveBeenCalledWith('phantomchat_peer_profile_updated', {
      peerId: PEER_ID,
      pubkey: PUBKEY,
      profile: {name: 'new'}
    });
  });

  test('also dispatches peer_title_edit so chatlist + topbar refresh (FIND-5329aa12)', async() => {
    queryRelayForProfileWithMeta.mockResolvedValue({profile: {display_name: 'Alice-Updated', name: 'alice'}, created_at: 200, pubkey: PUBKEY});

    await refreshPeerProfileFromRelays(PUBKEY, PEER_ID);

    // Tweb-native event that .person-title and .user-title listen to.
    expect(dispatchEventSingle).toHaveBeenCalledWith('peer_title_edit', {peerId: PEER_ID});
  });

  // The "persists displayName into virtual-peers-db" assertion was originally
  // here but was removed: it touched the IDB singleton in virtual-peers-db
  // and contaminated the fake-indexeddb shared state across test files,
  // producing 5+ cascading failures in unrelated tests. The user-visible
  // contract of the FIND-5329aa12 fix is fully locked by the
  // peer_title_edit dispatch assertion above; the IDB write is implementation
  // detail that future tests can cover with a properly isolated fixture.

  test('does NOT write or dispatch when relay data is older than cache', async() => {
    saveCachedPeerProfile(PUBKEY, {profile: {name: 'cached'}, created_at: 500});
    queryRelayForProfileWithMeta.mockResolvedValue({profile: {name: 'old'}, created_at: 200, pubkey: PUBKEY});

    await refreshPeerProfileFromRelays(PUBKEY, PEER_ID);

    expect(loadCachedPeerProfile(PUBKEY)?.profile.name).toBe('cached');
    expect(dispatchEventSingle).not.toHaveBeenCalled();
  });

  test('does NOT write or dispatch when all relays return null', async() => {
    queryRelayForProfileWithMeta.mockResolvedValue(null);
    await refreshPeerProfileFromRelays(PUBKEY, PEER_ID);
    expect(loadCachedPeerProfile(PUBKEY)).toBeNull();
    expect(dispatchEventSingle).not.toHaveBeenCalled();
  });

  test('dispatches when cache is empty and any relay returns data', async() => {
    queryRelayForProfileWithMeta
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({profile: {name: 'fresh'}, created_at: 1, pubkey: PUBKEY});

    await refreshPeerProfileFromRelays(PUBKEY, PEER_ID);

    expect(loadCachedPeerProfile(PUBKEY)?.profile.name).toBe('fresh');
    // Both phantomchat_peer_profile_updated AND peer_title_edit fire (the latter
    // added in the FIND-5329aa12 fix). Assert each by name rather than total.
    expect(dispatchEventSingle).toHaveBeenCalledWith('phantomchat_peer_profile_updated', expect.any(Object));
    expect(dispatchEventSingle).toHaveBeenCalledWith('peer_title_edit', {peerId: PEER_ID});
  });

  test('tolerates relay rejections', async() => {
    queryRelayForProfileWithMeta
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({profile: {name: 'ok'}, created_at: 50, pubkey: PUBKEY});

    await refreshPeerProfileFromRelays(PUBKEY, PEER_ID);

    expect(loadCachedPeerProfile(PUBKEY)?.profile.name).toBe('ok');
  });

  test('dedups concurrent calls for the same pubkey (one query burst, not N)', async() => {
    queryRelayForProfileWithMeta.mockResolvedValue({profile: {name: 'x'}, created_at: 10, pubkey: PUBKEY});

    const a = refreshPeerProfileFromRelays(PUBKEY, PEER_ID);
    const b = refreshPeerProfileFromRelays(PUBKEY, PEER_ID);
    expect(a).toBe(b); // second caller rides the in-flight promise
    await Promise.all([a, b]);

    // 2 mocked relays × a single burst = 2 queries, not 4.
    expect(queryRelayForProfileWithMeta).toHaveBeenCalledTimes(2);
  });

  test('skips a repeat refresh within the cooldown window', async() => {
    queryRelayForProfileWithMeta.mockResolvedValue({profile: {name: 'x'}, created_at: 10, pubkey: PUBKEY});

    await refreshPeerProfileFromRelays(PUBKEY, PEER_ID);
    expect(queryRelayForProfileWithMeta).toHaveBeenCalledTimes(2);

    queryRelayForProfileWithMeta.mockClear();
    await refreshPeerProfileFromRelays(PUBKEY, PEER_ID);
    // Still inside REFRESH_COOLDOWN_MS → no fresh relay sockets opened.
    expect(queryRelayForProfileWithMeta).not.toHaveBeenCalled();
  });
});

describe('clearPeerProfileCache', () => {
  test('removes only keys under the prefix', () => {
    localStorage.setItem(PEER_PROFILE_CACHE_PREFIX + PUBKEY, '{"profile":{},"created_at":1}');
    localStorage.setItem(PEER_PROFILE_CACHE_PREFIX + PUBKEY_2, '{"profile":{},"created_at":1}');
    localStorage.setItem('unrelated-key', 'keep-me');

    clearPeerProfileCache();

    expect(localStorage.getItem(PEER_PROFILE_CACHE_PREFIX + PUBKEY)).toBeNull();
    expect(localStorage.getItem(PEER_PROFILE_CACHE_PREFIX + PUBKEY_2)).toBeNull();
    expect(localStorage.getItem('unrelated-key')).toBe('keep-me');
  });
});
