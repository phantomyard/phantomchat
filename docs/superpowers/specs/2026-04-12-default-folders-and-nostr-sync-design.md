# Default Folders (All / Persons / Groups) + Nostr Multi-Device Sync

**Date:** 2026-04-12
**Status:** Design approved, ready for implementation plan
**Scope:** Ship Nostra.chat with 3 protected default folders and sync custom folders across devices via Nostr NIP-78.

---

## 1. Goals

1. On first boot (and retroactively for existing users), every Nostra.chat account has 3 folders present in the dialog filter sidebar: **All Chats**, **Persons**, **Groups**.
2. These 3 folders are **protected**: the user can rename and reorder them but cannot delete them.
3. The existing tweb responsive folder UI (horizontal tabs on narrow screens, vertical sidebar on wide screens) continues to work unchanged.
4. Folder titles respect the user's locale automatically via tweb's existing i18n keys (`FilterContacts`, `FilterGroups`) — no hardcoded English strings.
5. Custom folders (created by the user beyond the 3 defaults) synchronize across the user's devices via Nostr, using a boot-time pull/push strategy with last-write-wins conflict resolution and a user-visible toast when remote state overwrites local changes.

## 2. Non-Goals

- Live (subscription-based) real-time sync of folder edits across devices. Boot-only for v1.
- Sync of folder *membership* beyond what the stored filter already encodes (`include_peers`, `pFlags`). No separate "folder content" sync.
- Cross-user folder sharing.
- Multi-device merge CRDT. Conflict resolution is strict last-write-wins on `created_at`.
- Migrating existing user-created custom folders into "default" slots. The 3 defaults get fresh IDs; any collision is impossible because current users have no folders at all (Nostra.chat's `messages.getDialogFilters` has returned `[]` since launch).

## 3. Architecture Overview

### 3.1 Two independent subsystems

The feature splits cleanly into two subsystems that can be implemented and tested independently:

**Subsystem A — Local default folders (protected seed)**
Extends the existing `FiltersStorage.prependFilters()` mechanism to seed Persons and Groups alongside All Chats and Archive. Adds a protection guard so these IDs cannot be deleted. No Nostr interaction.

**Subsystem B — Nostr folder sync**
A new `folders-sync.ts` module that publishes the user's full `filtersArr` (minus the 3 defaults, plus the global order) to a NIP-78 replaceable event at boot, pulls the latest remote at boot, and reconciles with local state via LWW. Debounced republish on `filter_*` rootScope events.

Subsystem A must exist before B is meaningful: B synchronizes *custom* folders on top of the seeded baseline.

### 3.2 Data flow (boot sequence)

```
App boot
  ↓
appStateManager loads filtersArr from IndexedDB
  ↓
FiltersStorage.prependFilters()
  - ensures [ALL, ARCHIVE, PERSONS, GROUPS] exist
  - marks them with isProtected flag
  ↓
nostra-onboarding-integration.ts calls foldersSync.reconcile()
  - fetches latest NIP-78 event from relays
  - decrypts via NIP-44
  - compares remote.created_at vs local last-synced timestamp
  - applies merge strategy (see §4.3)
  - re-runs prependFilters() to guarantee system folders survive
  - dispatches filter_update / filter_order for UI refresh
  - shows toast if local changes were overwritten
  ↓
Normal runtime
  - filter_update / filter_delete / filter_order events debounced 2s
  - foldersSync.publish() publishes new NIP-78 event
```

## 4. Detailed Design

### 4.1 Subsystem A — Default folders seed

**New constants** (`src/lib/appManagers/constants.ts`)

```typescript
export const FOLDER_ID_PERSONS = 2;
export const FOLDER_ID_GROUPS = 3;
export const PROTECTED_FOLDERS = new Set([
  FOLDER_ID_ALL,      // 0
  FOLDER_ID_ARCHIVE,  // 1
  FOLDER_ID_PERSONS,  // 2
  FOLDER_ID_GROUPS    // 3
]);
// START_LOCAL_ID bumped from 2 to 4 (user-created filters)
```

**Extended seed** (`src/lib/storages/filters.ts::prependFilters()`)

`prependFilters()` already ensures All/Archive exist. Extend it to also ensure Persons and Groups exist, with semantic flags that tweb's `testDialogForFilter()` already understands:

- **Persons**: `pFlags.contacts = true`, `pFlags.non_contacts = true`, `pFlags.exclude_archived = true`, title = i18n key `FilterContacts` (already exists in tweb `lang.ts` for all supported locales)
- **Groups**: `pFlags.groups = true`, `pFlags.exclude_archived = true`, title = i18n key `FilterGroups` (already exists for all locales)

**Locale handling**: the title field stored on the filter is an **i18n key reference**, not a literal string. `FoldersSidebarContent` resolves it at render time using the user's current locale, so Italian users see "Contatti"/"Gruppi", English users see "Contacts"/"Groups", Spanish users see "Contactos"/"Grupos", and so on. Locale changes are picked up reactively without any reseed. If the user manually **renames** a protected folder, the rename is stored as a literal string and overrides the i18n key — the same behavior as any custom folder.

Insertion order: `[ALL, PERSONS, GROUPS, ARCHIVE, ...rest]`. Rationale: All first (entry point), Persons/Groups next (the value-add), Archive last among system folders, user-custom at the end.

For existing users whose `filtersArr` already contains only `[ALL, ARCHIVE]`, the method detects the missing IDs and inserts Persons/Groups at positions 1 and 2 respectively, pushing Archive forward. Existing user-custom folders (none at the time of ship, but future-safe) keep their positions relative to the tail.

**Protection guard**

Modify three entry points in `FiltersStorage`:

1. `deleteDialogFilter(id)` — if `PROTECTED_FOLDERS.has(id)`, throw a localized error and dispatch nothing. UI callers should never reach this (see §4.1.1), but this is the backstop.
2. `updateDialogFilter(filter)` — allow (rename and pFlag edits are fine), but preserve the `id` strictly. No side effects for protected folders.
3. `updateDialogFiltersOrder(order)` — allow freely. Reorder is always permitted.

**4.1.1 UI affordances for protection**

In the folder edit / context menu (look for `chatFolders.ts` and `_sidebarSlider.scss`):
- Hide the "Delete folder" button when the folder's ID is in `PROTECTED_FOLDERS`
- Keep "Rename" and drag-to-reorder enabled

This is cosmetic — the storage guard is the real enforcement.

**4.1.2 Virtual MTProto intercepts**

Currently `virtual-mtproto-server.ts:120` returns `messages.getDialogFilters: []`. Two changes:

1. Leave `getDialogFilters` returning `[]` — the seed happens in `prependFilters()`, not in the server response. This keeps the server stateless and avoids duplicating the seed logic.
2. Add no-op intercepts returning `true` for:
   - `messages.updateDialogFilter`
   - `messages.updateDialogFiltersOrder`
   - `messages.updateDialogFilterAsync` (if present in tweb's filters.ts)

Without these, the Worker's `apiManager.invokeApi()` calls in `filters.ts:345,372` fall through and fail silently, breaking rename/reorder even for custom folders. The no-op intercepts let `FiltersStorage` believe the server accepted the change; the local state update is the source of truth.

### 4.2 Subsystem B — Nostr folder sync module

**New file:** `src/lib/nostra/folders-sync.ts`

**Dependencies:** `ChatAPI` (for relay pub/sub), `nip44` (for self-encryption), `rootScope` (for event dispatch), `FiltersStorage` (via `rootScope.managers`).

**Public API:**

```typescript
export class FoldersSync {
  constructor(chatAPI: ChatAPI, ownPubkey: string, ownSecretKey: Uint8Array);

  // Called once at boot from nostra-onboarding-integration.ts
  async reconcile(): Promise<ReconcileResult>;

  // Called by debounced listener on filter_update/delete/order
  async publish(): Promise<void>;

  // Internal
  private async fetchRemote(): Promise<FolderSnapshot | null>;
  private async pushLocal(snapshot: FolderSnapshot): Promise<void>;
}

type ReconcileResult =
  | {action: 'no-remote', published: boolean}
  | {action: 'remote-wins', overwroteLocal: boolean}
  | {action: 'local-wins', published: boolean}
  | {action: 'in-sync'};
```

**4.2.1 Event shape**

- **Kind**: `30078` (NIP-78 application-specific data)
- **Tags**: `[['d', 'nostra.chat/folders']]`
- **Content**: NIP-44 encrypted JSON using own keypair as both sender and recipient (self-encryption pattern)
- **created_at**: `Math.floor(Date.now() / 1000)` at publish time — used as vector clock

**Decrypted content schema:**

```typescript
type FolderSnapshot = {
  version: 1;
  order: number[];                // full order including system folder IDs [0, 2, 3, 1, 4, ...]
  customFolders: MyDialogFilter[];  // only IDs >= START_LOCAL_ID (4)
};
```

System folder definitions (All/Persons/Groups/Archive) are never serialized — they are seeded locally by `prependFilters()`. Only the **order** of system folders is synced, so the user can reorder "All → Groups → Persons → Archive" and have it propagate.

Custom titles on protected folders (renames) ARE synced: when present, they are included in a separate `protectedTitles: {[id: number]: string}` field of the snapshot, so device B sees device A's rename.

Unknown `version` values are logged and the event is discarded (forward compatibility).

**4.2.2 Fetch logic**

```
query = {
  kinds: [30078],
  authors: [ownPubkey],
  '#d': ['nostra.chat/folders'],
  limit: 1
}
```

Query all configured relays in parallel, take the event with the highest `created_at` across all responses. Wait up to 5 seconds; beyond that, treat as "no remote" and proceed with local state. Use the existing `RelayPool` query helpers — no new relay plumbing.

**4.2.3 Merge strategy**

Let `localPublishedAt` = `created_at` stored in `localStorage['nostra-folders-last-published']` (set to `Date.now()/1000` on every successful publish).
Let `localModifiedAt` = timestamp stored in `localStorage['nostra-folders-last-modified']` (set on every `filter_update/delete/order` event, *before* debounce).

Decision table:

| Condition | Action | Toast? |
|---|---|---|
| No remote event found | Publish local (if any custom folders exist) | No |
| `remote.created_at > localModifiedAt` | Replace local custom folders + order + protected titles with remote, re-run `prependFilters()`, dispatch `filter_update` / `filter_order` | No (clean update) |
| `remote.created_at > localPublishedAt` AND `localModifiedAt > localPublishedAt` AND `localModifiedAt > remote.created_at` | Local wins, publish local | No |
| `remote.created_at > localPublishedAt` AND `localModifiedAt > remote.created_at` but user made offline changes older than remote | Remote wins, **show toast**: "Folders updated from another device. Your local changes were overwritten." (localized via i18n key `FoldersSyncOverwritten`) | **Yes** |
| `remote.created_at == localPublishedAt` | In sync, no-op | No |

The toast path is the case where the user modified folders locally while offline, *and* another device published a newer state in the meantime, *and* the remote state is actually newer than the local modifications. Without the toast, the user's offline edits would silently vanish.

**Toast implementation**: reuse the existing toast helper (search for `toastNew` or `toast` in `src/components/toast.ts`). Use a 6-second duration and a subdued (not error) styling. Add one new i18n key `FoldersSyncOverwritten` in `lang.ts`.

**4.2.4 Re-seed after remote apply**

Critical invariant: after applying a remote snapshot, `prependFilters()` runs again. This guarantees that:
- If the remote was published by an older client version that didn't know about Persons/Groups, those folders get re-inserted locally without leaking back to the remote until the user next modifies anything
- The system folder IDs (0, 1, 2, 3) always exist post-reconcile

**4.2.5 Publish logic**

Triggered by a debounced listener (2-second trailing debounce) on `filter_update`, `filter_delete`, `filter_order`:

```
build snapshot:
  - order = FiltersStorage.filtersArr.map(f => f.id)
  - customFolders = FiltersStorage.filtersArr.filter(f => f.id >= START_LOCAL_ID)
  - protectedTitles = {[id]: title} for protected folders whose title has been renamed
  - version = 1
encrypt via NIP-44 (self)
publish kind 30078 with d-tag to all relays
on success:
  - localStorage['nostra-folders-last-published'] = created_at
  - debug log
on failure (all relays rejected):
  - retry once after 10s
  - if still failing, log and give up — next reconcile will retry
```

Publish must not fire during reconcile itself (avoid loops). Use a boolean `this.applyingRemote` flag set during the remote-wins path.

**4.2.6 Initialization hook**

In `src/lib/nostra/nostra-onboarding-integration.ts`, after `FiltersStorage` is confirmed loaded and after `chatAPI` is connected but before the first UI paint of the chat list:

```typescript
const foldersSync = new FoldersSync(chatAPI, identity.pubkey, identity.secretKey);
await foldersSync.reconcile();  // bounded 5s timeout
attachFilterChangeListener(foldersSync);  // debounced publish
```

The `await` on reconcile is intentional: we block the chat list paint until folder state is reconciled, to avoid a visible flash of "old" folders that then rearrange. 5-second bounded timeout prevents a dead relay pool from stalling boot.

### 4.3 Responsive layout — no changes

tweb's existing responsive switching (`src/stores/foldersSidebar.ts:36-54`) already handles horizontal-top vs vertical-left based on screen width and user preference. Zero changes needed. The 3 default folders render through the same `FoldersSidebarContent` component as any other folder, so they inherit the responsive behavior for free.

Verified:
- `FoldersSidebarContent/index.tsx` iterates `filtersArr` and renders each
- `.has-horizontal-folders` / `.has-vertical-folders` body classes switch CSS automatically
- `mediaSize < medium` threshold triggers horizontal mode
- User setting `tabsInSidebar` overrides the auto-layout

## 5. Cleanup Integration

Add to `src/lib/nostra/nostra-cleanup.ts`:

- **New localStorage keys to clear on logout:** `nostra-folders-last-published`, `nostra-folders-last-modified`

Append these to the existing 4 keys (`nostra_identity`, `nostra-relay-config`, `nostra-last-seen-timestamp`, `nostra:read-receipts-enabled`). The folder state itself lives in `appStateManager`'s main state DB which is already wiped by the existing cleanup flow.

## 6. Testing Strategy

**Unit tests** (`src/tests/nostra/folders-sync.test.ts` and `filters-seed.test.ts`):

1. `prependFilters()` inserts Persons/Groups when missing
2. `prependFilters()` preserves custom folders and their positions when re-run
3. `prependFilters()` preserves user-renamed titles on Persons/Groups across reloads
4. `deleteDialogFilter(FOLDER_ID_PERSONS)` throws and does not mutate state
5. `deleteDialogFilter(FOLDER_ID_GROUPS)` throws and does not mutate state
6. `FoldersSync.reconcile()` with no remote publishes local state when custom folders exist
7. `FoldersSync.reconcile()` with newer remote replaces local custom folders
8. `FoldersSync.reconcile()` with newer remote re-applies `prependFilters` so system folders survive
9. `FoldersSync.reconcile()` with LWW conflict fires toast event
10. NIP-44 roundtrip: publish → fetch → decrypt → deep equal
11. Unknown `version` in decrypted content is ignored (logged, not thrown)
12. Debounced publish fires exactly once after burst of 5 `filter_update` events within 2s
13. Locale switch re-renders Persons/Groups titles without touching stored filter data

**E2E test** (`src/tests/e2e/e2e-default-folders-sync.ts`):

Two browser contexts sharing the same identity (export seed from A, import into B, both using the local strfry relay via `LocalRelay`):

1. Onboard device A → verify All/Persons/Groups visible in sidebar with locale-appropriate titles
2. Device A creates custom folder "Lavoro" → verify published to local relay (inspect via relay query)
3. Device B boots with same identity → verify "Lavoro" appears after reconcile
4. Device A goes offline (disconnect context), renames "Persons" → "Amici"
5. Device B reorders folders and publishes
6. Device A reconnects → verify toast fires, device A's rename is overwritten, final state matches device B's order
7. Verify All/Persons/Groups (or their renamed equivalents) are not deletable — context menu should not show Delete option

## 7. Migration & Rollout

- **Existing users** get Persons/Groups injected at next boot via `prependFilters()`. Their `filtersArr` currently contains `[ALL, ARCHIVE]` so the insertion is clean.
- **Schema version bump**: not needed — `appStateManager` already handles array growth via simple overwrite.
- **Release pipeline**: ships as a standard `feat:` commit through the tag-triggered deploy flow. No feature flag.
- **Rollback**: if the release proves broken, revert commit and retag. Users would keep the 3 folders locally (no harm) and sync would stop publishing; next release could remove the extra IDs safely via an idempotent migration in `prependFilters()`.

## 8. Open Questions (non-blocking)

- **Debounce window tuning**: 2s is a guess. May tune to 5s after telemetry shows publish frequency.
- **Protected-folder rename on locale change**: if device A renames Persons to "Amici" (it locale), then user switches device A to English locale, should the title stay "Amici" (user intent) or revert to "Contacts" (i18n default)? Current design: stays "Amici" because a rename stores a literal and the literal wins. Revisit only if UX feedback objects.

## 9. Scope Summary

| Component | Files Touched | Est. LOC |
|---|---|---|
| Constants | `src/lib/appManagers/constants.ts` | +10 |
| Seed extension | `src/lib/storages/filters.ts` | +50 |
| Protection guard | `src/lib/storages/filters.ts` | +20 |
| UI affordances | `src/components/sidebarLeft/tabs/chatFolders.ts` (or equivalent) | +15 |
| Virtual MTProto intercepts | `src/lib/nostra/virtual-mtproto-server.ts` | +10 |
| Nostr sync module | `src/lib/nostra/folders-sync.ts` (new) | +250 |
| Boot integration | `src/lib/nostra/nostra-onboarding-integration.ts` | +25 |
| Toast trigger + i18n key | `src/lang.ts` + reuse toast helper | +8 |
| Cleanup | `src/lib/nostra/nostra-cleanup.ts` | +3 |
| Unit tests | `src/tests/nostra/folders-sync.test.ts`, `filters-seed.test.ts` | +260 |
| E2E test | `src/tests/e2e/e2e-default-folders-sync.ts` | +200 |
| **Total** | **~11 files** | **~850 LOC** |

Estimated implementation time: **1.5 – 2 days** for a focused session, including E2E test debugging.
