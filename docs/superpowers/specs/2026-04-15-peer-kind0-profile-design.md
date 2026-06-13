# Peer Kind 0 Profile — Show All Nostr Metadata in User Info Tab

**Date:** 2026-04-15
**Scope:** Make the right-sidebar "User Info" tab render every kind 0 field published by a P2P peer (about, website, lud16, nip05). Banner is deferred — it is not implemented on the own-profile side yet.

## Problem

Opening another user's profile (`PeerProfile` → `MainSection` in `src/components/peerProfile.tsx`) currently shows only the display name and avatar for P2P peers. The Bio row exists but `fullPeer.about` is always empty because `NostraMTProtoServer.getFullUser` (`virtual-mtproto-server.ts:596`) returns `about: ''`. Website, Lightning address (`lud16`), and NIP-05 are not surfaced at all.

Kind 0 metadata for other peers is already fetched opportunistically in `src/components/sidebarLeft/tabs/contacts.ts:258` via `fetchNostrProfile`, but only the display name is persisted. The rest of the event is discarded.

## Goal

When the user opens a P2P peer's profile, the User Info section shows, in order:

1. Bio (`about`) — populated via the existing `PeerProfile.Bio` row.
2. Website (`website`) — new row, click copies the URL, context menu also opens in new tab.
3. Lightning address (`lud16`) — new row, click copies.
4. NIP-05 (`nip05`) — new row, click copies.

Values come from a local cache first (instant render), then a background relay refresh updates the UI. Fields the peer has not published are hidden. Multi-device edits on the peer side propagate via the `created_at`-wins conflict rule (same pattern as own profile).

Non-goals:
- Banner rendering (deferred until own-profile edit supports it).
- Editing other users' profiles.
- Publishing kind 0 metadata in new ways.

## Design

### New module: `src/lib/nostra/peer-profile-cache.ts`

Parallel to `own-profile-sync.ts`, but keyed by peer pubkey.

Storage: `localStorage` key `nostra-peer-profile-cache:<pubkey>` → `{profile: NostrProfile, created_at: number}`. One entry per peer keeps the cache bounded by contact count, and `localStorage.removeItem` per peer is trivial on logout cleanup.

Public API:
- `loadCachedPeerProfile(pubkey: string): CachedPeerProfile | null` — sync read.
- `saveCachedPeerProfile(pubkey: string, cached: CachedPeerProfile): void`.
- `refreshPeerProfileFromRelays(pubkey: string, peerId: PeerId): Promise<void>` — parallel query across `DEFAULT_RELAYS`, picks newest `created_at`, writes cache only when strictly newer, dispatches `nostra_peer_profile_updated` via `rootScope` with `{peerId, pubkey, profile}`.
- `clearPeerProfileCache(): void` — called from `nostra-cleanup.ts` on logout; iterates `localStorage` keys with the prefix.

Refresh semantics mirror `fetchOwnKind0`: rely on `queryRelayForProfileWithMeta` (exported from `nostr-profile.ts` — currently private). No new websocket code.

### Export change in `nostr-profile.ts`

Promote `queryRelayForProfileWithMeta` from file-local to `export`. No behavior change.

### VMT: `virtual-mtproto-server.ts` `getFullUser`

Current code returns `about: ''`. Change:

1. After resolving `pubkey`, call `loadCachedPeerProfile(pubkey)`.
2. If cached, set `full_user.about = cached.profile.about ?? ''`.
3. Fire `refreshPeerProfileFromRelays(pubkey, absPeerId.toPeerId(false))` without awaiting (background SWR).

This keeps the `users.getFullUser` response synchronous-shaped and fast. The Bio row renders immediately from cache and never flips empty→populated→empty.

The refresh's dispatch lands in the new Solid store (below) which updates website/lud16/nip05 rows. `about` specifically also needs to reach `fullPeer.about`; simplest path: inside the `nostra_peer_profile_updated` listener, call `rootScope.managers.appProfileManager.refreshFullPeer(peerId)` or equivalent invalidation. If that path is heavy, fallback: expose `about` through the same Solid store and render the Bio row directly from it, bypassing `fullPeer`. Decision: **render all four fields from the new store**, do not touch `fullPeer.about`. This sidesteps manager invalidation entirely and keeps the VMT hydration purely for consumers that still read `UserFull.about` (none in the current user-facing path for P2P peers).

### New Solid store: `src/stores/peerNostraProfile.ts`

`usePeerNostraProfile(peerId: Accessor<PeerId>): Accessor<NostrProfile | undefined>`. Implementation:

- Internal `Map<PeerId, Signal<NostrProfile | undefined>>`.
- On first call for a peerId: resolve pubkey via `getPubkey(peerId)` from `virtual-peers-db.ts`, then seed from `loadCachedPeerProfile(pubkey)` and fire `refreshPeerProfileFromRelays`.
- Subscribe once (module-level) to `rootScope` event `nostra_peer_profile_updated`, update the matching signal.
- Return the per-peer signal.

Event must be added to `BroadcastEvents` in `rootScope.ts` with type `{peerId: PeerId, pubkey: string, profile: NostrProfile}`.

### `peerProfile.tsx` — new rows

Extend `PeerProfile.MainSection` with four new row components, all `<Show when={...}>`-guarded so non-P2P peers render nothing new:

- `PeerProfile.NostraWebsite` — `Row.Icon icon="link"`, title = URL, subtitle = `i18n('SetUrlPlaceholder')` (reuse existing key). Click: copy to clipboard + toast. Context menu: Copy + "Open" (`safeWindowOpen`).
- `PeerProfile.NostraLightning` — `Row.Icon icon="lightning"` (verify icon exists in icon set; fall back to `"gift"`). Title = lud16, subtitle = "Lightning address". Click: copy + toast.
- `PeerProfile.NostraNip05` — `Row.Icon icon="check"` (or `"username"`). Title = nip05, subtitle = "NIP-05". Click: copy + toast.
- `PeerProfile.Bio` — modify existing. When `fullPeer.about` is empty AND we are on a P2P peer, read from the new store instead.

All four components read via `usePeerNostraProfile(context.peerId)`.

Rendering order inside `MainSection` (existing rows in bold, new italicized):

1. **Phone**
2. **Username**
3. **Location**
4. **Bio** (now backed by store for P2P)
5. *NostraWebsite*
6. *NostraLightning*
7. *NostraNip05*
8. **Link**
9. **Birthday**
10. **ContactNote**
11. **BusinessHours**
12. **BusinessLocation**
13. **Notifications**

### Cleanup integration

`src/lib/nostra/nostra-cleanup.ts` (or wherever logout wipes localStorage) must call `clearPeerProfileCache()`. One-line addition.

### Tests

Unit (Vitest, colocated under `src/tests/nostra/`):

- `peer-profile-cache.test.ts`:
  - `loadCachedPeerProfile` returns null for missing key, parsed object for present key.
  - `saveCachedPeerProfile` round-trips.
  - `refreshPeerProfileFromRelays` picks highest `created_at` across mocked relays, dispatches `nostra_peer_profile_updated` on main-thread rootScope, and does NOT write when relay `created_at` ≤ cached.
  - `clearPeerProfileCache` removes only keys with the prefix.

No E2E required for this phase — verification is visual (see below).

### Manual verification

1. `pnpm start`, log in as user A, connect to user B whose kind 0 has about/website/lud16/nip05 published.
2. Open B's profile from the chat header → User Info tab.
3. First open: cached rows appear instantly if previously fetched; otherwise rows pop in within 2–3s after relay response.
4. Reload page, reopen B's profile — rows appear instantly from `localStorage` without waiting.
5. Edit B's kind 0 from another client, reopen A's view — rows update to new values after background refresh.
6. Log out → log in as new user — old peer profile cache is cleared.

## Trade-offs considered

**Alternative:** stuff nostr fields into unused `User`/`UserFull` MTProto fields (`phone` for lud16, `username` for nip05, etc.). Rejected — semantically wrong, would regress if tweb upstream touches those fields, and hides the fact that these are Nostra-native data.

**Alternative:** eager-fetch on contact add (piggyback on `contacts.ts:258`). Rejected as the sole mechanism — it only runs at add-time, so existing contacts from before the feature lands would never populate. Kept as a *supplementary* cache warmer (out of scope for this phase; the SWR path already handles both cases).

**Alternative:** keep `fullPeer.about` as the source of truth for Bio and thread the other fields through an extended `UserFull`. Rejected — adding custom fields to `UserFull` leaks Nostra types into `@layer` and every manager that handles users.

## Files touched

- `src/lib/nostra/nostr-profile.ts` — export `queryRelayForProfileWithMeta`.
- `src/lib/nostra/peer-profile-cache.ts` — new.
- `src/lib/nostra/virtual-mtproto-server.ts` — `getFullUser` hydration + background refresh.
- `src/lib/nostra/nostra-cleanup.ts` — call `clearPeerProfileCache()`.
- `src/lib/rootScope.ts` — add `nostra_peer_profile_updated` event type.
- `src/stores/peerNostraProfile.ts` — new.
- `src/components/peerProfile.tsx` — new rows in `MainSection`, Bio fallback.
- `src/tests/nostra/peer-profile-cache.test.ts` — new.

No changes to `.planning/`, worker code, or relay pool.
