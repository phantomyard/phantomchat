# Peer Kind 0 Profile — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every published kind 0 field (about, website, lud16, nip05) for other users in the right-sidebar User Info tab, using an SWR cache so values appear instantly on subsequent opens.

**Architecture:** New per-peer `localStorage` cache + relay refresh mirror the existing own-profile SWR pattern. `NostraMTProtoServer.getFullUser` hydrates `UserFull.about` from the cache and kicks off a background refresh. A new Solid store `usePeerNostraProfile(peerId)` feeds four rows in `PeerProfile.MainSection`; rows are `<Show>`-gated so non-P2P peers are unaffected.

**Tech Stack:** TypeScript, Solid.js (custom fork), Vitest + fake-indexeddb, Nostr relays via existing WebSocket helpers.

**Spec:** `docs/superpowers/specs/2026-04-15-peer-kind0-profile-design.md`

**Pre-existing facts the plan relies on (verified before writing):**
- `src/lib/nostra/virtual-peers-db.ts` exports `getPubkey(peerId: number): Promise<string | null>` at line 171.
- `src/lib/nostra/nostr-profile.ts` defines `queryRelayForProfileWithMeta` as a file-local helper and exports `NostrProfile`, `NostrProfileWithMeta`, `fetchOwnKind0`.
- `src/lib/nostra/profile-cache.ts` is the structural template (single-key SWR cache, `CachedProfile` shape).
- `src/lib/rootScope.ts` has `BroadcastEvents` at ~line 249 with `nostra_identity_updated` already defined as a type literal.
- `src/lib/nostra/virtual-mtproto-server.ts:596` is `getFullUser`, currently returns `about: ''`.
- `src/lib/nostra/nostra-cleanup.ts` has a `NOSTRA_LS_KEYS` array and a loop at line 106 that calls `localStorage.removeItem` for each. It does NOT currently include `nostra-profile-cache` — we only add peer keys here, own-profile cleanup is out of scope.
- Icon set (`src/icons.ts`) has `link`, `email`, `gift_premium`, `info`. There is **no** `lightning`/`bolt` icon; we use `gift_premium` for lud16.
- `peerProfile.tsx:1426` is `PeerProfile.MainSection`.
- Row component API: `src/components/rowTsx.tsx` (used throughout `peerProfile.tsx` — check there for `Row.Icon` / `Row.Title` / `Row.Subtitle` / `contextMenu` shapes).
- `copyTextToClipboard` from `@helpers/clipboard` and `safeWindowOpen` from `@helpers/dom/safeWindowOpen` are already imported in `peerProfile.tsx`.

---

## File Structure

**Created:**
- `src/lib/nostra/peer-profile-cache.ts` — per-peer SWR cache, relay refresh, event dispatch
- `src/stores/peerNostraProfile.ts` — Solid store hook `usePeerNostraProfile(peerId)`
- `src/tests/nostra/peer-profile-cache.test.ts` — unit tests

**Modified:**
- `src/lib/nostra/nostr-profile.ts` — export `queryRelayForProfileWithMeta`
- `src/lib/rootScope.ts` — add `nostra_peer_profile_updated` event type
- `src/lib/nostra/virtual-mtproto-server.ts` — `getFullUser` hydration + background refresh
- `src/lib/nostra/nostra-cleanup.ts` — wipe `nostra-peer-profile-cache:*` keys
- `src/components/peerProfile.tsx` — three new row components + call sites in `MainSection`; Bio fallback for P2P
- `src/tests/nostra/nostr-profile.test.ts` (only if tests break from exporting the symbol — no logic change expected)

---

## Task 1: Export `queryRelayForProfileWithMeta`

**Files:**
- Modify: `src/lib/nostra/nostr-profile.ts:112` (add `export`)

Minimal refactor: the function is already implemented, we just expose it.

- [ ] **Step 1: Add `export` keyword**

Edit `src/lib/nostra/nostr-profile.ts` line 112 from:

```typescript
function queryRelayForProfileWithMeta(relayUrl: string, pubkey: string): Promise<NostrProfileWithMeta | null> {
```

to:

```typescript
export function queryRelayForProfileWithMeta(relayUrl: string, pubkey: string): Promise<NostrProfileWithMeta | null> {
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "nostr-profile" || echo "clean"`
Expected: `clean`

