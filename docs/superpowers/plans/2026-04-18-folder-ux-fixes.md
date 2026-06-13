# Folder UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the default "people" folder from "Contacts" to "People", add a dedicated folder-icon picker button in the edit-folder view, and remove the folder-count limit + Premium upsell popup.

**Architecture:** Three independent fixes touching separate subsystems. (1) Storage: change one literal + extend a legacy-default list; the existing `prependFilters` → `preserveRename` → `isDefaultLocalTitle` pipeline performs the migration automatically. (2) UI: add a Solid sub-component inside `editFolderInput/` that renders a dedicated icon button and reuses the existing `EmoticonsDropdown`/`EmojiTab` pair, but writes the selected emoji to position 0 of the title (replacing an existing leading emoji if present). (3) Remove two call sites + one helper in `chatFolders.ts`.

**Tech Stack:** TypeScript 5.7, Solid.js (custom fork in `@vendor/solid`), Vitest for unit, pnpm + vite, existing `InputFieldEmoji` infrastructure.

---

## File Structure

**Modified:**
- `src/lib/storages/filtersLocal.ts` — change default title; extend legacy-default list.
- `src/components/sidebarLeft/tabs/editFolder.ts` — drop `hasFoldersSidebar` guard on tip caption.
- `src/components/sidebarLeft/tabs/editFolderInput/index.tsx` — add icon picker to the Solid component.
- `src/components/sidebarLeft/tabs/chatFolders.ts` — remove limit check + popup calls.
- `src/tests/nostra/filters-seed.test.ts` — update expected title; add legacy-default test.
- `src/tests/e2e/e2e-default-folders-sync.ts` — update expected title.

**New:**
- `src/components/sidebarLeft/tabs/editFolderInput/folderIconPicker.tsx` — Solid component for the dedicated icon button.
- `src/components/sidebarLeft/tabs/editFolderInput/folderIconPicker.module.scss` — styles for the button.

---

## Task 1: Update `buildLocalFilter` default title + unit test

**Files:**
- Modify: `src/lib/storages/filtersLocal.ts:44`
- Test: `src/tests/nostra/filters-seed.test.ts:44-47`

- [ ] **Step 1: Update the existing test expectation to the new literal**

Edit `src/tests/nostra/filters-seed.test.ts:44-47`:

```ts
  it('uses literal English titles for Persons and Groups', () => {
    expect(buildLocalFilter(FOLDER_ID_PERSONS).title.text).toBe('People');
    expect(buildLocalFilter(FOLDER_ID_GROUPS).title.text).toBe('Groups');
  });
```

- [ ] **Step 2: Run test to verify it fails**

```
pnpm exec vitest run src/tests/nostra/filters-seed.test.ts -t "uses literal English titles"
```

Expected: FAIL with `expected 'Contacts' to be 'People'`.

- [ ] **Step 3: Apply the literal change**

Edit `src/lib/storages/filtersLocal.ts:44`:

```ts
  } else if(id === FOLDER_ID_PERSONS) {
    filter.pFlags.contacts = true;
    filter.pFlags.non_contacts = true;
    filter.pFlags.exclude_archived = true;
    filter.title = literalTitle('People');
```

- [ ] **Step 4: Run test to verify it passes**

```
pnpm exec vitest run src/tests/nostra/filters-seed.test.ts -t "uses literal English titles"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storages/filtersLocal.ts src/tests/nostra/filters-seed.test.ts
git commit -m "refactor(folders): rename default persons folder 'Contacts' → 'People'"
```

---

## Task 2: Extend `isDefaultLocalTitle` to recognize legacy "Contacts" title

Why: existing users have `"Contacts"` persisted in IndexedDB under `FOLDER_ID_PERSONS`. The `preserveRename` helper in `src/lib/storages/filters.ts:118-128` checks `isDefaultLocalTitle(fresh.id, existingTitle)` — if `true`, the fresh default (now "People") is used; if `false`, the user's rename is preserved. By adding "Contacts" as a legacy-recognized default, existing users who never renamed the folder silently get "People" on next boot; users who renamed it (e.g. "Amici") keep their rename.

