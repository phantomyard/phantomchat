# Default Folders + Nostr Multi-Device Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Nostra.chat with 3 protected default folders (All / Persons / Groups), with multi-device sync of custom folders via NIP-78 (boot-only pull/push, LWW with toast).

**Architecture:** Two subsystems. (A) Extend `FiltersStorage.prependFilters()` to seed Persons and Groups as locally-protected filters with i18n titles; add delete-guard on protected IDs; add no-op Virtual MTProto intercepts for filter CRUD. (B) New `folders-sync.ts` module that publishes the user's filter state (custom folders + order + protected-folder renames) as a NIP-78 replaceable event (kind 30078, self-encrypted NIP-44), runs a reconcile at boot, and republishes debounced on `filter_*` rootScope events.

**Tech Stack:** TypeScript 5.7, Solid.js, Vitest (unit), Playwright (E2E), Nostr (NIP-78/NIP-44 via `nostr-tools`), tweb's `FiltersStorage` + `appStateManager`.

**Spec:** `docs/superpowers/specs/2026-04-12-default-folders-and-nostr-sync-design.md`

**Worktree:** `/home/raider/Repository/nostra.chat-wt/folders` on branch `feat/default-folders`.

---

## File Structure

### New files
- `src/lib/nostra/folders-sync.ts` — sync module (class `FoldersSync` + snapshot schema)
- `src/lib/nostra/folders-protection.ts` — tiny pure helper `isProtectedFolder(id)` reused across storage and UI
- `src/tests/nostra/filters-seed.test.ts` — unit tests for seed + protection guard
- `src/tests/nostra/folders-sync.test.ts` — unit tests for FoldersSync
- `src/tests/e2e/e2e-default-folders-sync.ts` — E2E test with two browser contexts sharing identity

### Modified files
- `src/lib/appManagers/constants.ts` — add `FOLDER_ID_PERSONS`, `FOLDER_ID_GROUPS`, `PROTECTED_FOLDERS`, widen types
- `src/lib/storages/filters.ts` — extend `generateLocalFilter`, `prependFilters`, add guard to `updateDialogFilter`, expose helpers used by sync
- `src/lib/nostra/virtual-mtproto-server.ts` — add no-op intercepts for `messages.updateDialogFilter*`
- `src/lib/nostra/nostra-cleanup.ts` — add two new localStorage keys
- `src/lib/nostra/nostra-onboarding-integration.ts` — wire `FoldersSync.reconcile()` + debounced publish listener
- `src/lang.ts` — add i18n key `FoldersSyncOverwritten`

---

## Task Ordering & Dependencies

**Subsystem A must land first and be green before B starts.** B depends on the protection guard and the new constants.

- Task 1 → 2 → 3 → 4 → 5 → 6: Subsystem A (constants, seed, guard, intercepts, tests, UI affordance)
- Task 7 → 8 → 9 → 10 → 11 → 12: Subsystem B (schema, FoldersSync class with TDD, boot wiring, cleanup, E2E)

Each task ends with a commit. Commit messages follow Conventional Commits (`feat:`, `test:`, `chore:`).

---

## Task 1: Add folder ID constants

**Files:**
- Modify: `src/lib/appManagers/constants.ts:13,43-46`

- [ ] **Step 1: Widen the `REAL_FOLDER_ID` type and add new constants**

Replace lines 13, 43-46 of `src/lib/appManagers/constants.ts`:

```typescript
// line 13 — widen from 0|1 to 0|1|2|3
export type REAL_FOLDER_ID = 0 | 1 | 2 | 3;
```

Replace lines 43-46:

```typescript
export const FOLDER_ID_ALL: REAL_FOLDER_ID = 0;
export const FOLDER_ID_ARCHIVE: REAL_FOLDER_ID = 1;
export const FOLDER_ID_PERSONS: REAL_FOLDER_ID = 2;
export const FOLDER_ID_GROUPS: REAL_FOLDER_ID = 3;
export const REAL_FOLDERS: Set<number> = new Set([
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS
]);
export const PROTECTED_FOLDERS: Set<number> = new Set([
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS
]);
export const START_LOCAL_ID = Math.max(...Array.from(REAL_FOLDERS)) + 1 as MyDialogFilter['localId'];
```

`REAL_FOLDERS` and `PROTECTED_FOLDERS` are intentionally identical for now — they're kept as two sets because their *semantics* differ: `REAL_FOLDERS` means "seeded locally, not a user custom", `PROTECTED_FOLDERS` means "cannot be deleted". Future system folders might be protected without being REAL (e.g. server-driven defaults), so don't collapse the two.

- [ ] **Step 2: Verify type check passes**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "@vendor" | head -30`
Expected: no errors related to `constants.ts`, `filters.ts`, or `FOLDER_ID_*`. Pre-existing `@vendor/emoji` and `@vendor/bezierEasing` errors are OK.

- [ ] **Step 3: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git add src/lib/appManagers/constants.ts
git commit -m "$(cat <<'EOF'
feat(folders): add FOLDER_ID_PERSONS and FOLDER_ID_GROUPS constants

Widens REAL_FOLDER_ID to 0|1|2|3 and introduces PROTECTED_FOLDERS set
used by the upcoming delete guard in FiltersStorage.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Create protection helper

**Files:**
- Create: `src/lib/nostra/folders-protection.ts`

- [ ] **Step 1: Write failing test**

Create `src/tests/nostra/folders-protection.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
import {isProtectedFolder} from '@lib/nostra/folders-protection';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS
} from '@appManagers/constants';