- [ ] **Step 3: Run existing profile tests**

Run: `npx vitest run src/tests/nostra/nostr-profile.test.ts src/tests/nostra/kind0-fetch.test.ts`
Expected: all pass (no logic change; only visibility).

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/nostr-profile.ts
git commit -m "refactor(nostra): export queryRelayForProfileWithMeta for reuse"
```

---

## Task 2: Add `nostra_peer_profile_updated` event type

**Files:**
- Modify: `src/lib/rootScope.ts:249` (area around `nostra_identity_updated`)

- [ ] **Step 1: Inspect the current event shape**

Run: `grep -n "nostra_identity_updated\|nostra_identity_loaded" src/lib/rootScope.ts`
Expected: one or two lines inside `BroadcastEvents` interface/type. Note the line for precise placement.

- [ ] **Step 2: Add the new event just below `nostra_identity_updated`**

Add this line (immediately after the `nostra_identity_updated` entry):

```typescript
'nostra_peer_profile_updated': {peerId: PeerId, pubkey: string, profile: import('./nostra/nostr-profile').NostrProfile},
```

Using the inline `import('./nostra/nostr-profile')` avoids adding a top-of-file import that pulls Nostra modules into every consumer of `rootScope.ts`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "rootScope|nostra_peer_profile_updated" || echo "clean"`
Expected: `clean`

- [ ] **Step 4: Commit**

```bash
git add src/lib/rootScope.ts
git commit -m "feat(nostra): add nostra_peer_profile_updated rootScope event"
```

---

## Task 3: Peer profile cache — failing tests first

**Files:**
- Create: `src/tests/nostra/peer-profile-cache.test.ts`

Tests describe the contract; they MUST fail in this task (module does not exist yet).

- [ ] **Step 1: Write the test file**

```typescript
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import 'fake-indexeddb/auto';

// Mock rootScope BEFORE importing the module under test so the module
// sees the mock when it calls dispatchEvent.
const dispatchEventSingle = vi.fn();
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEventSingle,
    dispatchEvent: dispatchEventSingle
  }
}));

// Mock queryRelayForProfileWithMeta so tests don't open sockets.
const queryRelayForProfileWithMeta = vi.fn();
vi.mock('@lib/nostra/nostr-profile', () => ({
  queryRelayForProfileWithMeta: (...args: any[]) => queryRelayForProfileWithMeta(...args)
}));

// Mock DEFAULT_RELAYS to a small deterministic list.
vi.mock('@lib/nostra/nostr-relay-pool', () => ({
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
} from '@lib/nostra/peer-profile-cache';

const PUBKEY = 'a'.repeat(64);
const PUBKEY_2 = 'b'.repeat(64);
const PEER_ID = 1000000000000001 as unknown as PeerId;

beforeEach(() => {
  localStorage.clear();
  dispatchEventSingle.mockClear();
  queryRelayForProfileWithMeta.mockReset();
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

    expect(dispatchEventSingle).toHaveBeenCalledWith('nostra_peer_profile_updated', {
      peerId: PEER_ID,
      pubkey: PUBKEY,
      profile: {name: 'new'}
    });
  });

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
    expect(dispatchEventSingle).toHaveBeenCalledTimes(1);
  });

  test('tolerates relay rejections', async() => {
    queryRelayForProfileWithMeta
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({profile: {name: 'ok'}, created_at: 50, pubkey: PUBKEY});

    await refreshPeerProfileFromRelays(PUBKEY, PEER_ID);

    expect(loadCachedPeerProfile(PUBKEY)?.profile.name).toBe('ok');
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
```

- [ ] **Step 2: Run tests — expect module-not-found failures**

Run: `npx vitest run src/tests/nostra/peer-profile-cache.test.ts`
Expected: FAIL with `Cannot find module '@lib/nostra/peer-profile-cache'`.

- [ ] **Step 3: Commit**

```bash
git add src/tests/nostra/peer-profile-cache.test.ts
git commit -m "test(nostra): add failing peer-profile-cache contract tests"
```

---

## Task 4: Implement `peer-profile-cache.ts`

**Files:**
- Create: `src/lib/nostra/peer-profile-cache.ts`