**Files:**
- Modify: `src/lib/storages/filtersLocal.ts:59-64`
- Test: `src/tests/nostra/filters-seed.test.ts:49-55` (update & extend)

- [ ] **Step 1: Write the new failing test cases**

Edit `src/tests/nostra/filters-seed.test.ts:49-55` to read:

```ts
  it('isDefaultLocalTitle recognizes fresh seeds, empty, and legacy LANGPACK', () => {
    expect(isDefaultLocalTitle(FOLDER_ID_PERSONS, 'People')).toBe(true);
    expect(isDefaultLocalTitle(FOLDER_ID_GROUPS, 'Groups')).toBe(true);
    expect(isDefaultLocalTitle(FOLDER_ID_PERSONS, '')).toBe(true);
    expect(isDefaultLocalTitle(FOLDER_ID_PERSONS, 'LANGPACK:FilterContacts')).toBe(true);
    expect(isDefaultLocalTitle(FOLDER_ID_PERSONS, 'Amici')).toBe(false);
  });

  it('isDefaultLocalTitle recognizes legacy "Contacts" title for FOLDER_ID_PERSONS as default', () => {
    // Legacy users shipped with 'Contacts' as the persons-folder title; we want the
    // migration path to overwrite that with the new default on next boot.
    expect(isDefaultLocalTitle(FOLDER_ID_PERSONS, 'Contacts')).toBe(true);
    // Other folders do not treat 'Contacts' as a default:
    expect(isDefaultLocalTitle(FOLDER_ID_GROUPS, 'Contacts')).toBe(false);
    // Other arbitrary legacy strings are not whitelisted:
    expect(isDefaultLocalTitle(FOLDER_ID_PERSONS, 'Chats')).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

```
pnpm exec vitest run src/tests/nostra/filters-seed.test.ts -t "legacy"
```

Expected: FAIL — the legacy-"Contacts" assertion returns `false` because `isDefaultLocalTitle` compares against the fresh default "People".

Also run:

```
pnpm exec vitest run src/tests/nostra/filters-seed.test.ts -t "recognizes fresh seeds"
```

Expected: FAIL on `isDefaultLocalTitle(FOLDER_ID_PERSONS, 'People') === true` vs whatever previously shipped.

- [ ] **Step 3: Extend `isDefaultLocalTitle` to consult a legacy-defaults table**

Edit `src/lib/storages/filtersLocal.ts:54-64`:

```ts
/**
 * Titles that were previously shipped as defaults for a given folder id and
 * must still be recognized as defaults during migration. Keep this list
 * small — only strings that were the ACTUAL default at some prior release.
 */
const LEGACY_DEFAULT_TITLES: Record<number, readonly string[]> = {
  [FOLDER_ID_PERSONS]: ['Contacts']
};

/**
 * Returns true for titles produced by buildLocalFilter (unchanged default
 * label) or legacy persisted langpack sentinels. Used by sync snapshot code
 * to avoid recording default titles as user renames.
 */
export function isDefaultLocalTitle(id: number, text: string): boolean {
  if(!text) return true;
  if(text.startsWith('LANGPACK:')) return true; // legacy migration
  const fresh = buildLocalFilter(id).title?.text ?? '';
  if(text === fresh) return true;
  if(LEGACY_DEFAULT_TITLES[id]?.includes(text)) return true;
  return false;
}
```

- [ ] **Step 4: Run tests to verify all pass**

```
pnpm exec vitest run src/tests/nostra/filters-seed.test.ts
```

Expected: all tests in the file PASS (including the new "legacy Contacts" test and the updated "fresh seeds" test).

- [ ] **Step 5: Run the quick P2P test battery to ensure no regression**

```
pnpm test:nostra:quick
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/storages/filtersLocal.ts src/tests/nostra/filters-seed.test.ts
git commit -m "feat(folders): migrate existing 'Contacts' folder title to 'People'

