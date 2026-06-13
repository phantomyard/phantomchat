# Folder UX Fixes — Design

Three targeted fixes to the chat-folders UX:

1. Rename the default "people" folder from **Contacts** → **People** (avoids collision with the hamburger-menu "Contacts" entry).
2. Add a dedicated **emoji/icon picker button** in the edit-folder view (current mechanism — emoji as first char of the name — is not discoverable).
3. **Remove the folder-count limit** and its Telegram-Premium upsell popup (Nostra has no premium tier).

Scope: UI + local storage seed only. No protocol/network changes.

## 1. Rename default folder "Contacts" → "People"

### Current state

`src/lib/storages/filtersLocal.ts:40-44` seeds the default folder `FOLDER_ID_PERSONS` with `title = "Contacts"`, `pFlags.contacts = true`, `pFlags.non_contacts = true`, `pFlags.exclude_archived = true`. The folder therefore contains **every 1:1 chat** (both in-contacts and non-contacts) yet is labelled "Contacts", colliding with the hamburger-menu "Contacts" entry (which is the actual contact list).

`isDefaultLocalTitle(id, text)` in the same file is used by sync/snapshot code to decide whether the user has renamed the folder: defaults must not be persisted as user renames.

### Changes

**`src/lib/storages/filtersLocal.ts`**

- Line 44: `literalTitle('Contacts')` → `literalTitle('People')`.
- `isDefaultLocalTitle`: recognize the legacy default "Contacts" for `FOLDER_ID_PERSONS` so migration treats it as a default (not a user rename):

  ```ts
  const LEGACY_DEFAULT_TITLES: Record<number, string[]> = {
    [FOLDER_ID_PERSONS]: ['Contacts']
  };

  export function isDefaultLocalTitle(id: number, text: string): boolean {
    if(!text) return true;
    if(text.startsWith('LANGPACK:')) return true; // legacy migration
    const fresh = buildLocalFilter(id).title?.text ?? '';
    if(text === fresh) return true;
    if(LEGACY_DEFAULT_TITLES[id]?.includes(text)) return true;
    return false;
  }
  ```

### Migration for existing users

Existing users have `"Contacts"` persisted in IndexedDB under `FOLDER_ID_PERSONS`. We don't want to wait for a manual rename + re-seed cycle; we want a silent rewrite on next boot for any user who never renamed that folder.

Add one migration pass in the filters-storage init path (co-located with other boot-time reconciliations; exact hook is left to the implementation plan — candidates: `FiltersStorage` constructor post-load, or `generateLocalFilter` for the persons slot). The pass:

1. Load `FOLDER_ID_PERSONS` from storage.
2. If the persisted title matches a legacy default via `isDefaultLocalTitle` and is NOT equal to the current fresh default, overwrite with the fresh default and re-persist.
3. Dispatch the existing `filter_update` event so the UI re-renders.

Idempotent: once rewritten, the title equals the fresh default → subsequent boots skip the rewrite.

### Tests to update

- `src/tests/nostra/filters-seed.test.ts:45,50` — expectations change `'Contacts'` → `'People'`. Add a **new** test asserting the legacy title is recognized as default by `isDefaultLocalTitle(FOLDER_ID_PERSONS, 'Contacts') === true`.
- `src/tests/e2e/e2e-default-folders-sync.ts:138-139` — expected title updates.
- New unit test for the migration: seed DB with `title: 'Contacts'` → run init → assert title becomes `'People'`. Seed DB with a user rename (`title: 'VIPs'`) → run init → assert title stays `'VIPs'`.

### Out of scope

- Lang keys `ChatList.Filter.Contacts` / `FilterAllContacts` / `ChatList.Filter.NonContacts` / `FilterAllNonContacts` remain unchanged — these label the filter categories inside the edit-folder UI, not the folder itself.
- Hamburger-menu "Contacts" entry is untouched.

## 2. Dedicated emoji/icon picker in edit folder

### Current state

`src/components/sidebarLeft/tabs/editFolder.ts:156-172` constructs the name input via `EditFolderInput` (Solid wrapper around `InputFieldEmoji`, `src/components/sidebarLeft/tabs/editFolderInput/index.tsx`). The app uses the **first or last emoji** of the folder title as the sidebar icon (rendered via `folderItem.tsx`; tip key `EditFolder.EmojiAsIconTip`). The tip caption is **only shown when `rootScope.settings.tabsInSidebar === true`** (edit-folder.ts:158), so for the default top-bar layout the mechanism is invisible.

No changes are needed to the `DialogFilter` schema — the icon is derived from the title, and that pipeline stays.

### Changes

**`src/components/sidebarLeft/tabs/editFolderInput/index.tsx`**

Extend the Solid component to render, alongside the `InputFieldTsx`, an icon-picker button:

- Render an emoji button (icon `smile` or current extracted icon) on the right edge of the input wrapper.
- Click opens an emoticons dropdown. Use the existing `EmoticonsDropdown` machinery already used in chat input. The scope is "emoji only" — no stickers/GIFs tabs.
- Positioning: the dropdown anchors to the button, appears inside the edit-folder tab (not in the chat input area). Needs light z-index/portal work — see implementation plan.
- On emoji selection:
  - Read current title text.
  - If first char is already an emoji → replace it with the selected emoji.
  - Else → prepend selected emoji + space (`"${emoji} ${rest}"` if non-empty, else `"${emoji}"`).
  - Write back via the existing `onRawInput` → flows into the same `onInput` handler in `editFolder.ts` that updates `filter.title` and calls `editCheckForChange()`.
  - Keep current cursor behavior / focus where reasonable.
- Respect `MAX_FOLDER_NAME_LENGTH = 12` — if inserting would exceed the cap, truncate the tail rather than refuse (the icon wins over the tail text, matching Telegram's behavior).

**`src/components/sidebarLeft/tabs/editFolder.ts:158`**

Drop the `hasFoldersSidebar` guard — always pass `caption: 'EditFolder.EmojiAsIconTip'`. Keeps a text backup of how the mechanism works in case the picker is not used.

**Styles**

Add minimal SCSS for the picker button (size-matched to the input, subtle hover). Co-locate near the input styles used by `EditFolderInput`.

### Tests

- Unit: selection handler correctly prepends / replaces the leading emoji under the three states (empty title, title starting with emoji, title starting with text).
- Unit: `MAX_FOLDER_NAME_LENGTH` cap holds after emoji prepend (truncates tail).

### Out of scope

- Custom emoji / `iconDocId` / `emojiIcon` fields on the filter — render path already supports them but the edit path does not; adding them requires schema-level work and is deferred.
- Picker auto-suggest / "recent emojis" — rely on the shared emoji dropdown's own recents.

## 3. Remove folder-count limit + premium upsell

### Current state

- `src/components/sidebarLeft/tabs/chatFolders.ts:374-382` — `canCreateFolder()` calls `getLimit('folders')` (returns `dialog_filters_limit_default` ~= 10 for non-premium).
- `chatFolders.ts:244-247` and `chatFolders.ts:397-398` — when `canCreateFolder()` returns false, `showLimitPopup('folders')` is called, which opens a Telegram-Premium upsell popup (button `IncreaseLimit` → `PopupPremium.show(...)`).
- `editFolder.ts:35` imports the same `showLimitPopup` but is not in scope for this fix (used for `folderPeers`, the per-folder chats cap).

### Changes

**`src/components/sidebarLeft/tabs/chatFolders.ts`**

- Delete `canCreateFolder()` and remove both call-site branches: the two "create folder" paths (fresh create button, add-suggested-folder button) short-circuit straight to creation.
- Remove the `showLimitPopup` import if no other call site remains in the file.

**No changes to `editFolder.ts`.** The `folderPeers` limit (chats per folder) is a separate concern; the user asked only about the "Create Folder" limit in settings. Leaving `editFolder.ts` untouched also preserves the premium-locked shared-folder-invites UX (`chatlistInvites`), which is a protocol-side limit, not client-imposed.

**No changes to `popups/limit.ts`.** Still used by pin/reactions/etc.

### Tests

- Unit: in a state with N >> 10 existing filters, clicking "Create Folder" does not invoke `showLimitPopup` and opens the edit-folder tab.

## Risks & rollout

- **Rename migration**: if a user both (a) never renamed the folder and (b) has a custom language where "Contacts" is localized differently → the legacy-default check won't match. Mitigation: the legacy defaults list is English-only; non-English users keep whatever title is persisted. Acceptable — Nostra ships English UI today.
- **Icon picker UX**: prepending an emoji + space changes the visible title. The user's entered text grows by 2 chars. Covered by the `MAX_FOLDER_NAME_LENGTH` test. The `editCheckForChange()` pipeline already marks the filter as modified → save button lights up as expected.
- **Removing the limit**: with unbounded folder count, the UI (top-bar carousel / sidebar list) must not break. Existing rendering is unbounded-friendly (scrollable). No change expected.

## File touch list

Modified:

- `src/lib/storages/filtersLocal.ts`
- `src/lib/storages/filters.ts` (migration hook — location TBD in plan)
- `src/components/sidebarLeft/tabs/editFolderInput/index.tsx`
- `src/components/sidebarLeft/tabs/editFolder.ts`
- `src/components/sidebarLeft/tabs/chatFolders.ts`
- `src/tests/nostra/filters-seed.test.ts`
- `src/tests/e2e/e2e-default-folders-sync.ts`

New:

- Unit test(s) for the "Contacts" → "People" migration.
- Unit test(s) for the icon-picker emoji-prepend behavior.