- [ ] **Step 1: Write the module**

```typescript
/*
 * Nostra.chat — Peer profile cache
 *
 * Per-peer kind 0 metadata cache. Parallels profile-cache.ts (which
 * handles the user's own profile) but keyed by peer pubkey so multiple
 * peers can be cached side-by-side. Each entry stores created_at for
 * conflict resolution when the same pubkey publishes new kind 0 events
 * from another client.
 *
 * Consumers: virtual-mtproto-server.ts (hydrates UserFull.about on
 * users.getFullUser) and stores/peerNostraProfile.ts (drives the
 * right-sidebar User Info rows).
 */

import rootScope from '@lib/rootScope';
import {DEFAULT_RELAYS} from './nostr-relay-pool';
import {queryRelayForProfileWithMeta, type NostrProfile} from './nostr-profile';

export const PEER_PROFILE_CACHE_PREFIX = 'nostra-peer-profile-cache:';

const LOG_PREFIX = '[PeerProfileCache]';

export interface CachedPeerProfile {
  profile: NostrProfile;
  created_at: number;
}

export function loadCachedPeerProfile(pubkey: string): CachedPeerProfile | null {
  try {
    const raw = localStorage.getItem(PEER_PROFILE_CACHE_PREFIX + pubkey);
    if(!raw) return null;
    const parsed = JSON.parse(raw);
    if(parsed && typeof parsed.created_at === 'number' && parsed.profile && typeof parsed.profile === 'object') {
      return parsed as CachedPeerProfile;
    }
    return null;
  } catch{
    return null;
  }
}

export function saveCachedPeerProfile(pubkey: string, cached: CachedPeerProfile): void {
  try {
    localStorage.setItem(PEER_PROFILE_CACHE_PREFIX + pubkey, JSON.stringify(cached));
  } catch{
    // storage full / disabled — silently drop
  }
}

/**
 * Query every configured relay in parallel for a peer's kind 0 event,
 * keep the newest (highest created_at), and — only if strictly newer
 * than the cached entry — persist and dispatch `nostra_peer_profile_updated`.
 *
 * Returns when all relay queries have settled. Intended to be fired
 * without awaiting in hot paths.
 */
export async function refreshPeerProfileFromRelays(pubkey: string, peerId: PeerId): Promise<void> {
  const relayUrls = DEFAULT_RELAYS.map((r) => r.url);
  const results = await Promise.all(
    relayUrls.map((url) => queryRelayForProfileWithMeta(url, pubkey).catch(() => null))
  );

  let best: {profile: NostrProfile, created_at: number} | null = null;
  for(const r of results) {
    if(!r) continue;
    if(!best || r.created_at > best.created_at) best = r;
  }
  if(!best) return;

  const cached = loadCachedPeerProfile(pubkey);
  if(cached && best.created_at <= cached.created_at) {
    return;
  }

  saveCachedPeerProfile(pubkey, {profile: best.profile, created_at: best.created_at});
  console.log(`${LOG_PREFIX} refreshed ${pubkey.slice(0, 8)}... created_at=${best.created_at}`);

  // dispatchEventSingle (not dispatchEvent) — CLAUDE.md: main-thread VMT-adjacent
  // code must not forward via MTProtoMessagePort.
  rootScope.dispatchEventSingle('nostra_peer_profile_updated', {
    peerId,
    pubkey,
    profile: best.profile
  });
}

/**
 * Remove every peer profile cache entry. Called from nostra-cleanup on
 * logout. Iterates localStorage because entries are keyed by pubkey
 * and we don't track which pubkeys we've seen.
 */
export function clearPeerProfileCache(): void {
  try {
    const toRemove: string[] = [];
    for(let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if(key && key.startsWith(PEER_PROFILE_CACHE_PREFIX)) {
        toRemove.push(key);
      }
    }
    for(const key of toRemove) {
      localStorage.removeItem(key);
    }
  } catch{
    // ignore
  }
}
```

- [ ] **Step 2: Run the tests**

Run: `npx vitest run src/tests/nostra/peer-profile-cache.test.ts`
Expected: all pass (13 tests in the file).

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "peer-profile-cache" || echo "clean"`
Expected: `clean`

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/peer-profile-cache.ts
git commit -m "feat(nostra): add per-peer kind 0 profile cache with SWR refresh"
```