Existing users have the persons-folder title persisted as 'Contacts' in
IndexedDB. Extend isDefaultLocalTitle to whitelist the legacy value, so
the existing prependFilters→preserveRename pipeline overwrites it with
the new 'People' default on next boot. User-renamed folders are not
affected."
```

---

## Task 3: Update E2E default-folders-sync expectations

**Files:**
- Modify: `src/tests/e2e/e2e-default-folders-sync.ts:138-139`

- [ ] **Step 1: Edit the E2E expectation**

Edit `src/tests/e2e/e2e-default-folders-sync.ts:138-139`:

```ts
    if(personsA?.title !== 'People') {
      throw new Error(`A: Persons expected title "People" — got "${personsA?.title}"`);
    }
```

Search the rest of the file for any other `'Contacts'` literal that refers to the persons-folder title and update the same way. If a reference is part of a "rename preserved" scenario, leave it as-is (custom user rename, not the default).

- [ ] **Step 2: Run the E2E file locally if Playwright is available**

If playwright is wired up:

```
pnpm exec tsx src/tests/e2e/e2e-default-folders-sync.ts
```

If not runnable locally (requires full browser env), verify by re-reading the file: expectations reference `'People'` for the default; a custom user rename scenario (if present) references its custom value.

- [ ] **Step 3: Commit**

```bash
git add src/tests/e2e/e2e-default-folders-sync.ts
git commit -m "test(e2e): update default folders expectation 'Contacts' → 'People'"
```

---

## Task 4: Always show `EditFolder.EmojiAsIconTip` caption

**Files:**
- Modify: `src/components/sidebarLeft/tabs/editFolder.ts:156-159`

- [ ] **Step 1: Drop the `hasFoldersSidebar` guard**

Edit `src/components/sidebarLeft/tabs/editFolder.ts:156-159`:

```ts
    const inputSection = new SettingSection({
      caption: 'EditFolder.EmojiAsIconTip'
    });
```

Remove the now-unused `const hasFoldersSidebar = rootScope.settings.tabsInSidebar;` line immediately above the section if `hasFoldersSidebar` is not used elsewhere in the file. Verify via:

```
Grep hasFoldersSidebar in src/components/sidebarLeft/tabs/editFolder.ts
```

If no other references remain, delete that line.

- [ ] **Step 2: Lint the changed file**

```
pnpm exec eslint src/components/sidebarLeft/tabs/editFolder.ts
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebarLeft/tabs/editFolder.ts
git commit -m "fix(folders): always show EmojiAsIcon tip in edit-folder view

Previously guarded behind tabsInSidebar setting, so top-bar users had
no indication that a leading emoji becomes the folder icon."
```

---

## Task 5: Create `FolderIconPicker` Solid component

Design: a button rendered BEFORE the name input. On click, opens an `EmoticonsDropdown` (emoji tab only). On select, prepends/replaces the leading emoji of the folder title and triggers `onRawInput`.

**Files:**
- Create: `src/components/sidebarLeft/tabs/editFolderInput/folderIconPicker.tsx`
- Create: `src/components/sidebarLeft/tabs/editFolderInput/folderIconPicker.module.scss`

- [ ] **Step 1: Write the pure helper that mutates a title string**

Create `src/components/sidebarLeft/tabs/editFolderInput/titleIconOps.ts`:

```ts
// Pure helpers for prepending/replacing the leading emoji of a folder title.

const EMOJI_RE = /^(\p{Extended_Pictographic}\uFE0F?|\p{Regional_Indicator}{2})/u;

export function extractLeadingEmoji(title: string): string | null {
  if(!title) return null;
  const m = title.match(EMOJI_RE);
  return m ? m[0] : null;
}

export function setLeadingEmoji(title: string, emoji: string, maxLen: number): string {
  const current = extractLeadingEmoji(title);
  let rest: string;
  if(current) {
    rest = title.slice(current.length).replace(/^\s+/, '');
  } else {
    rest = title;
  }
  const separator = rest.length ? ' ' : '';
  const combined = emoji + separator + rest;
  if(combined.length <= maxLen) return combined;
  // Truncate the text tail; the emoji wins.
  const budget = maxLen - emoji.length - separator.length;
  if(budget <= 0) return emoji;
  return emoji + separator + rest.slice(0, budget);
}
```

- [ ] **Step 2: Write the failing unit test for the helper**

Create `src/tests/nostra/title-icon-ops.test.ts`:

```ts
import {describe, it, expect} from 'vitest';
import {
  extractLeadingEmoji,
  setLeadingEmoji
} from '@components/sidebarLeft/tabs/editFolderInput/titleIconOps';