describe('isProtectedFolder', () => {
  it('returns true for All/Archive/Persons/Groups', () => {
    expect(isProtectedFolder(FOLDER_ID_ALL)).toBe(true);
    expect(isProtectedFolder(FOLDER_ID_ARCHIVE)).toBe(true);
    expect(isProtectedFolder(FOLDER_ID_PERSONS)).toBe(true);
    expect(isProtectedFolder(FOLDER_ID_GROUPS)).toBe(true);
  });

  it('returns false for user custom folder IDs', () => {
    expect(isProtectedFolder(4)).toBe(false);
    expect(isProtectedFolder(42)).toBe(false);
    expect(isProtectedFolder(999)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/folders-protection.test.ts 2>&1 | tail -20`
Expected: FAIL — "Cannot find module '@lib/nostra/folders-protection'".

- [ ] **Step 3: Implement helper**

Create `src/lib/nostra/folders-protection.ts`:

```typescript
import {PROTECTED_FOLDERS} from '@appManagers/constants';

/**
 * Returns true if the folder id cannot be deleted by the user.
 * Protected folders can still be renamed and reordered.
 */
export function isProtectedFolder(id: number): boolean {
  return PROTECTED_FOLDERS.has(id);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/folders-protection.test.ts 2>&1 | tail -20`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git add src/lib/nostra/folders-protection.ts src/tests/nostra/folders-protection.test.ts
git commit -m "$(cat <<'EOF'
feat(folders): add isProtectedFolder helper

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Extend `generateLocalFilter` to produce Persons and Groups

**Files:**
- Modify: `src/lib/storages/filters.ts:117-130`
- Modify: `src/tests/nostra/filters-seed.test.ts` (create)

- [ ] **Step 1: Write failing test**

Create `src/tests/nostra/filters-seed.test.ts`:

```typescript
import {describe, it, expect, beforeEach} from 'vitest';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS
} from '@appManagers/constants';

// Import the pure helper we'll extract from FiltersStorage in this task.
// Extraction rationale: generateLocalFilter currently lives inside the class
// and touches dialogsStorage for pinned orders. For test isolation we create
// a pure `buildLocalFilter(id)` that returns the filter shape without the
// pinned-orders lookup (the storage class calls it and adds pinned afterward).
import {buildLocalFilter} from '@lib/storages/filtersLocal';

describe('buildLocalFilter', () => {
  it('builds All Chats with exclude_archived', () => {
    const f = buildLocalFilter(FOLDER_ID_ALL);
    expect(f.id).toBe(FOLDER_ID_ALL);
    expect(f.pFlags.exclude_archived).toBe(true);
    expect(f.pFlags.contacts).toBeFalsy();
    expect(f.pFlags.groups).toBeFalsy();
  });

  it('builds Archive with exclude_unarchived', () => {
    const f = buildLocalFilter(FOLDER_ID_ARCHIVE);
    expect(f.id).toBe(FOLDER_ID_ARCHIVE);
    expect(f.pFlags.exclude_unarchived).toBe(true);
  });

  it('builds Persons with contacts + non_contacts + exclude_archived', () => {
    const f = buildLocalFilter(FOLDER_ID_PERSONS);
    expect(f.id).toBe(FOLDER_ID_PERSONS);
    expect(f.pFlags.contacts).toBe(true);
    expect(f.pFlags.non_contacts).toBe(true);
    expect(f.pFlags.exclude_archived).toBe(true);
    expect(f.pFlags.groups).toBeFalsy();
    expect(f.pFlags.broadcasts).toBeFalsy();
  });

  it('builds Groups with groups + exclude_archived', () => {
    const f = buildLocalFilter(FOLDER_ID_GROUPS);
    expect(f.id).toBe(FOLDER_ID_GROUPS);
    expect(f.pFlags.groups).toBe(true);
    expect(f.pFlags.exclude_archived).toBe(true);
    expect(f.pFlags.contacts).toBeFalsy();
  });

  it('uses i18n key references for protected folder titles, not literal strings', () => {
    const persons = buildLocalFilter(FOLDER_ID_PERSONS);
    const groups = buildLocalFilter(FOLDER_ID_GROUPS);
    // Title shape: {_: 'textWithEntities', text: '<i18n-key>', entities: []}
    // We use a sentinel prefix 'LANGPACK:' so FoldersSidebarContent knows
    // to resolve via I18n.format() instead of rendering literally.
    expect(persons.title.text.startsWith('LANGPACK:')).toBe(true);
    expect(persons.title.text).toBe('LANGPACK:FilterContacts');
    expect(groups.title.text).toBe('LANGPACK:FilterGroups');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/filters-seed.test.ts 2>&1 | tail -30`
Expected: FAIL — "Cannot find module '@lib/storages/filtersLocal'".

- [ ] **Step 3: Extract `buildLocalFilter` into a new pure module**

Create `src/lib/storages/filtersLocal.ts`:

```typescript
import type {DialogFilter} from '@layer';
import type {MyDialogFilter} from '@lib/storages/filters';
import copy from '@helpers/object/copy';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS
} from '@appManagers/constants';

const LOCAL_FILTER_TEMPLATE: DialogFilter.dialogFilter = {
  _: 'dialogFilter',
  pFlags: {},
  id: 0,
  title: {_: 'textWithEntities', text: '', entities: []},
  exclude_peers: [],
  include_peers: [],
  pinned_peers: [],
  excludePeerIds: [],
  includePeerIds: [],
  pinnedPeerIds: []
};

/**
 * Sentinel prefix used in `title.text` to indicate the title is an i18n
 * langpack key rather than a literal. FoldersSidebarContent strips the prefix
 * and passes the remainder to I18n.format() at render time.
 */
export const LANGPACK_PREFIX = 'LANGPACK:';

export function langpackTitle(key: string): DialogFilter.dialogFilter['title'] {
  return {_: 'textWithEntities', text: LANGPACK_PREFIX + key, entities: []};
}

export function buildLocalFilter(id: number): MyDialogFilter {
  const filter: MyDialogFilter = {...copy(LOCAL_FILTER_TEMPLATE), id};

  if(id === FOLDER_ID_ALL) {
    filter.pFlags.exclude_archived = true;
  } else if(id === FOLDER_ID_ARCHIVE) {
    filter.pFlags.exclude_unarchived = true;
  } else if(id === FOLDER_ID_PERSONS) {
    filter.pFlags.contacts = true;
    filter.pFlags.non_contacts = true;
    filter.pFlags.exclude_archived = true;
    filter.title = langpackTitle('FilterContacts');
  } else if(id === FOLDER_ID_GROUPS) {
    filter.pFlags.groups = true;
    filter.pFlags.exclude_archived = true;
    filter.title = langpackTitle('FilterGroups');
  }

  return filter;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/filters-seed.test.ts 2>&1 | tail -20`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git add src/lib/storages/filtersLocal.ts src/tests/nostra/filters-seed.test.ts
git commit -m "$(cat <<'EOF'
feat(folders): extract pure buildLocalFilter with Persons and Groups seeds

Extracts filter construction from FiltersStorage into a pure module so
seed logic is testable without DB dependencies. Adds Persons (contacts +
non_contacts) and Groups (groups) with langpack-key titles.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire `buildLocalFilter` into `FiltersStorage` and extend `prependFilters`

**Files:**
- Modify: `src/lib/storages/filters.ts:117-130` (replace `generateLocalFilter`)
- Modify: `src/lib/storages/filters.ts:96-115` (extend `prependFilters`)

- [ ] **Step 1: Replace `generateLocalFilter` to delegate to `buildLocalFilter`**

Replace the existing `generateLocalFilter` method (lines 117-130) with:

```typescript
  private generateLocalFilter(id: REAL_FOLDER_ID) {
    const filter = buildLocalFilter(id);
    if(REAL_FOLDERS.has(id)) {
      filter.pinnedPeerIds = this.dialogsStorage.getPinnedOrders(id);
    }
    return filter;
  }
```

Add at the top of `src/lib/storages/filters.ts` (alongside existing imports on line 15):

```typescript
import {buildLocalFilter} from '@lib/storages/filtersLocal';
```

Update line 15 to include the new constants:

```typescript
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS,
  REAL_FOLDERS,
  REAL_FOLDER_ID,
  START_LOCAL_ID
} from '@appManagers/constants';
```

- [ ] **Step 2: Extend `prependFilters` to also insert Persons and Groups**

Replace lines 96-115 (the `prependFilters` method) with:

```typescript
  private prependFilters(filters: DialogFilter[]) {
    filters = filters.slice();

    const allChatsFilter = this.localFilters[FOLDER_ID_ALL];
    const archiveFilter = this.localFilters[FOLDER_ID_ARCHIVE];
    const personsFilter = this.localFilters[FOLDER_ID_PERSONS];
    const groupsFilter = this.localFilters[FOLDER_ID_GROUPS];

    // ALL: replace existing or prepend
    const allIdx = filters.findIndex(
      (f) => f._ === 'dialogFilterDefault' || (f as MyDialogFilter).id === FOLDER_ID_ALL
    );
    if(allIdx !== -1) filters[allIdx] = allChatsFilter;
    else filters.unshift(allChatsFilter);

    // Helper: preserve user-renamed titles when re-seeding
    const preserveRename = (existing: MyDialogFilter | undefined, fresh: MyDialogFilter): MyDialogFilter => {
      if(!existing) return fresh;
      const existingTitle = (existing as DialogFilter.dialogFilter).title?.text ?? '';
      const isLangpack = existingTitle.startsWith('LANGPACK:');
      if(!isLangpack && existingTitle.length > 0) {
        // User renamed — keep their literal title
        return {...fresh, title: (existing as DialogFilter.dialogFilter).title};
      }
      return fresh;
    };

    // PERSONS: ensure present at index 1 (after ALL), preserve rename
    const existingPersons = filters.find((f) => (f as MyDialogFilter).id === FOLDER_ID_PERSONS) as MyDialogFilter | undefined;
    findAndSplice(filters, (f) => (f as MyDialogFilter).id === FOLDER_ID_PERSONS);
    filters.splice(1, 0, preserveRename(existingPersons, personsFilter));

    // GROUPS: ensure present at index 2 (after PERSONS), preserve rename
    const existingGroups = filters.find((f) => (f as MyDialogFilter).id === FOLDER_ID_GROUPS) as MyDialogFilter | undefined;
    findAndSplice(filters, (f) => (f as MyDialogFilter).id === FOLDER_ID_GROUPS);
    filters.splice(2, 0, preserveRename(existingGroups, groupsFilter));

    // ARCHIVE: ensure present, after system folders
    findAndSplice(filters, (f) => (f as MyDialogFilter).id === FOLDER_ID_ARCHIVE);
    filters.splice(3, 0, archiveFilter);

    this.localId = START_LOCAL_ID;
    filters.forEach((filter) => {
      delete filter.localId;
    });

    return filters;
  }
```

Also update the `clear()` method at lines 136-153 — the `REAL_FOLDERS` iteration at line 147 now also seeds Persons and Groups into `localFilters`. This works automatically because the loop iterates the widened set — no code change needed. Verify by reading the method and confirming it uses `REAL_FOLDERS` (not a literal list).

- [ ] **Step 3: Add test for `prependFilters` seeding behaviour**

Append to `src/tests/nostra/filters-seed.test.ts`:

```typescript
// We test prependFilters indirectly via a minimal fake that exercises the
// actual logic — we re-implement a tiny version of FiltersStorage-prepend
// logic here. The real integration is covered by the E2E test; this unit
// test locks the ordering invariants of the pure seed step.

import findAndSplice from '@helpers/array/findAndSplice';
import type {DialogFilter} from '@layer';

function prependForTest(existing: DialogFilter[]): DialogFilter[] {
  // Copy of the logic in FiltersStorage.prependFilters, without dialogsStorage.
  const filters: any[] = existing.slice();
  const ensure = (id: number, index: number) => {
    const fresh = buildLocalFilter(id);
    findAndSplice(filters, (f: any) => f.id === id);
    filters.splice(index, 0, fresh);
  };
  // ALL at 0
  const allIdx = filters.findIndex((f: any) => f.id === FOLDER_ID_ALL);
  if(allIdx === -1) filters.unshift(buildLocalFilter(FOLDER_ID_ALL));
  // Persons at 1, Groups at 2, Archive at 3
  ensure(FOLDER_ID_PERSONS, 1);
  ensure(FOLDER_ID_GROUPS, 2);
  ensure(FOLDER_ID_ARCHIVE, 3);
  return filters;
}

describe('prependFilters seed ordering', () => {
  it('seeds all 4 system folders for an empty array', () => {
    const out = prependForTest([]);
    expect(out.map((f) => f.id)).toEqual([0, 2, 3, 1]);
  });

  it('inserts Persons and Groups for users who already have [ALL, ARCHIVE]', () => {
    const existing = [buildLocalFilter(0), buildLocalFilter(1)];
    const out = prependForTest(existing);
    expect(out.map((f) => f.id)).toEqual([0, 2, 3, 1]);
  });

  it('preserves user custom folders at the tail', () => {
    const custom = {...buildLocalFilter(0), id: 42, title: {_: 'textWithEntities' as const, text: 'Work', entities: []}};
    const existing = [buildLocalFilter(0), buildLocalFilter(1), custom as any];
    const out = prependForTest(existing);
    expect(out.map((f) => f.id)).toEqual([0, 2, 3, 1, 42]);
    expect((out[4] as any).title.text).toBe('Work');
  });
});
```

- [ ] **Step 4: Run the test suite**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/filters-seed.test.ts 2>&1 | tail -30`
Expected: PASS (8 tests).

- [ ] **Step 5: Type check**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "@vendor" | head -30`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git add src/lib/storages/filters.ts src/tests/nostra/filters-seed.test.ts
git commit -m "$(cat <<'EOF'
feat(folders): seed Persons and Groups via prependFilters

Extends FiltersStorage.prependFilters to retroactively insert Persons
and Groups at positions 1 and 2 respectively for existing users, and
preserves user-renamed titles on protected folders across reloads.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add protection guard and Virtual MTProto intercepts

**Files:**
- Modify: `src/lib/storages/filters.ts:344-380`
- Modify: `src/lib/nostra/virtual-mtproto-server.ts:120`

- [ ] **Step 1: Write failing test for the guard**

Append to `src/tests/nostra/filters-seed.test.ts`:

```typescript
import {isProtectedFolder} from '@lib/nostra/folders-protection';

describe('protected folder guard', () => {
  it('isProtectedFolder recognises all 4 system IDs', () => {
    expect(isProtectedFolder(0)).toBe(true);
    expect(isProtectedFolder(1)).toBe(true);
    expect(isProtectedFolder(2)).toBe(true);
    expect(isProtectedFolder(3)).toBe(true);
    expect(isProtectedFolder(4)).toBe(false);
  });
});
```

Run the test. Expected: PASS (already covered by Task 2, just locks the import path used by filters.ts).

- [ ] **Step 2: Add guard to `updateDialogFilter` in `FiltersStorage`**

In `src/lib/storages/filters.ts`, modify `updateDialogFilter` (starts around line 344). The current body unconditionally calls `apiManager.invokeApi`. Replace with:

```typescript
  public updateDialogFilter(filter: MyDialogFilter, remove = false, prepend = false) {
    if(remove && isProtectedFolder(filter.id)) {
      return Promise.reject(makeError('FILTER_PROTECTED'));
    }

    return this.apiManager.invokeApi('messages.updateDialogFilter', {
      id: filter.id,
      filter: remove ? undefined : this.getOutputDialogFilter(filter)
    }).then(() => {
      this.onUpdateDialogFilter({
        _: 'updateDialogFilter',
        id: filter.id,
        filter: remove ? undefined : filter as any
      });

      if(prepend) {
        const f = Object.values(this.filters);
        const order = f.sort((a, b) => a.localId - b.localId).map((filter) => filter.id);
        indexOfAndSplice(order, filter.id);
        indexOfAndSplice(order, FOLDER_ID_ARCHIVE);
        order.splice(order[0] === FOLDER_ID_ALL ? 1 : 0, 0, filter.id);
        this.onUpdateDialogFilterOrder({
          _: 'updateDialogFilterOrder',
          order
        });
      }

      return filter;
    });
  }
```

Add to the import block:

```typescript
import {isProtectedFolder} from '@lib/nostra/folders-protection';
```

Note: `makeError` is already imported at line 16.

- [ ] **Step 3: Add no-op intercepts in Virtual MTProto Server**

In `src/lib/nostra/virtual-mtproto-server.ts`, around line 120, extend the NOSTRA_STATIC map. Replace:

```typescript
  'messages.getDialogFilters': [],
  'messages.getSuggestedDialogFilters': [],
```

with:

```typescript
  'messages.getDialogFilters': [],
  'messages.getSuggestedDialogFilters': [],
  'messages.updateDialogFilter': true,
  'messages.updateDialogFiltersOrder': true,
```

Rationale: these are fire-and-forget from FiltersStorage's perspective — it calls them, awaits the resolution, then updates local state. Returning `true` is enough because the code at `filters.ts:348` only uses `.then()` without inspecting the response shape.

- [ ] **Step 4: Write a test for the intercept**

Create `src/tests/nostra/virtual-mtproto-filters.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
import {NOSTRA_STATIC} from '@lib/nostra/virtual-mtproto-server';

describe('virtual mtproto filter intercepts', () => {
  it('intercepts messages.getDialogFilters as empty array', () => {
    expect(NOSTRA_STATIC['messages.getDialogFilters']).toEqual([]);
  });

  it('intercepts messages.updateDialogFilter as true (no-op)', () => {
    expect(NOSTRA_STATIC['messages.updateDialogFilter']).toBe(true);
  });

  it('intercepts messages.updateDialogFiltersOrder as true (no-op)', () => {
    expect(NOSTRA_STATIC['messages.updateDialogFiltersOrder']).toBe(true);
  });
});
```

This test requires `NOSTRA_STATIC` to be exported. Check `src/lib/nostra/virtual-mtproto-server.ts` — if `NOSTRA_STATIC` is currently not exported, add `export` to its declaration.

- [ ] **Step 5: Run tests**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/virtual-mtproto-filters.test.ts src/tests/nostra/filters-seed.test.ts 2>&1 | tail -30`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git add src/lib/storages/filters.ts src/lib/nostra/virtual-mtproto-server.ts src/tests/nostra/filters-seed.test.ts src/tests/nostra/virtual-mtproto-filters.test.ts
git commit -m "$(cat <<'EOF'
feat(folders): guard protected folders from deletion + no-op MTProto intercepts

updateDialogFilter now rejects with FILTER_PROTECTED when asked to
delete All/Archive/Persons/Groups. Virtual MTProto Server returns true
for updateDialogFilter/updateDialogFiltersOrder so FiltersStorage can
persist rename and reorder without a real server.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: UI — resolve langpack titles and hide Delete for protected folders

**Files:**
- Modify: `src/components/sidebarLeft/foldersSidebarContent/folderItem.tsx` (or equivalent that renders folder title)
- Modify: `src/components/sidebarLeft/tabs/chatFolders.ts` (or the folder context menu / edit form)

- [ ] **Step 1: Locate where folder titles are rendered**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && grep -rn "filter.title\|filter\.title\.text" src/components/sidebarLeft/foldersSidebarContent/ src/components/chat/folders*.ts src/components/sidebarLeft/tabs/chatFolders.ts 2>/dev/null | head -20`

Identify the exact file and line where `filter.title.text` is read and rendered. This will be either a `.tsx` component or a `.ts` imperative DOM builder.

- [ ] **Step 2: Add langpack resolution helper**

Create `src/lib/nostra/folder-title.ts`:

```typescript
import {LANGPACK_PREFIX} from '@lib/storages/filtersLocal';
import {i18n} from '@lib/langPack';
import type {DialogFilter} from '@layer';

/**
 * Resolves a folder title for display. If the title uses the LANGPACK:
 * sentinel, returns a reactive i18n element; otherwise returns the literal
 * text (user-renamed folders or Telegram-provided titles).
 */
export function resolveFolderTitle(title: DialogFilter.dialogFilter['title']): Node | string {
  const text = title?.text ?? '';
  if(text.startsWith(LANGPACK_PREFIX)) {
    const key = text.slice(LANGPACK_PREFIX.length);
    return i18n(key as any);
  }
  return text;
}
```

(`i18n` from `@lib/langPack` returns an `HTMLElement` that updates on locale change — verify the exact import path by running `grep -rn "export.*function i18n" src/lib/langPack.ts` first.)

- [ ] **Step 3: Wire `resolveFolderTitle` into the folder render site**

In the file identified in Step 1, replace the direct `filter.title.text` read with:

```typescript
import {resolveFolderTitle} from '@lib/nostra/folder-title';

// ... where the title is rendered:
const titleNode = resolveFolderTitle(filter.title);
```

Exact substitution depends on the file. If it's a `.tsx` component, return `{titleNode}`. If it's imperative DOM (`.ts`), `appendChild(titleNode instanceof Node ? titleNode : document.createTextNode(titleNode))`.

- [ ] **Step 4: Hide Delete button for protected folders**

Locate the folder edit form / context menu in `src/components/sidebarLeft/tabs/chatFolders.ts`. Run:

`cd /home/raider/Repository/nostra.chat-wt/folders && grep -n "FolderDelete\|deleteDialogFilter\|Delete.*Folder" src/components/sidebarLeft/tabs/chatFolders.ts`

Around the matching button construction, add:

```typescript
import {isProtectedFolder} from '@lib/nostra/folders-protection';

// ...before rendering the delete button:
if(!isProtectedFolder(filter.id)) {
  // render delete button
}
```

- [ ] **Step 5: Build + manual smoke**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm start &`
Wait 10 seconds for Vite to come up, then: open `http://localhost:8080?debug=1` in a browser, complete onboarding, verify:
  - Three folder tabs visible: "All Chats", "Contacts", "Groups" (in English locale) or their localised equivalents
  - Opening the folder edit UI shows no Delete button for the 3 defaults
  - Creating a custom folder "Lavoro" — the Delete button IS visible for it
Kill the dev server: `pkill -f "vite"`.

Record your observations in the commit message body if anything is off — do NOT claim success if you cannot verify visually.

- [ ] **Step 6: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git add src/lib/nostra/folder-title.ts src/components/sidebarLeft/foldersSidebarContent/ src/components/sidebarLeft/tabs/chatFolders.ts
git commit -m "$(cat <<'EOF'
feat(folders): resolve langpack titles and hide Delete for protected folders

Protected folders (All/Archive/Persons/Groups) display localised titles
via I18n and cannot be deleted through the UI. The storage layer still
enforces protection as a backstop.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Define the FolderSnapshot schema and sync-state localStorage helpers

**Files:**
- Create: `src/lib/nostra/folders-sync-types.ts`
- Create: `src/lib/nostra/folders-sync-state.ts`

- [ ] **Step 1: Write failing test**

Create `src/tests/nostra/folders-sync-state.test.ts`:

```typescript
import {describe, it, expect, beforeEach} from 'vitest';
import {
  getLastPublishedAt,
  setLastPublishedAt,
  getLastModifiedAt,
  setLastModifiedAt,
  LS_KEY_LAST_PUBLISHED,
  LS_KEY_LAST_MODIFIED
} from '@lib/nostra/folders-sync-state';

describe('folders-sync-state', () => {
  beforeEach(() => {
    localStorage.removeItem(LS_KEY_LAST_PUBLISHED);
    localStorage.removeItem(LS_KEY_LAST_MODIFIED);
  });

  it('returns 0 when no published timestamp stored', () => {
    expect(getLastPublishedAt()).toBe(0);
  });

  it('roundtrips published timestamp', () => {
    setLastPublishedAt(1234567890);
    expect(getLastPublishedAt()).toBe(1234567890);
  });

  it('roundtrips modified timestamp', () => {
    setLastModifiedAt(1234567891);
    expect(getLastModifiedAt()).toBe(1234567891);
  });

  it('uses expected localStorage keys', () => {
    expect(LS_KEY_LAST_PUBLISHED).toBe('nostra-folders-last-published');
    expect(LS_KEY_LAST_MODIFIED).toBe('nostra-folders-last-modified');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/folders-sync-state.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the types module**

Create `src/lib/nostra/folders-sync-types.ts`:

```typescript
import type {MyDialogFilter} from '@lib/storages/filters';

export const FOLDERS_SYNC_VERSION = 1;
export const FOLDERS_SYNC_D_TAG = 'nostra.chat/folders';
export const FOLDERS_SYNC_KIND = 30078;

export type FolderSnapshot = {
  version: number;
  order: number[];                       // full order including system IDs
  customFolders: MyDialogFilter[];       // only IDs >= START_LOCAL_ID (4)
  protectedTitles?: Record<number, {_: 'textWithEntities', text: string, entities: any[]}>;
};

export function isValidSnapshot(obj: unknown): obj is FolderSnapshot {
  if(!obj || typeof obj !== 'object') return false;
  const s = obj as FolderSnapshot;
  return (
    typeof s.version === 'number' &&
    Array.isArray(s.order) &&
    s.order.every((n) => typeof n === 'number') &&
    Array.isArray(s.customFolders)
  );
}
```

- [ ] **Step 4: Create the state helpers**

Create `src/lib/nostra/folders-sync-state.ts`:

```typescript
export const LS_KEY_LAST_PUBLISHED = 'nostra-folders-last-published';
export const LS_KEY_LAST_MODIFIED = 'nostra-folders-last-modified';

function readTs(key: string): number {
  try {
    const v = localStorage.getItem(key);
    if(!v) return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function writeTs(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {}
}

export const getLastPublishedAt = () => readTs(LS_KEY_LAST_PUBLISHED);
export const setLastPublishedAt = (v: number) => writeTs(LS_KEY_LAST_PUBLISHED, v);
export const getLastModifiedAt = () => readTs(LS_KEY_LAST_MODIFIED);
export const setLastModifiedAt = (v: number) => writeTs(LS_KEY_LAST_MODIFIED, v);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/folders-sync-state.test.ts 2>&1 | tail -20`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git add src/lib/nostra/folders-sync-types.ts src/lib/nostra/folders-sync-state.ts src/tests/nostra/folders-sync-state.test.ts
git commit -m "$(cat <<'EOF'
feat(folders-sync): add snapshot schema and localStorage state helpers

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: FoldersSync — build and consume snapshots (pure logic, no relay I/O)

**Files:**
- Create: `src/lib/nostra/folders-sync-snapshot.ts`
- Create: `src/tests/nostra/folders-sync-snapshot.test.ts`

This task isolates the pure snapshot build + apply logic so it can be tested without relays or IndexedDB.

- [ ] **Step 1: Write failing tests**

Create `src/tests/nostra/folders-sync-snapshot.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
import {buildSnapshotFromFilters, applySnapshotToFilters} from '@lib/nostra/folders-sync-snapshot';
import {buildLocalFilter, LANGPACK_PREFIX} from '@lib/storages/filtersLocal';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_ARCHIVE,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS
} from '@appManagers/constants';
import {FOLDERS_SYNC_VERSION} from '@lib/nostra/folders-sync-types';
import type {MyDialogFilter} from '@lib/storages/filters';

function mkCustom(id: number, title: string): MyDialogFilter {
  const f = buildLocalFilter(FOLDER_ID_ALL);
  f.id = id;
  f.title = {_: 'textWithEntities', text: title, entities: []};
  f.pFlags = {};
  return f;
}

describe('buildSnapshotFromFilters', () => {
  it('includes order of all filters and only custom folders in customFolders', () => {
    const filters = [
      buildLocalFilter(FOLDER_ID_ALL),
      buildLocalFilter(FOLDER_ID_PERSONS),
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE),
      mkCustom(4, 'Work')
    ];
    const snap = buildSnapshotFromFilters(filters);
    expect(snap.version).toBe(FOLDERS_SYNC_VERSION);
    expect(snap.order).toEqual([0, 2, 3, 1, 4]);
    expect(snap.customFolders).toHaveLength(1);
    expect(snap.customFolders[0].id).toBe(4);
    expect(snap.customFolders[0].title.text).toBe('Work');
  });

  it('records protected-folder renames in protectedTitles', () => {
    const persons = buildLocalFilter(FOLDER_ID_PERSONS);
    persons.title = {_: 'textWithEntities', text: 'Amici', entities: []};
    const filters = [
      buildLocalFilter(FOLDER_ID_ALL),
      persons,
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE)
    ];
    const snap = buildSnapshotFromFilters(filters);
    expect(snap.protectedTitles?.[FOLDER_ID_PERSONS]?.text).toBe('Amici');
    expect(snap.protectedTitles?.[FOLDER_ID_GROUPS]).toBeUndefined();
  });

  it('omits protectedTitles entry for langpack default titles', () => {
    const filters = [
      buildLocalFilter(FOLDER_ID_ALL),
      buildLocalFilter(FOLDER_ID_PERSONS),
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE)
    ];
    const snap = buildSnapshotFromFilters(filters);
    expect(snap.protectedTitles).toEqual({});
  });
});

describe('applySnapshotToFilters', () => {
  it('replaces custom folders and order, keeps seeded system folders', () => {
    const local: MyDialogFilter[] = [
      buildLocalFilter(FOLDER_ID_ALL),
      buildLocalFilter(FOLDER_ID_PERSONS),
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE),
      mkCustom(4, 'Old Custom')
    ];
    const remote = {
      version: 1,
      order: [0, 3, 2, 1, 5],
      customFolders: [mkCustom(5, 'New Custom')],
      protectedTitles: {}
    };
    const result = applySnapshotToFilters(local, remote);
    expect(result.map((f) => f.id)).toEqual([0, 3, 2, 1, 5]);
    expect(result.find((f) => f.id === 5)?.title.text).toBe('New Custom');
    expect(result.find((f) => f.id === 4)).toBeUndefined();
  });

  it('applies protectedTitles to the seeded folders', () => {
    const local: MyDialogFilter[] = [
      buildLocalFilter(FOLDER_ID_ALL),
      buildLocalFilter(FOLDER_ID_PERSONS),
      buildLocalFilter(FOLDER_ID_GROUPS),
      buildLocalFilter(FOLDER_ID_ARCHIVE)
    ];
    const remote = {
      version: 1,
      order: [0, 2, 3, 1],
      customFolders: [],
      protectedTitles: {
        [FOLDER_ID_PERSONS]: {_: 'textWithEntities' as const, text: 'Amici', entities: []}
      }
    };
    const result = applySnapshotToFilters(local, remote);
    const persons = result.find((f) => f.id === FOLDER_ID_PERSONS);
    expect(persons?.title.text).toBe('Amici');
    const groups = result.find((f) => f.id === FOLDER_ID_GROUPS);
    expect(groups?.title.text.startsWith(LANGPACK_PREFIX)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/folders-sync-snapshot.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement snapshot builder and applier**

Create `src/lib/nostra/folders-sync-snapshot.ts`:

```typescript
import type {MyDialogFilter} from '@lib/storages/filters';
import type {FolderSnapshot} from '@lib/nostra/folders-sync-types';
import {FOLDERS_SYNC_VERSION} from '@lib/nostra/folders-sync-types';
import {LANGPACK_PREFIX} from '@lib/storages/filtersLocal';
import {START_LOCAL_ID, PROTECTED_FOLDERS} from '@appManagers/constants';
import copy from '@helpers/object/copy';

export function buildSnapshotFromFilters(filters: MyDialogFilter[]): FolderSnapshot {
  const order = filters.map((f) => f.id);
  const customFolders = filters
    .filter((f) => f.id >= START_LOCAL_ID)
    .map((f) => copy(f));

  const protectedTitles: FolderSnapshot['protectedTitles'] = {};
  for(const f of filters) {
    if(!PROTECTED_FOLDERS.has(f.id)) continue;
    const text = f.title?.text ?? '';
    if(text && !text.startsWith(LANGPACK_PREFIX)) {
      protectedTitles[f.id] = copy(f.title) as any;
    }
  }

  return {
    version: FOLDERS_SYNC_VERSION,
    order,
    customFolders,
    protectedTitles
  };
}

/**
 * Apply a remote snapshot to a set of local filters. Seeded system folders
 * are kept as-is (caller is responsible for running prependFilters afterward
 * to ensure they exist), with protectedTitles overlaid.
 *
 * Returns a new array in the order specified by `snapshot.order`; any ID
 * in `snapshot.order` that is not a system folder and not in
 * `snapshot.customFolders` is dropped (orphan). System folders missing
 * from `snapshot.order` are appended at the end so prependFilters can pick
 * them up in the next step.
 */
export function applySnapshotToFilters(
  local: MyDialogFilter[],
  snapshot: FolderSnapshot
): MyDialogFilter[] {
  const byId = new Map<number, MyDialogFilter>();
  // System folders come from local (preserves generated pFlags + pinned peers)
  for(const f of local) {
    if(PROTECTED_FOLDERS.has(f.id)) {
      const overlay = snapshot.protectedTitles?.[f.id];
      byId.set(f.id, overlay ? {...f, title: overlay} : f);
    }
  }
  // Custom folders come from snapshot
  for(const f of snapshot.customFolders) {
    byId.set(f.id, copy(f));
  }

  const out: MyDialogFilter[] = [];
  for(const id of snapshot.order) {
    const f = byId.get(id);
    if(f) out.push(f);
  }
  // Append any system folder that the remote order forgot
  for(const f of local) {
    if(PROTECTED_FOLDERS.has(f.id) && !out.find((x) => x.id === f.id)) {
      out.push(f);
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/folders-sync-snapshot.test.ts 2>&1 | tail -30`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git add src/lib/nostra/folders-sync-snapshot.ts src/tests/nostra/folders-sync-snapshot.test.ts
git commit -m "$(cat <<'EOF'
feat(folders-sync): pure snapshot build/apply with protected title overlay

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: FoldersSync — merge decision logic (pure)

**Files:**
- Create: `src/lib/nostra/folders-sync-merge.ts`
- Create: `src/tests/nostra/folders-sync-merge.test.ts`

- [ ] **Step 1: Write failing tests**

Create `src/tests/nostra/folders-sync-merge.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
import {decideMerge} from '@lib/nostra/folders-sync-merge';

describe('decideMerge', () => {
  it('no-remote → publish-local', () => {
    const d = decideMerge({
      remoteCreatedAt: null,
      localPublishedAt: 0,
      localModifiedAt: 0,
      hasLocalCustomFolders: true
    });
    expect(d.action).toBe('publish-local');
    expect(d.showToast).toBe(false);
  });

  it('no-remote + no custom folders → no-op', () => {
    const d = decideMerge({
      remoteCreatedAt: null,
      localPublishedAt: 0,
      localModifiedAt: 0,
      hasLocalCustomFolders: false
    });
    expect(d.action).toBe('no-op');
  });

  it('remote newer than local-modified → remote-wins clean (no toast)', () => {
    const d = decideMerge({
      remoteCreatedAt: 200,
      localPublishedAt: 100,
      localModifiedAt: 100,
      hasLocalCustomFolders: true
    });
    expect(d.action).toBe('remote-wins');
    expect(d.showToast).toBe(false);
  });

  it('remote newer AND local-modified > local-published AND local-modified < remote → remote-wins with toast', () => {
    const d = decideMerge({
      remoteCreatedAt: 300,
      localPublishedAt: 100,
      localModifiedAt: 200,
      hasLocalCustomFolders: true
    });
    expect(d.action).toBe('remote-wins');
    expect(d.showToast).toBe(true);
  });

  it('local-modified newer than remote → local-wins', () => {
    const d = decideMerge({
      remoteCreatedAt: 100,
      localPublishedAt: 100,
      localModifiedAt: 200,
      hasLocalCustomFolders: true
    });
    expect(d.action).toBe('local-wins');
  });

  it('remote == local-published → in-sync', () => {
    const d = decideMerge({
      remoteCreatedAt: 100,
      localPublishedAt: 100,
      localModifiedAt: 50,
      hasLocalCustomFolders: true
    });
    expect(d.action).toBe('in-sync');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/folders-sync-merge.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement merge decision**

Create `src/lib/nostra/folders-sync-merge.ts`:

```typescript
export type MergeInputs = {
  remoteCreatedAt: number | null;
  localPublishedAt: number;
  localModifiedAt: number;
  hasLocalCustomFolders: boolean;
};

export type MergeDecision =
  | {action: 'publish-local', showToast: false}
  | {action: 'remote-wins', showToast: boolean}
  | {action: 'local-wins', showToast: false}
  | {action: 'in-sync', showToast: false}
  | {action: 'no-op', showToast: false};

export function decideMerge(i: MergeInputs): MergeDecision {
  if(i.remoteCreatedAt === null) {
    return i.hasLocalCustomFolders
      ? {action: 'publish-local', showToast: false}
      : {action: 'no-op', showToast: false};
  }

  if(i.remoteCreatedAt === i.localPublishedAt) {
    return {action: 'in-sync', showToast: false};
  }

  if(i.localModifiedAt > i.remoteCreatedAt) {
    return {action: 'local-wins', showToast: false};
  }

  // Remote wins. Decide whether to show the toast.
  // Toast = user made local offline changes (modified > published) AND
  // those changes are being overwritten (remote > modified).
  const localHadUnpublishedChanges =
    i.localModifiedAt > i.localPublishedAt && i.localModifiedAt > 0;
  return {action: 'remote-wins', showToast: localHadUnpublishedChanges};
}
```

- [ ] **Step 4: Run tests**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/folders-sync-merge.test.ts 2>&1 | tail -20`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git add src/lib/nostra/folders-sync-merge.ts src/tests/nostra/folders-sync-merge.test.ts
git commit -m "$(cat <<'EOF'
feat(folders-sync): pure merge decision (LWW with toast on offline conflict)

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: FoldersSync orchestrator class

**Files:**
- Create: `src/lib/nostra/folders-sync.ts`
- Create: `src/tests/nostra/folders-sync.test.ts`
- Modify: `src/lang.ts` — add `FoldersSyncOverwritten` i18n key

- [ ] **Step 1: Add i18n key**

In `src/lang.ts`, add to the appropriate section (search for `FilterContacts` to find the right block):

```typescript
'FoldersSyncOverwritten': {
  'en': 'Folders updated from another device. Your local changes were overwritten.',
  'it': 'Cartelle aggiornate da un altro device. Le tue modifiche locali sono state sovrascritte.'
},
```

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && grep -n "FoldersSyncOverwritten" src/lang.ts`
Expected: one match in `src/lang.ts`.

- [ ] **Step 2: Write failing tests**

Create `src/tests/nostra/folders-sync.test.ts`:

```typescript
import {describe, it, expect, vi, beforeEach} from 'vitest';
import {FoldersSync} from '@lib/nostra/folders-sync';
import {buildLocalFilter} from '@lib/storages/filtersLocal';
import {
  FOLDER_ID_ALL,
  FOLDER_ID_PERSONS,
  FOLDER_ID_GROUPS,
  FOLDER_ID_ARCHIVE
} from '@appManagers/constants';
import {FOLDERS_SYNC_KIND, FOLDERS_SYNC_D_TAG} from '@lib/nostra/folders-sync-types';
import type {MyDialogFilter} from '@lib/storages/filters';

function mkCustom(id: number, title: string): MyDialogFilter {
  const f = buildLocalFilter(FOLDER_ID_ALL);
  f.id = id;
  f.title = {_: 'textWithEntities', text: title, entities: []};
  return f;
}

function mkBaseFilters(): MyDialogFilter[] {
  return [
    buildLocalFilter(FOLDER_ID_ALL),
    buildLocalFilter(FOLDER_ID_PERSONS),
    buildLocalFilter(FOLDER_ID_GROUPS),
    buildLocalFilter(FOLDER_ID_ARCHIVE)
  ];
}

function mkMockDeps() {
  const publishedEvents: any[] = [];
  const fetchResults: any[] = [];
  const toastFires: string[] = [];
  const filtersState: {current: MyDialogFilter[]} = {current: mkBaseFilters()};

  return {
    chatAPI: {
      publishEvent: vi.fn(async (ev: any) => { publishedEvents.push(ev); }),
      queryEvents: vi.fn(async () => fetchResults.shift() ?? null)
    } as any,
    filtersStore: {
      getFilters: () => filtersState.current,
      setFilters: (next: MyDialogFilter[]) => { filtersState.current = next; },
      reseedSystemFolders: () => {
        // no-op in tests — the merge already preserves system folders
      }
    },
    encrypt: (plain: string) => `enc(${plain})`,
    decrypt: (cipher: string) => cipher.replace(/^enc\(|\)$/g, ''),
    nowSeconds: () => 1000,
    toast: (msg: string) => { toastFires.push(msg); },
    // exposed for assertions
    _state: {publishedEvents, fetchResults, toastFires, filtersState}
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('FoldersSync.reconcile', () => {
  it('no-remote + no custom folders → no publish', async () => {
    const deps = mkMockDeps();
    const sync = new FoldersSync(deps);
    const res = await sync.reconcile();
    expect(res.action).toBe('no-op');
    expect(deps._state.publishedEvents).toHaveLength(0);
  });

  it('no-remote + custom folder → publishes local', async () => {
    const deps = mkMockDeps();
    deps._state.filtersState.current = [...mkBaseFilters(), mkCustom(4, 'Work')];
    const sync = new FoldersSync(deps);
    const res = await sync.reconcile();
    expect(res.action).toBe('publish-local');
    expect(deps._state.publishedEvents).toHaveLength(1);
    const ev = deps._state.publishedEvents[0];
    expect(ev.kind).toBe(FOLDERS_SYNC_KIND);
    expect(ev.tags).toContainEqual(['d', FOLDERS_SYNC_D_TAG]);
  });

  it('remote wins cleanly → applies snapshot, no toast', async () => {
    const deps = mkMockDeps();
    const payload = {
      version: 1,
      order: [0, 2, 3, 1, 5],
      customFolders: [mkCustom(5, 'RemoteCustom')],
      protectedTitles: {}
    };
    deps._state.fetchResults.push({
      kind: FOLDERS_SYNC_KIND,
      created_at: 500,
      content: `enc(${JSON.stringify(payload)})`
    });
    const sync = new FoldersSync(deps);
    const res = await sync.reconcile();
    expect(res.action).toBe('remote-wins');
    expect(deps._state.toastFires).toHaveLength(0);
    const after = deps._state.filtersState.current;
    expect(after.find((f) => f.id === 5)?.title.text).toBe('RemoteCustom');
  });

  it('remote wins with offline local changes → fires toast', async () => {
    const deps = mkMockDeps();
    // Simulate: user modified locally at t=200, published at t=100, remote at t=300
    localStorage.setItem('nostra-folders-last-published', '100');
    localStorage.setItem('nostra-folders-last-modified', '200');
    const payload = {
      version: 1,
      order: [0, 2, 3, 1],
      customFolders: [],
      protectedTitles: {}
    };
    deps._state.fetchResults.push({
      kind: FOLDERS_SYNC_KIND,
      created_at: 300,
      content: `enc(${JSON.stringify(payload)})`
    });
    const sync = new FoldersSync(deps);
    const res = await sync.reconcile();
    expect(res.action).toBe('remote-wins');
    expect(deps._state.toastFires).toHaveLength(1);
    expect(deps._state.toastFires[0]).toMatch(/Folders updated|Cartelle aggiornate/);
  });

  it('local wins → publishes new event', async () => {
    const deps = mkMockDeps();
    deps._state.filtersState.current = [...mkBaseFilters(), mkCustom(4, 'LocalNew')];
    localStorage.setItem('nostra-folders-last-published', '100');
    localStorage.setItem('nostra-folders-last-modified', '500');
    deps._state.fetchResults.push({
      kind: FOLDERS_SYNC_KIND,
      created_at: 200,
      content: `enc(${JSON.stringify({version: 1, order: [0, 2, 3, 1], customFolders: [], protectedTitles: {}})})`
    });
    const sync = new FoldersSync(deps);
    const res = await sync.reconcile();
    expect(res.action).toBe('local-wins');
    expect(deps._state.publishedEvents).toHaveLength(1);
  });

  it('unknown version in remote → ignored, treated as no-remote', async () => {
    const deps = mkMockDeps();
    deps._state.fetchResults.push({
      kind: FOLDERS_SYNC_KIND,
      created_at: 500,
      content: `enc(${JSON.stringify({version: 99, order: [], customFolders: []})})`
    });
    const sync = new FoldersSync(deps);
    const res = await sync.reconcile();
    expect(res.action).toBe('no-op');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/folders-sync.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement FoldersSync**

Create `src/lib/nostra/folders-sync.ts`:

```typescript
import type {MyDialogFilter} from '@lib/storages/filters';
import {
  FOLDERS_SYNC_KIND,
  FOLDERS_SYNC_D_TAG,
  FOLDERS_SYNC_VERSION,
  isValidSnapshot,
  type FolderSnapshot
} from '@lib/nostra/folders-sync-types';
import {buildSnapshotFromFilters, applySnapshotToFilters} from '@lib/nostra/folders-sync-snapshot';
import {decideMerge, type MergeDecision} from '@lib/nostra/folders-sync-merge';
import {
  getLastPublishedAt, setLastPublishedAt,
  getLastModifiedAt
} from '@lib/nostra/folders-sync-state';
import {START_LOCAL_ID} from '@appManagers/constants';

export type FoldersSyncDeps = {
  chatAPI: {
    publishEvent: (event: {kind: number, created_at: number, tags: any[], content: string}) => Promise<void>;
    queryEvents: (filter: {kinds: number[], '#d': string[], limit: number}) => Promise<{kind: number, created_at: number, content: string} | null>;
  };
  filtersStore: {
    getFilters: () => MyDialogFilter[];
    setFilters: (next: MyDialogFilter[]) => void;
    reseedSystemFolders: () => void;
  };
  encrypt: (plaintext: string) => string;
  decrypt: (ciphertext: string) => string;
  nowSeconds: () => number;
  toast: (message: string) => void;
  // Optional: resolve i18n key to localized string for toast. Defaults to English.
  i18n?: (key: string) => string;
};

export type ReconcileResult = MergeDecision;

export class FoldersSync {
  private applyingRemote = false;

  constructor(private deps: FoldersSyncDeps) {}

  async reconcile(): Promise<ReconcileResult> {
    const remote = await this.fetchRemote();
    const filters = this.deps.filtersStore.getFilters();
    const hasCustom = filters.some((f) => f.id >= START_LOCAL_ID);

    const decision = decideMerge({
      remoteCreatedAt: remote?.createdAt ?? null,
      localPublishedAt: getLastPublishedAt(),
      localModifiedAt: getLastModifiedAt(),
      hasLocalCustomFolders: hasCustom
    });

    switch(decision.action) {
      case 'publish-local':
        await this.publish();
        return decision;

      case 'local-wins':
        await this.publish();
        return decision;

      case 'remote-wins':
        this.applyingRemote = true;
        try {
          const next = applySnapshotToFilters(filters, remote!.snapshot);
          this.deps.filtersStore.setFilters(next);
          this.deps.filtersStore.reseedSystemFolders();
          if(decision.showToast) {
            const msg = this.deps.i18n
              ? this.deps.i18n('FoldersSyncOverwritten')
              : 'Folders updated from another device. Your local changes were overwritten.';
            this.deps.toast(msg);
          }
        } finally {
          this.applyingRemote = false;
        }
        return decision;

      case 'in-sync':
      case 'no-op':
        return decision;
    }
  }

  async publish(): Promise<void> {
    if(this.applyingRemote) return;
    const filters = this.deps.filtersStore.getFilters();
    const snapshot = buildSnapshotFromFilters(filters);
    const plaintext = JSON.stringify(snapshot);
    const ciphertext = this.deps.encrypt(plaintext);
    const createdAt = this.deps.nowSeconds();

    await this.deps.chatAPI.publishEvent({
      kind: FOLDERS_SYNC_KIND,
      created_at: createdAt,
      tags: [['d', FOLDERS_SYNC_D_TAG]],
      content: ciphertext
    });

    setLastPublishedAt(createdAt);
  }

  private async fetchRemote(): Promise<{createdAt: number, snapshot: FolderSnapshot} | null> {
    let ev;
    try {
      ev = await this.deps.chatAPI.queryEvents({
        kinds: [FOLDERS_SYNC_KIND],
        '#d': [FOLDERS_SYNC_D_TAG],
        limit: 1
      });
    } catch {
      return null;
    }
    if(!ev) return null;

    let snapshot: unknown;
    try {
      snapshot = JSON.parse(this.deps.decrypt(ev.content));
    } catch {
      return null;
    }
    if(!isValidSnapshot(snapshot)) return null;
    if(snapshot.version !== FOLDERS_SYNC_VERSION) {
      console.warn('[FoldersSync] unknown snapshot version', snapshot.version);
      return null;
    }
    return {createdAt: ev.created_at, snapshot};
  }
}
```

- [ ] **Step 5: Run tests**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm vitest run src/tests/nostra/folders-sync.test.ts 2>&1 | tail -30`
Expected: PASS (6 tests).

- [ ] **Step 6: Type check**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "@vendor" | head -30`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git add src/lang.ts src/lib/nostra/folders-sync.ts src/tests/nostra/folders-sync.test.ts
git commit -m "$(cat <<'EOF'
feat(folders-sync): FoldersSync orchestrator with reconcile and publish

Composes the pure snapshot/merge modules behind a ChatAPI-injected
orchestrator. Adds FoldersSyncOverwritten i18n key for the conflict toast.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Wire FoldersSync into boot sequence and debounced publish

**Files:**
- Modify: `src/lib/nostra/nostra-onboarding-integration.ts`
- Modify: `src/lib/nostra/nostra-cleanup.ts:17-22`

- [ ] **Step 1: Add new localStorage keys to cleanup**

In `src/lib/nostra/nostra-cleanup.ts`, replace lines 17-22:

```typescript
// All Nostra localStorage keys
const NOSTRA_LS_KEYS = [
  'nostra_identity',
  'nostra-relay-config',
  'nostra-last-seen-timestamp',
  'nostra:read-receipts-enabled',
  'nostra-folders-last-published',
  'nostra-folders-last-modified'
];
```

- [ ] **Step 2: Locate the onboarding integration entry point**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && grep -n "initGlobalSubscription\|ChatAPI\|export async function\|export function" src/lib/nostra/nostra-onboarding-integration.ts | head -20`

Identify the function that runs after `FiltersStorage` is loaded and before the first UI paint.

- [ ] **Step 3: Instantiate and wire FoldersSync**

In `src/lib/nostra/nostra-onboarding-integration.ts`, inside the identified boot function, after `chatAPI` is ready, add:

```typescript
import {FoldersSync} from '@lib/nostra/folders-sync';
import {setLastModifiedAt} from '@lib/nostra/folders-sync-state';
import {nip44Encrypt, nip44Decrypt} from '@lib/nostra/nostr-crypto';
import * as nip44 from 'nostr-tools/nip44';
import {toastNew} from '@components/toast';
import {i18n as i18nElement, I18n} from '@lib/langPack';
import rootScope from '@lib/rootScope';

// ... inside the boot function, after chatAPI is connected:

const convKey = nip44.v2.utils.getConversationKey(identity.secretKey, identity.pubkey);

const foldersSync = new FoldersSync({
  chatAPI: {
    publishEvent: (event) => chatAPI.publishEvent(event as any),
    queryEvents: (filter) => chatAPI.queryLatestEvent(filter as any)
  },
  filtersStore: {
    getFilters: () => Object.values(rootScope.managers.filtersStorage.getFilters()),
    setFilters: (next) => rootScope.managers.filtersStorage.replaceAllFilters(next),
    reseedSystemFolders: () => rootScope.managers.filtersStorage.reseedSystemFolders()
  },
  encrypt: (plain) => nip44Encrypt(plain, convKey),
  decrypt: (cipher) => nip44Decrypt(cipher, convKey),
  nowSeconds: () => Math.floor(Date.now() / 1000),
  toast: (msg) => toastNew({langPackKey: 'FoldersSyncOverwritten'}),
  i18n: (key) => I18n.format(key as any, true)
});

// Bounded 5s reconcile
await Promise.race([
  foldersSync.reconcile().catch((e) => console.warn('[FoldersSync] reconcile failed', e)),
  new Promise((resolve) => setTimeout(resolve, 5000))
]);

// Debounced publish on filter events
let publishTimer: ReturnType<typeof setTimeout> | null = null;
const schedulePublish = () => {
  setLastModifiedAt(Math.floor(Date.now() / 1000));
  if(publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    foldersSync.publish().catch((e) => console.warn('[FoldersSync] publish failed', e));
  }, 2000);
};

rootScope.addEventListener('filter_update', schedulePublish);
rootScope.addEventListener('filter_delete', schedulePublish);
rootScope.addEventListener('filter_order', schedulePublish);
```

**Important:** `chatAPI.publishEvent` / `queryLatestEvent` and `FiltersStorage.replaceAllFilters` / `reseedSystemFolders` are names used here as *the contract* — verify the actual APIs before committing. Run:

```bash
cd /home/raider/Repository/nostra.chat-wt/folders && grep -n "publishEvent\|query.*Event\|queryLatest" src/lib/nostra/chat-api.ts | head
cd /home/raider/Repository/nostra.chat-wt/folders && grep -n "replaceAll\|reseed" src/lib/storages/filters.ts
```

If the methods don't exist, add them:

- `ChatAPI.queryLatestEvent(filter)` — wraps `RelayPool` query with `limit: 1`, takes the highest `created_at` across all relays, returns the event or `null`
- `FiltersStorage.replaceAllFilters(next: MyDialogFilter[])` — atomic replace: clear `this.filters` / `this.filtersArr`, re-populate from `next`, dispatch `filter_update` for each new filter and `filter_order`
- `FiltersStorage.reseedSystemFolders()` — runs a subset of `prependFilters` logic: ensures the 4 system IDs exist in `this.filters` / `this.filtersArr`, calling `generateLocalFilter` for any missing one

Adding these helpers to `FiltersStorage` is a small refactor (~30 lines) and should be part of this task's commit. The helpers should dispatch events so bubbles / sidebar / any listener updates reactively.

- [ ] **Step 4: Verify type check**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "@vendor" | head -30`
Expected: no new errors.

- [ ] **Step 5: Run full unit test suite**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm test:nostra:quick 2>&1 | tail -20`
Expected: all tests pass (pre-existing + new).

- [ ] **Step 6: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git add src/lib/nostra/nostra-onboarding-integration.ts src/lib/nostra/nostra-cleanup.ts src/lib/storages/filters.ts src/lib/nostra/chat-api.ts
git commit -m "$(cat <<'EOF'
feat(folders-sync): wire FoldersSync into boot with debounced publish

Boot flow blocks up to 5s for reconcile, then attaches a 2s-debounced
publish listener to filter_update/delete/order. Logout cleanup clears
the new localStorage state keys.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 12: E2E test — two devices sharing identity via local relay

**Files:**
- Create: `src/tests/e2e/e2e-default-folders-sync.ts`

- [ ] **Step 1: Scaffold E2E test**

Create `src/tests/e2e/e2e-default-folders-sync.ts`:

```typescript
// @ts-nocheck
import {chromium} from 'playwright';
import {LocalRelay} from './helpers/local-relay';
import {launchOptions} from './helpers/launch-options';

const APP_URL = 'http://localhost:8080';

async function bootstrapContext(browser: any, relay: LocalRelay, label: string) {
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    const t = msg.text();
    if(/\[ChatAPI\]|\[FoldersSync\]|\[NostraOnboarding/.test(t)) {
      console.log(`[${label}]`, t);
    }
  });
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(15000);
  return {ctx, page};
}

async function run() {
  const relay = new LocalRelay();
  await relay.start();
  const browser = await chromium.launch(launchOptions());

  try {
    // --- Device A: onboard fresh ---
    const a = await bootstrapContext(browser, relay, 'A');
    await a.page.getByText('SKIP').click().catch(() => {});
    await a.page.waitForTimeout(3000);

    // Verify 3 default folders visible
    const titlesA = await a.page.$$eval(
      '.folders-tabs-scrollable .folder, .folders-sidebar .folder',
      (els) => els.map((e) => (e.textContent || '').trim())
    );
    console.log('[A] folder titles:', titlesA);
    if(!titlesA.some((t) => /All/i.test(t))) throw new Error('A: no All Chats folder');
    if(!titlesA.some((t) => /Contact|Person/i.test(t))) throw new Error('A: no Persons folder');
    if(!titlesA.some((t) => /Group/i.test(t))) throw new Error('A: no Groups folder');

    // Export identity for device B
    const identityA = await a.page.evaluate(() => localStorage.getItem('nostra_identity'));
    if(!identityA) throw new Error('A: no identity persisted');

    // Create custom folder via manager
    await a.page.evaluate(() => {
      const fs = (window as any).MOUNT_CLASS_TO.rootScope.managers.filtersStorage;
      return fs.createDialogFilter({
        _: 'dialogFilter',
        pFlags: {},
        id: 0,
        title: {_: 'textWithEntities', text: 'Lavoro', entities: []},
        exclude_peers: [], include_peers: [], pinned_peers: [],
        excludePeerIds: [], includePeerIds: [], pinnedPeerIds: []
      });
    });
    await a.page.waitForTimeout(3500); // past the 2s debounce

    // --- Device B: boot with A's identity ---
    const bCtx = await browser.newContext();
    await relay.injectInto(bCtx);
    await bCtx.addInitScript((id) => {
      localStorage.setItem('nostra_identity', id);
    }, identityA);
    const bPage = await bCtx.newPage();
    bPage.on('console', (msg) => {
      const t = msg.text();
      if(/\[FoldersSync\]/.test(t)) console.log('[B]', t);
    });
    await bPage.goto(APP_URL, {waitUntil: 'load'});
    await bPage.waitForTimeout(20000); // boot + reconcile

    const titlesB = await bPage.$$eval(
      '.folders-tabs-scrollable .folder, .folders-sidebar .folder',
      (els) => els.map((e) => (e.textContent || '').trim())
    );
    console.log('[B] folder titles:', titlesB);
    if(!titlesB.some((t) => /Lavoro/.test(t))) throw new Error('B: Lavoro not synced from A');

    // Verify Delete button missing on protected folder in B
    // (Navigate to folders settings and inspect)
    // SKIP the UI nav — we check via the manager directly:
    const canDelete = await bPage.evaluate(() => {
      const fs = (window as any).MOUNT_CLASS_TO.rootScope.managers.filtersStorage;
      // Try to delete Persons (id=2) — expect it to reject
      return fs.updateDialogFilter({id: 2}, true).then(() => 'resolved').catch(() => 'rejected');
    });
    if(canDelete !== 'rejected') throw new Error('B: protected folder delete was not rejected');

    console.log('[E2E] ✓ All assertions passed');
    process.exit(0);
  } catch(err) {
    console.error('[E2E] ✗', err);
    process.exit(1);
  } finally {
    await browser.close();
    await relay.stop();
  }
}

run();
```

- [ ] **Step 2: Run the E2E test**

Prerequisites: local strfry Docker container available. Run:

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
pnpm start &
sleep 8  # wait for vite
npx tsx src/tests/e2e/e2e-default-folders-sync.ts
```

Expected: `[E2E] ✓ All assertions passed` followed by `exit 0`.

If the test fails, read the output and fix. Common failure modes:
- Vite overlay blocking clicks → dismiss via `page.evaluate(() => document.querySelector('vite-plugin-checker-error-overlay')?.remove())`
- Relay propagation slower than 20s → extend the wait, but investigate if it's consistently slow
- Folder selector mismatch → inspect the actual DOM with `await page.screenshot({path: '/tmp/folders.png'})`

Kill vite: `pkill -f "vite"`

- [ ] **Step 3: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git add src/tests/e2e/e2e-default-folders-sync.ts
git commit -m "$(cat <<'EOF'
test(folders): E2E two-device sync via local strfry relay

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 13: Final verification + PR

**Files:** none new

- [ ] **Step 1: Full test suite**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm test:nostra 2>&1 | tail -10`
Expected: all tests pass.

- [ ] **Step 2: Type check**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && npx tsc --noEmit 2>&1 | grep "error TS" | grep -v "@vendor" | wc -l`
Expected: 0 new errors (pre-existing @vendor errors don't count).

- [ ] **Step 3: Lint**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm lint 2>&1 | tail -20`
Expected: no errors in any file under `src/lib/nostra/folders-*`, `src/lib/storages/filters*`, or `src/tests/nostra/folders-*`.

- [ ] **Step 4: Smoke test the app**

Run: `cd /home/raider/Repository/nostra.chat-wt/folders && pnpm start &`, wait 8s, open `http://localhost:8080`, complete onboarding, verify:
- 3 folders visible with correct localised titles
- Cannot delete Persons / Groups (no Delete button)
- Can rename them
- Can create custom folders
- Reload → all state persisted

Kill: `pkill -f "vite"`

- [ ] **Step 5: Push and open PR**

```bash
cd /home/raider/Repository/nostra.chat-wt/folders
git push -u origin feat/default-folders
gh pr create --title "feat(folders): default folders + Nostr multi-device sync" --body "$(cat <<'EOF'
## Summary
- Ships 3 protected default folders (All / Persons / Groups) via extended prependFilters seed
- Adds Nostr NIP-78 boot-only sync of custom folders with LWW conflict resolution and toast
- Preserves existing responsive horizontal/vertical folder layout

## Test plan
- [ ] pnpm test:nostra passes
- [ ] pnpm lint passes
- [ ] Type check: no new errors
- [ ] E2E e2e-default-folders-sync.ts passes
- [ ] Manual smoke: new user onboarding shows 3 folders, rename works, delete blocked on protected folders, custom folders sync between two browser contexts sharing an identity
EOF
)"
```

---

## Self-Review

**Spec coverage checklist:**

- §1 Goal 1 (3 folders present) → Task 4 (prependFilters extension)
- §1 Goal 2 (protected) → Task 5 (guard) + Task 6 (UI delete hide)
- §1 Goal 3 (responsive UI unchanged) → verified by inspection in spec §4.3, smoke test in Task 6 + 13
- §1 Goal 4 (locale-aware titles) → Task 3 (langpack sentinel) + Task 6 (resolveFolderTitle)
- §1 Goal 5 (Nostr sync) → Tasks 7–12
- §4.1 constants → Task 1
- §4.1 seed → Task 3 + Task 4
- §4.1.1 UI delete hide → Task 6
- §4.1.2 MTProto intercepts → Task 5
- §4.2.1 event shape → Task 7 + Task 10
- §4.2.2 fetch logic → Task 10 (FoldersSync.fetchRemote with bounded timeout in Task 11)
- §4.2.3 merge decision table → Task 9
- §4.2.4 re-seed after remote apply → Task 10 (`reseedSystemFolders` call) + Task 11 (method implementation)
- §4.2.5 publish + debounce → Task 10 (publish method) + Task 11 (debounced listener)
- §4.2.6 boot hook → Task 11
- §4.3 responsive no-op → no tasks needed
- §5 cleanup → Task 11 step 1
- §6 testing → Tasks 3, 4, 5, 7, 8, 9, 10, 12
- §7 migration (existing users) → Task 4 (preserveRename logic)
- §8 open question: protected rename + locale → addressed by langpack sentinel design in Task 3

**Placeholder scan:** no "TBD" / "TODO" / "implement later". Task 6 step 3 and Task 11 step 3 call out "verify actual API before committing" — these are informed checks, not placeholders (the plan supplies the contract and explicit grep commands to validate it).

**Type consistency:** `buildLocalFilter`, `FoldersSync`, `FolderSnapshot`, `decideMerge`, `setLastPublishedAt`, `isProtectedFolder` — used consistently across tasks. `queryLatestEvent` vs `queryEvents` in chatAPI — called out explicitly in Task 11 for verification.

**Scope check:** subsystem A (Tasks 1–6) and subsystem B (Tasks 7–12) each produce working, testable software. Subsystem A could ship alone as "default folders, no sync" if subsystem B is descoped.