---

## Task 5: VMT `getFullUser` — hydrate from cache + background refresh

**Files:**
- Modify: `src/lib/nostra/virtual-mtproto-server.ts:596-621` (`getFullUser`)

- [ ] **Step 1: Add the import at the top of the file**

Find the existing imports from `./nostr-profile` or similar near the top. Add (next to other imports from this directory):

```typescript
import {loadCachedPeerProfile, refreshPeerProfileFromRelays} from './peer-profile-cache';
```

- [ ] **Step 2: Rewrite `getFullUser` body**

Replace lines 596–621 with:

```typescript
  private async getFullUser(params: any): Promise<any> {
    const peerId = extractPeerId(params?.id) ?? extractPeerId(params);
    if(peerId === null) {
      return {_: 'users.userFull', users: [], full_user: {_: 'userFull', pFlags: {}}};
    }

    const absPeerId = Math.abs(peerId);
    const pubkey = await getPubkey(absPeerId) ?? '';
    const mapping = await getMapping(pubkey);
    const user = this.mapper.createTwebUser({peerId: absPeerId, firstName: mapping?.displayName, pubkey});

    // Hydrate about from cache and fire background refresh. The refresh
    // lands via nostra_peer_profile_updated and is consumed by the
    // peerNostraProfile store, which drives the User Info rows directly.
    let about = '';
    if(pubkey) {
      const cached = loadCachedPeerProfile(pubkey);
      if(cached?.profile.about) about = cached.profile.about;
      // Fire-and-forget — do NOT await; UI updates via rootScope event.
      refreshPeerProfileFromRelays(pubkey, absPeerId as unknown as PeerId).catch(() => {});
    }

    return {
      _: 'users.userFull',
      users: [user],
      full_user: {
        _: 'userFull',
        id: absPeerId,
        pFlags: {},
        settings: {_: 'peerSettings', pFlags: {}},
        profile_photo: {_: 'photoEmpty', id: 0},
        notify_settings: {_: 'peerNotifySettings', pFlags: {}},
        common_chats_count: 0,
        about
      }
    };
  }
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "virtual-mtproto-server" || echo "clean"`
Expected: `clean`

- [ ] **Step 4: Run affected unit tests**

Run: `npx vitest run src/tests/nostra/virtual-mtproto-server.test.ts 2>&1 | tail -20`
Expected: all pass. If any test inspects `full_user.about === ''` specifically, update it to match — the expected value is still `''` when no cache entry exists and `refreshPeerProfileFromRelays` is mocked out, so pre-existing tests should still pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/virtual-mtproto-server.ts
git commit -m "feat(nostra): hydrate UserFull.about from peer profile cache"
```

---

## Task 6: Cleanup — wipe peer profile cache on logout

**Files:**
- Modify: `src/lib/nostra/nostra-cleanup.ts:104-110` (the `localStorage` cleanup block)

- [ ] **Step 1: Add the import at the top of the file**

Add after the existing `NOSTRA_LS_KEYS` declaration (or near the top with other imports; the file currently has none at top, so put it above `NOSTRA_DB_NAMES`):

```typescript
import {clearPeerProfileCache} from './peer-profile-cache';
```

- [ ] **Step 2: Call the helper inside `cleanupNostraData` alongside the existing cleanup loop**

Change this block (around line 104):

```typescript
  // 4. Clear localStorage keys
  for(const key of NOSTRA_LS_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch{}
  }
```

to:

```typescript
  // 4. Clear localStorage keys
  for(const key of NOSTRA_LS_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch{}
  }
  clearPeerProfileCache();
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep nostra-cleanup || echo "clean"`
Expected: `clean`

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/nostra-cleanup.ts
git commit -m "feat(nostra): wipe peer profile cache on logout"
```

---

## Task 7: Solid store `usePeerNostraProfile`

**Files:**
- Create: `src/stores/peerNostraProfile.ts`

This store is thin — the cache + rootScope event already own the state; this file just exposes a per-peer reactive signal to Solid components.

- [ ] **Step 1: Write the module**