const MAX = 12;

describe('extractLeadingEmoji', () => {
  it('returns null for empty', () => {
    expect(extractLeadingEmoji('')).toBe(null);
  });

  it('returns null for pure text', () => {
    expect(extractLeadingEmoji('Work')).toBe(null);
  });

  it('returns the leading emoji', () => {
    expect(extractLeadingEmoji('🎯 Work')).toBe('🎯');
  });

  it('returns null when emoji is not at start', () => {
    expect(extractLeadingEmoji('Work 🎯')).toBe(null);
  });
});

describe('setLeadingEmoji', () => {
  it('prepends emoji + space to plain text', () => {
    expect(setLeadingEmoji('Work', '🎯', MAX)).toBe('🎯 Work');
  });

  it('replaces existing leading emoji', () => {
    expect(setLeadingEmoji('🐸 Work', '🎯', MAX)).toBe('🎯 Work');
  });

  it('replaces existing leading emoji with following space', () => {
    expect(setLeadingEmoji('🐸  Work', '🎯', MAX)).toBe('🎯 Work');
  });

  it('uses only the emoji when title is empty', () => {
    expect(setLeadingEmoji('', '🎯', MAX)).toBe('🎯');
  });

  it('truncates tail text to respect the max length cap', () => {
    // emoji (surrogate pair length 2) + ' ' + tail, capped at 12
    const out = setLeadingEmoji('abcdefghijkl', '🎯', MAX);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out.startsWith('🎯 ')).toBe(true);
  });

  it('returns only the emoji when budget forbids any tail', () => {
    // emoji alone is length 2, max is 2 → no space, no tail
    const out = setLeadingEmoji('Work', '🎯', 2);
    expect(out).toBe('🎯');
  });
});
```

- [ ] **Step 3: Run helper tests**

```
pnpm exec vitest run src/tests/nostra/title-icon-ops.test.ts
```

Expected: PASS (helper already implemented in Step 1; if any test fails, fix the helper or the test until aligned).

- [ ] **Step 4: Commit the helper**

```bash
git add src/components/sidebarLeft/tabs/editFolderInput/titleIconOps.ts src/tests/nostra/title-icon-ops.test.ts
git commit -m "feat(folders): add pure helpers for leading-emoji title ops"
```

- [ ] **Step 5: Create the styles file**

Create `src/components/sidebarLeft/tabs/editFolderInput/folderIconPicker.module.scss`:

```scss
.FolderIconPicker {
  --size: 28px;
  width: var(--size);
  height: var(--size);
  margin-inline-end: 8px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex: 0 0 auto;
  user-select: none;
  background-color: var(--light-secondary-text-color);
  color: var(--primary-text-color);
  font-size: 18px;
  line-height: 1;
  transition: background-color .15s ease;

  &:hover {
    background-color: var(--secondary-text-color);
  }
}

.FolderIconPickerWrapper {
  display: flex;
  align-items: center;
}

.Dropdown {
  z-index: 6;
}
```

- [ ] **Step 6: Create the Solid picker component**

Create `src/components/sidebarLeft/tabs/editFolderInput/folderIconPicker.tsx`:

```tsx
import {createMemo, onCleanup, Show} from 'solid-js';
import rootScope from '@lib/rootScope';
import cloneDOMRect from '@helpers/dom/cloneDOMRect';
import {EmoticonsDropdown} from '@components/emoticonsDropdown';
import EmojiTab from '@components/emoticonsDropdown/tabs/emoji';
import {extractLeadingEmoji, setLeadingEmoji} from './titleIconOps';
import styles from './folderIconPicker.module.scss';

export const MAX_FOLDER_NAME_LENGTH = 12;

type Props = {
  getTitle: () => string;
  setTitle: (value: string) => void;
};