```typescript
import {createSignal, Accessor} from 'solid-js';
import rootScope from '@lib/rootScope';
import {getPubkey} from '@lib/nostra/virtual-peers-db';
import {
  loadCachedPeerProfile,
  refreshPeerProfileFromRelays
} from '@lib/nostra/peer-profile-cache';
import type {NostrProfile} from '@lib/nostra/nostr-profile';

type Setter = (value: NostrProfile | undefined) => void;

const signalByPeerId = new Map<PeerId, {
  get: Accessor<NostrProfile | undefined>,
  set: Setter,
  pubkey?: string
}>();

let listenerInstalled = false;

function installListener() {
  if(listenerInstalled) return;
  listenerInstalled = true;
  rootScope.addEventListener('nostra_peer_profile_updated', ({peerId, profile}) => {
    const entry = signalByPeerId.get(peerId);
    if(entry) entry.set(profile);
  });
}

/**
 * Solid hook returning a signal that holds the latest kind 0 profile
 * we have for a peer (or undefined if none known). Each peerId is
 * memoised — opening the same profile twice reuses the same signal.
 *
 * On first call for a peerId we:
 *   1. resolve its pubkey from virtual-peers-db
 *   2. seed the signal from localStorage cache (sync)
 *   3. fire refreshPeerProfileFromRelays in the background
 */
export function usePeerNostraProfile(peerId: PeerId): Accessor<NostrProfile | undefined> {
  installListener();

  const existing = signalByPeerId.get(peerId);
  if(existing) return existing.get;

  const [get, set] = createSignal<NostrProfile | undefined>(undefined);
  const entry = {get, set, pubkey: undefined as string | undefined};
  signalByPeerId.set(peerId, entry);

  // Async resolution: pubkey lookup + cache seed + background refresh.
  (async() => {
    const pubkey = await getPubkey(Math.abs(peerId as unknown as number));
    if(!pubkey) return;
    entry.pubkey = pubkey;

    const cached = loadCachedPeerProfile(pubkey);
    if(cached) set(cached.profile);

    refreshPeerProfileFromRelays(pubkey, peerId).catch(() => {});
  })();

  return get;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "peerNostraProfile" || echo "clean"`
Expected: `clean`

- [ ] **Step 3: Commit**

```bash
git add src/stores/peerNostraProfile.ts
git commit -m "feat(nostra): add usePeerNostraProfile Solid store"
```

---

## Task 8: `PeerProfile` rows — Bio fallback, Website, Lightning, NIP-05

**Files:**
- Modify: `src/components/peerProfile.tsx` (`PeerProfile.Bio` at line ~915, `PeerProfile.MainSection` at line ~1426; add three new components just above `MainSection`)

- [ ] **Step 1: Add the import alongside existing `@stores/...` imports**

Near the top of the file (the block that already has `useChat, usePeer` from `@stores/peers`), add:

```typescript
import {usePeerNostraProfile} from '@stores/peerNostraProfile';
```

- [ ] **Step 2: Extend `PeerProfile.Bio` to fall back to the nostra profile**

Replace the `about` memo inside `PeerProfile.Bio` (currently `const about = createMemo(() => context.fullPeer?.about);` around line ~921) with:

```typescript
  const nostraProfile = usePeerNostraProfile(context.peerId);
  const about = createMemo(() => {
    const fromFull = context.fullPeer?.about;
    if(fromFull) return fromFull;
    return nostraProfile()?.about || '';
  });
```

Leave the rest of the component untouched. `<Show when={about()}>` already guards rendering.

- [ ] **Step 3: Add `PeerProfile.NostraWebsite` just before `PeerProfile.MainSection`**

Insert immediately above the `PeerProfile.MainSection` definition (line ~1426):

```typescript
PeerProfile.NostraWebsite = () => {
  const context = useContext(PeerProfileContext);
  const {i18n, I18n, toast} = useHotReloadGuard();
  const profile = usePeerNostraProfile(context.peerId);
  const url = createMemo(() => profile()?.website?.trim() || '');

  const copy = () => {
    copyTextToClipboard(url());
    toast(I18n.format('LinkCopied', true));
  };

  const open = () => {
    const u = url();
    safeWindowOpen(/^https?:\/\//i.test(u) ? u : 'https://' + u);
  };

  return (
    <Show when={url()}>
      <Row
        clickable={copy}
        contextMenu={{
          buttons: [{
            icon: 'copy',
            text: 'Text.CopyLabel_ShareLink',
            onClick: copy
          }, {
            icon: 'next',
            text: 'Open',
            onClick: open
          }]
        }}
      >
        <Row.Icon icon="link" />
        <Row.Title>{url()}</Row.Title>
        <Row.Subtitle>{i18n('SetUrlPlaceholder')}</Row.Subtitle>
      </Row>
    </Show>
  );
};
```