export default function FolderIconPicker(props: Props) {
  // The preview tracks the live leading emoji of the title signal. No local
  // state: the parent-owned title signal is the single source of truth.
  const getCurrent = createMemo(() => extractLeadingEmoji(props.getTitle()));

  let buttonRef: HTMLDivElement;
  let dropdown: EmoticonsDropdown | undefined;

  const openDropdown = () => {
    if(dropdown) return;

    const emojiTab = new EmojiTab({
      managers: rootScope.managers,
      additionalStickerViewerClass: styles.Dropdown,
      noPacks: !rootScope.premium,
      noSearchGroups: !rootScope.premium,
      onClick: (emoji) => {
        if(emoji.docId) return; // custom emoji: not supported as folder icon
        const title = props.getTitle();
        const next = setLeadingEmoji(title, emoji.emoji, MAX_FOLDER_NAME_LENGTH);
        props.setTitle(next);
        dropdown?.hideAndDestroy();
      }
    });

    dropdown = new EmoticonsDropdown({
      tabsToRender: [emojiTab],
      customParentElement: document.body,
      getOpenPosition: () => {
        const rect = buttonRef.getBoundingClientRect();
        const cloned = cloneDOMRect(rect);
        cloned.left = rect.left + rect.width / 2;
        cloned.top = rect.top + rect.height / 2;
        return cloned;
      }
    });

    dropdown.getElement()?.classList.add(styles.Dropdown);
    dropdown.setTextColor('primary-text-color');
    dropdown.addEventListener('closed', () => {
      dropdown?.hideAndDestroy();
      dropdown = undefined;
    });
    dropdown.onButtonClick();
  };

  onCleanup(() => {
    dropdown?.hideAndDestroy();
  });

  return (
    <div
      ref={(el) => (buttonRef = el)}
      class={styles.FolderIconPicker}
      onClick={openDropdown}
      title="Choose folder icon"
      role="button"
      tabIndex={0}
    >
      <Show when={getCurrent()} fallback={<span>🙂</span>}>
        <span>{getCurrent()}</span>
      </Show>
    </div>
  );
}
```

- [ ] **Step 7: Lint the new files**

```
pnpm exec eslint src/components/sidebarLeft/tabs/editFolderInput/folderIconPicker.tsx src/components/sidebarLeft/tabs/editFolderInput/titleIconOps.ts
```

Expected: no errors.

- [ ] **Step 8: Commit the component**

```bash
git add src/components/sidebarLeft/tabs/editFolderInput/folderIconPicker.tsx src/components/sidebarLeft/tabs/editFolderInput/folderIconPicker.module.scss
git commit -m "feat(folders): add FolderIconPicker Solid component"
```

---

## Task 6: Wire `FolderIconPicker` into `EditFolderInput`

**Files:**
- Modify: `src/components/sidebarLeft/tabs/editFolderInput/index.tsx`

- [ ] **Step 1: Replace the body of `EditFolderInput` with a wrapper that renders the picker + input**

Full replacement for `src/components/sidebarLeft/tabs/editFolderInput/index.tsx`:

```tsx
import {createSignal, onCleanup} from 'solid-js';
import {TextWithEntities} from '@layer';
import wrapEmojiText from '@lib/richTextProcessor/wrapEmojiText';
import defineSolidElement, {PassedProps} from '@lib/solidjs/defineSolidElement';
import {InputFieldEmoji} from '@components/inputFieldEmoji';
import {InputFieldTsx} from '@components/inputFieldTsx';
import FolderIconPicker, {MAX_FOLDER_NAME_LENGTH} from './folderIconPicker';

if(import.meta.hot) import.meta.hot.accept();

type Props = {
  value?: TextWithEntities.textWithEntities;
  onInput: (value: string) => void;
};

type Controls = {
  inputField: InputFieldEmoji;
};

// Pushes a plain-text title into the contenteditable input of an InputFieldEmoji,
// rewrapping emoji glyphs and triggering an input event so downstream listeners
// (editCheckForChange, onRawInput) see the change.
function writeTitleToInputField(input: InputFieldEmoji | undefined, next: string) {
  if(!input?.input) return;
  const wrapped = wrapEmojiText(next, false, []);
  input.input.replaceChildren();
  input.input.append(wrapped);
  input.input.dispatchEvent(new Event('input', {bubbles: true}));
}

const EditFolderInput = defineSolidElement({
  name: 'edit-folder-input',
  component: (props: PassedProps<Props>, _, controls: Controls) => {
    const [getTitle, setTitle] = createSignal<string>(props.value?.text ?? '');

    onCleanup(() => {
      controls.inputField?.cleanup();
    });

    // Keep the Solid signal in sync when the user types directly into the input.
    const handleRawInput = (value: string) => {
      setTitle(value);
      props.onInput(value);
    };

    return (
      <div style="display:flex;align-items:center;gap:8px">
        <FolderIconPicker
          getTitle={getTitle}
          setTitle={(next) => {
            setTitle(next);
            writeTitleToInputField(controls.inputField, next);
          }}
        />
        <InputFieldTsx
          InputFieldClass={InputFieldEmoji}
          instanceRef={(value) => void (controls.inputField = value)}
          label='FilterNameHint'
          maxLength={MAX_FOLDER_NAME_LENGTH}
          value={props.value ? wrapEmojiText(props.value.text, true, props.value.entities) : ''}
          onRawInput={handleRawInput}
        />
      </div>
    );
  }
});

export default EditFolderInput;
```

- [ ] **Step 2: Lint**

```
pnpm exec eslint src/components/sidebarLeft/tabs/editFolderInput/index.tsx
```

Expected: no errors.

- [ ] **Step 3: Type-check**

```
pnpm exec tsc --noEmit
```

Expected: no new type errors in the touched paths. If `InputFieldTsx`/`InputFieldEmoji` rejects the `onRawInput` signature, inspect `@components/inputFieldTsx` for the correct prop name and adjust.

- [ ] **Step 4: Manual test in dev server**

```
pnpm start
```

In the browser:
1. Open Settings → Chat Folders → tap "+ Create Folder" (or edit an existing folder).
2. Verify the round icon-picker button appears LEFT of the folder-name input, showing 🙂 initially (or the current leading emoji if present).
3. Click the button → an emoji dropdown opens.
4. Select a face emoji → the emoji appears at the start of the folder name input, and the preview inside the button updates to that emoji.
5. Select a different emoji → replaces the leading one (no duplicates).
6. Type "Work" in the input → the icon remains untouched.
7. Delete the leading emoji manually → the button preview falls back to 🙂.
8. Verify the EmojiAsIcon tip text is visible below the input, always (regardless of tabsInSidebar).

Record any regressions in `docs/CHECKLIST_v2.md` style short notes and fix before commit.

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebarLeft/tabs/editFolderInput/index.tsx
git commit -m "feat(folders): wire FolderIconPicker into edit-folder name input"
```

---

## Task 7: Remove folder-count limit + Premium upsell from Chat Folders settings

**Files:**
- Modify: `src/components/sidebarLeft/tabs/chatFolders.ts:28,243-249,374-382,397-400`

- [ ] **Step 1: Inline the short-circuit at the "Create Folder" button**

Edit `src/components/sidebarLeft/tabs/chatFolders.ts:243-249`:

```ts
    attachClickEvent(this.createFolderBtn, () => {
      this.slider.createTab(AppEditFolderTab).open();
    }, {listenerSetter: this.listenerSetter});
```

- [ ] **Step 2: Remove the limit check from the suggested-folder "Add" path**

Edit `src/components/sidebarLeft/tabs/chatFolders.ts:394-402` (the inner click handler of the `button` row). Replace:

```ts
        attachClickEvent(button, async(e) => {
          cancelEvent(e);

          if(!(await this.canCreateFolder())) {
            showLimitPopup('folders');
            return;
          }

          button.setAttribute('disabled', 'true');
```

with:

```ts
        attachClickEvent(button, async(e) => {
          cancelEvent(e);

          button.setAttribute('disabled', 'true');
```

- [ ] **Step 3: Delete the `canCreateFolder` helper**