- [ ] **Step 4: Add `PeerProfile.NostraLightning`**

Insert directly after `NostraWebsite`:

```typescript
PeerProfile.NostraLightning = () => {
  const context = useContext(PeerProfileContext);
  const {I18n, toast} = useHotReloadGuard();
  const profile = usePeerNostraProfile(context.peerId);
  const lud16 = createMemo(() => profile()?.lud16?.trim() || '');

  const copy = () => {
    copyTextToClipboard(lud16());
    toast(I18n.format('TextCopied', true));
  };

  return (
    <Show when={lud16()}>
      <Row
        clickable={copy}
        contextMenu={{
          buttons: [{
            icon: 'copy',
            text: 'Copy',
            onClick: copy
          }]
        }}
      >
        <Row.Icon icon="gift_premium" />
        <Row.Title>{lud16()}</Row.Title>
        <Row.Subtitle>Lightning address</Row.Subtitle>
      </Row>
    </Show>
  );
};
```

- [ ] **Step 5: Add `PeerProfile.NostraNip05`**

Insert directly after `NostraLightning`:

```typescript
PeerProfile.NostraNip05 = () => {
  const context = useContext(PeerProfileContext);
  const {I18n, toast} = useHotReloadGuard();
  const profile = usePeerNostraProfile(context.peerId);
  const nip05 = createMemo(() => profile()?.nip05?.trim() || '');

  const copy = () => {
    copyTextToClipboard(nip05());
    toast(I18n.format('TextCopied', true));
  };

  return (
    <Show when={nip05()}>
      <Row
        clickable={copy}
        contextMenu={{
          buttons: [{
            icon: 'copy',
            text: 'Copy',
            onClick: copy
          }]
        }}
      >
        <Row.Icon icon="email" />
        <Row.Title>{nip05()}</Row.Title>
        <Row.Subtitle>NIP-05</Row.Subtitle>
      </Row>
    </Show>
  );
};
```

- [ ] **Step 6: Wire the new rows into `MainSection`**

Edit `PeerProfile.MainSection` (line ~1426). The current `<Show when={!(context.isBotforum && context.threadId)}>` body is:

```typescript
        <PeerProfile.Phone />
        <PeerProfile.Username />
        <PeerProfile.Location />
        <PeerProfile.Bio />
        <PeerProfile.Link />
        <PeerProfile.Birthday />
        <PeerProfile.ContactNote />
        <PeerProfile.BusinessHours />
        <PeerProfile.BusinessLocation />
        <PeerProfile.Notifications />
```

Change it to:

```typescript
        <PeerProfile.Phone />
        <PeerProfile.Username />
        <PeerProfile.Location />
        <PeerProfile.Bio />
        <PeerProfile.NostraWebsite />
        <PeerProfile.NostraLightning />
        <PeerProfile.NostraNip05 />
        <PeerProfile.Link />
        <PeerProfile.Birthday />
        <PeerProfile.ContactNote />
        <PeerProfile.BusinessHours />
        <PeerProfile.BusinessLocation />
        <PeerProfile.Notifications />
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit 2>&1 | grep -E "peerProfile|peerNostraProfile" | grep -v "pre-existing" || echo "clean"`
Expected: `clean`. Note: a handful of pre-existing `@vendor/emoji` and `@vendor/bezierEasing` TS errors are unrelated and expected — ignore them.

- [ ] **Step 8: Lint the modified file**

Run: `pnpm lint src/components/peerProfile.tsx`
Expected: pass. If lint flags spacing after `if` (`if (` vs `if(`) or trailing commas, fix them in place.

- [ ] **Step 9: Commit**

```bash
git add src/components/peerProfile.tsx
git commit -m "feat(profile): render peer kind 0 website/lud16/nip05 rows"
```

---

## Task 9: Full regression — unit tests + critical P2P quick suite

- [ ] **Step 1: Run the new + related unit tests**

Run: `npx vitest run src/tests/nostra/peer-profile-cache.test.ts src/tests/nostra/nostr-profile.test.ts src/tests/nostra/kind0-fetch.test.ts src/tests/nostra/own-profile-sync.test.ts`
Expected: all green.

- [ ] **Step 2: Run the nostra-quick critical path**

Run: `pnpm test:nostra:quick 2>&1 | tail -20`
Expected: `Tests N passed (N)` on the summary line. Exit code may be `1` because of two pre-existing unhandled rejections in `tor-ui.test.ts` — check the `passed` count, not the exit code (per CLAUDE.md → Testing P2P Code).

- [ ] **Step 3: Full typecheck**

Run: `npx tsc --noEmit 2>&1 | grep "error TS" | grep -vE "@vendor/(emoji|bezierEasing)" | head`
Expected: empty output (no new errors beyond the ~30 pre-existing vendor errors).

- [ ] **Step 4: Lint the whole project**

Run: `pnpm lint`
Expected: pass. If failing on pre-existing unrelated files, fix only what we introduced and note the rest.

- [ ] **Step 5: No commit** — this task is verification only.

---

## Task 10: Manual browser verification

This phase does not produce code; it catches issues TypeScript and unit tests can't.

- [ ] **Step 1: Start the dev server**

Run: `pnpm start` (port 8080).

- [ ] **Step 2: Fresh-profile path — no cache**

1. Open in a fresh incognito window → onboard as user A.
2. Add as contact a pubkey whose kind 0 on the relay has `about`, `website`, `lud16`, and `nip05` populated (e.g. a known public nostr user like `npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6` if the data is still online — otherwise publish from a second browser as user B: open Edit profile, fill all four fields, save).
3. Open that contact's profile → User Info tab.
4. Expected: within ~3s, four new rows appear: Bio (= about), website, Lightning address, NIP-05. Rows for fields the peer did NOT publish stay hidden.

- [ ] **Step 3: Cached path — instant render**

1. Close the profile sidebar.
2. Reload the page.
3. Reopen the same peer's profile.
4. Expected: all rows render **instantly** from `localStorage` (no 2–3s lag). Check DevTools → Application → Local Storage for `nostra-peer-profile-cache:<pubkey>`.

- [ ] **Step 4: Multi-device propagation**

1. In a second browser, log in as the peer, edit their `website` field to a new URL, save (publishes kind 0 with newer `created_at`).
2. In the first browser, close and reopen the peer's profile.
3. Expected: website row shows the new URL within ~3s (background refresh picks up newer `created_at`).

- [ ] **Step 5: Non-P2P / empty-profile regression**

1. Open the "Saved Messages" self-profile.
2. Expected: User Info looks unchanged from before — no Website/Lightning/NIP-05 rows appear, Bio continues to behave as before.

- [ ] **Step 6: Logout wipes cache**

1. Log out via the settings popup.
2. Check `localStorage` — no `nostra-peer-profile-cache:*` keys remain.

- [ ] **Step 7: Commit any documentation fixes found during verification**

If any step failed, loop back to the relevant task. If all passed, no commit — this task is verification.

---

## Task 11: Final sanity — release readiness

- [ ] **Step 1: Typecheck, lint, quick tests in one pass**

Run: `pnpm lint && npx tsc --noEmit 2>&1 | grep "error TS" | grep -vE "@vendor/(emoji|bezierEasing)" | head && pnpm test:nostra:quick 2>&1 | tail -5`
Expected: lint passes, no new TS errors, quick suite passes.

- [ ] **Step 2: Review the commit log**

Run: `git log --oneline main..HEAD`
Expected: 8 commits (one per Task 1–8; Tasks 9/10/11 are verification-only and do not commit). Titles prefixed with `feat(nostra)`, `feat(profile)`, `refactor(nostra)`, `test(nostra)` — conventional commit style per `CLAUDE.md`.

- [ ] **Step 3: Done**

Report back: all tasks complete, code lives on `main` (or the feature branch). No release bump — changes ship on the next `pnpm version` cut.