Edit `src/components/sidebarLeft/tabs/chatFolders.ts:374-382`. Remove the entire method:

```ts
  private async canCreateFolder() {
    const [limit, filters] = await Promise.all([
      this.managers.apiManager.getLimit('folders'),
      this.managers.filtersStorage.getDialogFilters()
    ]);

    const filtersLength = filters.filter((filter) => !REAL_FOLDERS.has(filter.id)).length;
    return filtersLength < limit;
  }
```

- [ ] **Step 4: Remove the now-unused import**

Edit `src/components/sidebarLeft/tabs/chatFolders.ts:28` — delete the line:

```ts
import showLimitPopup from '@components/popups/limit';
```

Re-verify no other references remain in the file:

```
Grep showLimitPopup in src/components/sidebarLeft/tabs/chatFolders.ts
```

Expected: no matches.

- [ ] **Step 5: Lint**

```
pnpm exec eslint src/components/sidebarLeft/tabs/chatFolders.ts
```

Expected: no errors (in particular, no "unused import" warnings).

- [ ] **Step 6: Type-check**

```
pnpm exec tsc --noEmit
```

Expected: no new errors.

- [ ] **Step 7: Manual verification in dev server**

```
pnpm start
```

In the browser:
1. Go to Settings → Chat Folders.
2. Click "Create Folder" repeatedly — create 11+ folders.
3. Verify no `LimitReached` popup appears at any count.
4. Verify no Premium upsell popup appears.
5. Verify the folder list renders all folders (scroll as needed).

- [ ] **Step 8: Commit**

```bash
git add src/components/sidebarLeft/tabs/chatFolders.ts
git commit -m "fix(folders): remove folder-count limit and Premium upsell

Nostra has no Premium tier; the Telegram-inherited 'IncreaseLimit' CTA
pointing at PopupPremium.show is never applicable. Drop the check + popup
at both create paths (fresh create button and 'Add' on a suggested folder)."
```

---

## Task 8: Full verification pass

- [ ] **Step 1: Full lint**

```
pnpm lint
```

Expected: PASS.

- [ ] **Step 2: Full type-check**

```
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 3: Quick P2P test battery**

```
pnpm test:nostra:quick
```

Expected: PASS.

- [ ] **Step 4: Full Vitest**

```
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Dev-server smoke**

```
pnpm start
```

1. Open the app, complete onboarding if required.
2. Confirm the left-hand folders list / top-bar shows the default persons folder titled **People** (not Contacts).
3. Rename it to "Amici" → reload → stays "Amici" (user rename preserved).
4. Reset local data → reload onboarding → default again shows **People**.
5. Open edit folder → verify icon picker button appears, works (see Task 6 Step 4).
6. Create >10 folders — no Premium popup.

- [ ] **Step 6: Final status check + PR**

Only if the user requests a PR:

```bash
git status
git log --oneline -10
```

Branch may be pushed and PR opened via `gh pr create` with a Conventional title, e.g. `fix(folders): rename default folder, add icon picker, drop premium limit`. Body references `docs/superpowers/specs/2026-04-18-folder-ux-fixes-design.md` and lists the 7 feature commits.

---

## Spec-coverage check

| Spec section | Implemented by |
|---|---|
| Rename default FOLDER_ID_PERSONS "Contacts"→"People" | Task 1 |
| Migration for existing users | Task 2 (extended `isDefaultLocalTitle` drives existing `preserveRename`) |
| Unit test for legacy default detection | Task 2 |
| E2E test update | Task 3 |
| Always-show EmojiAsIcon tip | Task 4 |
| Dedicated emoji/icon picker button | Tasks 5 + 6 |
| Picker: prepend/replace leading emoji | Task 5 (`setLeadingEmoji`) |
| MAX_FOLDER_NAME_LENGTH cap on prepend | Task 5 + unit test |
| Remove folder-count limit | Task 7 |
| Remove Premium upsell at create-folder | Task 7 |
| `popups/limit.ts` untouched | Task 7 (only call-site removed) |
| `editFolder.ts` folderPeers limit untouched | Task 7 (only `chatFolders.ts` changed) |
