# Reset Local Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Reset Local Data" menu entry next to Logout in settings that wipes every local byte of Nostra + tweb state except the user's seed, so the account boots as a freshly re-imported identity.

**Architecture:** Refactor `nostra-cleanup.ts` to parameterise a skip-list and expose a sibling `clearAllExceptSeed()`. Add a `keepNostraIdentity` flag to `apiManager.logOut()` so the Worker-side `deleteEncryptedIdentity()` call is skipped. New `resetLocalData.ts` popup orchestrates: confirmation → Nostra wipe → tweb wipe via flagged logOut → sessionStorage marker → safety reload. On boot, a `maybeShowResetToast()` helper called from `src/index.ts` surfaces a confirmation toast.

**Tech Stack:** TypeScript, Solid.js (popups/toast/menu are imperative DOM), IndexedDB, localStorage, sessionStorage.

**Spec:** `docs/superpowers/specs/2026-04-15-reset-local-data-design.md`

---

## File Structure

| File | Role | Change |
|---|---|---|
| `src/lib/nostra/nostra-cleanup.ts` | Nostra wipe helpers | Refactor to share logic + add `clearAllExceptSeed()` |
| `src/lib/appManagers/apiManager.ts` | tweb auth/logout orchestrator | Add `opts.keepNostraIdentity` to `logOut()` |
| `src/components/popups/resetLocalData.ts` | Reset popup + boot toast hook | **NEW** |
| `src/components/sidebarLeft/tabs/settings.ts` | Settings tab with menu toggle | Add second menu entry |
| `src/index.ts` | App boot | Call `maybeShowResetToast()` after `mountNostraOnboarding` |

---

## Task 1: Refactor `nostra-cleanup.ts` and add `clearAllExceptSeed`

**Files:**
- Modify: `src/lib/nostra/nostra-cleanup.ts`

**Rationale:** Current `clearAllNostraData()` has the DB list hardcoded. We share the logic via an internal function that takes a `keepSeed` flag and filters out the identity DB (`Nostra.chat`) + the identity LS key (`nostra_identity`) when true. The existing `clearAllNostraData()` public API is preserved so `logOut.ts` stays untouched.

- [ ] **Step 1: Edit `src/lib/nostra/nostra-cleanup.ts`**

Replace the entire file contents with:

```ts
/**
 * Centralized cleanup of all Nostra data.
 * Runs in the main thread where DB connections are held.
 *
 * Two modes:
 *   clearAllNostraData()  — full wipe (logout)
 *   clearAllExceptSeed()  — wipe everything EXCEPT the encrypted identity
 *                           (`Nostra.chat` IndexedDB + `nostra_identity` LS key)
 */

// All Nostra IndexedDB database names
const NOSTRA_DB_NAMES = [
  'nostra-messages',
  'nostra-message-requests',
  'nostra-virtual-peers',
  'nostra-groups',
  'NostraPool',
  'Nostra.chat'
];

// All Nostra localStorage keys
const NOSTRA_LS_KEYS = [
  'nostra_identity',
  'nostra-relay-config',
  'nostra-last-seen-timestamp',
  'nostra:read-receipts-enabled',
  'nostra-folders-last-published',
  'nostra-folders-last-modified',
  'nostra-profile-cache'
];

// The seed lives here — kept by `clearAllExceptSeed()`
const SEED_DB_NAME = 'Nostra.chat';
const SEED_LS_KEY = 'nostra_identity';

/**
 * Force-close all open connections to a database by triggering a version upgrade.
 * When we open with a higher version, the browser sends `versionchange` to all
 * existing connections. We hook `onversionchange` on our own connection to close it,
 * and other well-behaved connections will close too. Connections that don't handle
 * `versionchange` will be force-closed by the browser when we abort the upgrade.
 */
function forceCloseDB(name: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(name, 999999);
      req.onupgradeneeded = () => {
        req.transaction.abort();
      };
      req.onsuccess = () => {
        try { req.result.close(); } catch{}
        resolve();
      };
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    } catch{
      resolve();
    }
  });
}

function deleteDB(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve(true);
      req.onerror = () => resolve(false);
      req.onblocked = () => resolve(false);
    } catch{
      resolve(false);
    }
  });
}

async function clearNostraData(opts: {keepSeed: boolean}): Promise<string[]> {
  const dbNames = opts.keepSeed
    ? NOSTRA_DB_NAMES.filter((n) => n !== SEED_DB_NAME)
    : NOSTRA_DB_NAMES;
  const lsKeys = opts.keepSeed
    ? NOSTRA_LS_KEYS.filter((k) => k !== SEED_LS_KEY)
    : NOSTRA_LS_KEYS;

  // 1. Close open DB connections held by singletons (none of these touch Nostra.chat)
  const closes: Promise<void>[] = [];
  try {
    const {getMessageStore} = await import('./message-store');
    closes.push(getMessageStore().destroy());
  } catch{}
  try {
    const {getMessageRequestStore} = await import('./message-requests');
    closes.push(getMessageRequestStore().destroy());
  } catch{}
  try {
    const {getVirtualPeersDB} = await import('./virtual-peers-db');
    closes.push(getVirtualPeersDB().destroy());
  } catch{}
  try {
    const {getGroupStore} = await import('./group-store');
    closes.push(getGroupStore().destroy());
  } catch{}
  await Promise.allSettled(closes);

  // 2. Force-close any remaining connections
  await Promise.allSettled(dbNames.map((name) => forceCloseDB(name)));

  // 3. Delete databases
  const results = await Promise.all(
    dbNames.map(async(name) => ({name, ok: await deleteDB(name)}))
  );
  const failed = results.filter((r) => !r.ok).map((r) => r.name);

  // 4. Clear localStorage keys
  for(const key of lsKeys) {
    try {
      localStorage.removeItem(key);
    } catch{}
  }

  return failed;
}

/**
 * Close all open Nostra DB connections, delete all databases, clear localStorage.
 * Returns list of database names that failed to delete.
 */
export function clearAllNostraData(): Promise<string[]> {
  return clearNostraData({keepSeed: false});
}

/**
 * Same as `clearAllNostraData()` but preserves the encrypted identity:
 * keeps the `Nostra.chat` IndexedDB database and the `nostra_identity`
 * localStorage key. Used by the "Reset Local Data" flow so the user can
 * re-enter the app with the same seed.
 */
export function clearAllExceptSeed(): Promise<string[]> {
  return clearNostraData({keepSeed: true});
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep -E "nostra-cleanup|error TS" | head -20`
Expected: no new errors in `nostra-cleanup.ts` (pre-existing unrelated errors from `@vendor/emoji`, `@vendor/bezierEasing` are fine per `CLAUDE.md`).

- [ ] **Step 3: Sanity-check existing logout path still compiles**

Run: `npx tsc --noEmit src/components/popups/logOut.ts 2>&1 | tail -5`
Expected: no errors about the missing old export shape — `clearAllNostraData` is still exported.

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/nostra-cleanup.ts
git commit -m "refactor(nostra): parameterise cleanup for keep-seed variant

Extract clearNostraData() helper taking a keepSeed flag. Existing
clearAllNostraData() now delegates to it. Adds clearAllExceptSeed()
that preserves the Nostra.chat IndexedDB + nostra_identity LS key —
consumed by the upcoming Reset Local Data flow."
```

---

## Task 2: Add `keepNostraIdentity` flag to `apiManager.logOut()`

**Files:**
- Modify: `src/lib/appManagers/apiManager.ts:278-364`

**Rationale:** The logout clear block wipes all tweb storage and then calls `deleteEncryptedIdentity()` on the Worker side. For "reset except seed" we want every other step but must skip the identity wipe. Surgical change: add an opts bag, guard only the identity-wipe call.

- [ ] **Step 1: Update the signature**

Edit line 278:

```ts
  public async logOut(
    migrateAccountTo?: ActiveAccountNumber,
    opts?: {keepNostraIdentity?: boolean}
  ) {
```

- [ ] **Step 2: Guard the identity wipe**

Replace lines 343–349:

```ts
      // [Nostra.chat] Clear Nostr identity key in Worker context
      try {
        const {deleteEncryptedIdentity} = await import('../nostra/key-storage');
        await deleteEncryptedIdentity();
      } catch(err) {
        console.warn('[Nostra.chat] failed to clear identity on logout:', err);
      }
```

with:

```ts
      // [Nostra.chat] Clear Nostr identity key in Worker context (skipped by Reset Local Data)
      if(!opts?.keepNostraIdentity) {
        try {
          const {deleteEncryptedIdentity} = await import('../nostra/key-storage');
          await deleteEncryptedIdentity();
        } catch(err) {
          console.warn('[Nostra.chat] failed to clear identity on logout:', err);
        }
      }
```

- [ ] **Step 3: Verify no other caller needs updating**

Run: `grep -rn "apiManager.logOut\|managers.apiManager.logOut" src/ --include="*.ts" | grep -v "test"`
Expected: all existing call sites pass zero or one argument (`migrateAccountTo`). None pass a second. The new parameter is optional — existing callers unchanged.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep -E "apiManager\.ts|error TS" | head -20`
Expected: no new errors in `apiManager.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/appManagers/apiManager.ts
git commit -m "feat(auth): add keepNostraIdentity flag to logOut()

Optional second arg on apiManager.logOut() guards the
deleteEncryptedIdentity() call so the Reset Local Data flow can
reuse the full tweb cleanup path while preserving the seed."
```

---

## Task 3: Create `resetLocalData.ts` popup + boot toast helper

**Files:**
- Create: `src/components/popups/resetLocalData.ts`

**Rationale:** Sibling of `logOut.ts`. Confirmation popup uses `confirmationPopup` from `@components/confirmationPopup`, passing plain `title` / `descriptionRaw` strings (supported by `PopupPeerOptions` — see `src/components/popups/peer.ts:25,30`) and a button with a `Text` node for the label (since `PopupButton.text` expects a Node, not a string — see `src/components/popups/index.ts:32`). Sets a `sessionStorage` flag before reload; exports `maybeShowResetToast()` consumed at boot.

- [ ] **Step 1: Create the file**

Write `src/components/popups/resetLocalData.ts`:

```ts
import rootScope from '@lib/rootScope';
import confirmationPopup from '@components/confirmationPopup';
import {toast} from '@components/toast';

const RESET_FLAG_KEY = 'nostra-just-reset';

function createOverlay(text: string): HTMLDivElement {
  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9999',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:rgba(0,0,0,0.7)', 'color:#fff', 'font-size:1.25rem',
    'font-family:inherit', 'backdrop-filter:blur(8px)'
  ].join(';');
  overlay.textContent = text;
  document.body.appendChild(overlay);
  return overlay;
}

export default function showResetLocalDataPopup() {
  confirmationPopup({
    title: 'Reset Local Data',
    descriptionRaw: 'This will delete all messages, contacts, relays, and settings. Your seed will be kept — if you set a passphrase, you\'ll be asked for it on restart. Continue?',
    button: {
      text: document.createTextNode('Reset'),
      isDanger: true
    }
  }).then(async() => {
    const overlay = createOverlay('Resetting…');

    // 1. Wipe Nostra data (keeping the seed)
    let failed: string[] = [];
    try {
      const {clearAllExceptSeed} = await import('@lib/nostra/nostra-cleanup');
      failed = await clearAllExceptSeed();
    } catch(err) {
      console.warn('[Nostra.chat] reset error:', err);
      failed = ['unknown'];
    }

    if(failed.length > 0) {
      console.warn('[Nostra.chat] failed to delete:', failed.join(', '));
      overlay.textContent = 'Reset incomplete — reloading…';
    } else {
      overlay.textContent = 'Local data reset — reloading…';
    }

    // 2. Set marker so boot shows a confirmation toast
    try {
      sessionStorage.setItem(RESET_FLAG_KEY, '1');
    } catch{}

    // 3. Standard tweb logout path, but keep the Nostra seed
    rootScope.managers.apiManager.logOut(undefined, {keepNostraIdentity: true});

    // 4. Safety reload if the normal flow doesn't fire
    setTimeout(() => {
      location.href = location.origin;
    }, 4000);
  }).catch(() => {
    // User canceled — no-op
  });
}

/**
 * Called once at boot. If the previous page triggered a Reset Local Data,
 * shows a confirmation toast and clears the marker.
 */
export function maybeShowResetToast(): void {
  try {
    if(sessionStorage.getItem(RESET_FLAG_KEY) === '1') {
      sessionStorage.removeItem(RESET_FLAG_KEY);
      toast('Local data reset');
    }
  } catch{}
}
```

- [ ] **Step 2: Type-check the new file**

Run: `npx tsc --noEmit 2>&1 | grep -E "resetLocalData|error TS" | head -20`
Expected: no errors in `resetLocalData.ts`.

If a type error surfaces on `title: 'Reset Local Data'` or `descriptionRaw: '…'`, double-check `src/components/popups/peer.ts:25,30` — those fields are `string`. If `confirmationPopup`'s generic requires a cast, wrap the options object literal with `as const` or add an explicit type annotation, but prefer leaving it as-is since the types should match.

- [ ] **Step 3: Commit**

```bash
git add src/components/popups/resetLocalData.ts
git commit -m "feat(popups): add Reset Local Data popup

Confirmation popup + overlay + post-reload toast helper. Wipes all
Nostra data via clearAllExceptSeed() and runs tweb logOut with the
keepNostraIdentity flag so the encrypted seed survives the reload."
```

---

## Task 4: Wire the Reset entry into the settings menu

**Files:**
- Modify: `src/components/sidebarLeft/tabs/settings.ts:15,29-39`

- [ ] **Step 1: Add the import**

Edit line 15 area, add below the existing `showLogOutPopup` import:

```ts
import showLogOutPopup from '@components/popups/logOut';
import showResetLocalDataPopup from '@components/popups/resetLocalData';
```

- [ ] **Step 2: Add the menu entry above Logout**

Replace lines 29–39:

```ts
    const btnMenu = ButtonMenuToggle({
      listenerSetter: this.listenerSetter,
      direction: 'bottom-left',
      buttons: [{
        icon: 'logout',
        text: 'EditAccount.Logout',
        onClick: () => {
          showLogOutPopup();
        }
      }]
    });
```

with:

```ts
    const btnMenu = ButtonMenuToggle({
      listenerSetter: this.listenerSetter,
      direction: 'bottom-left',
      buttons: [{
        icon: 'delete',
        regularText: 'Reset Local Data' as any,
        onClick: () => {
          showResetLocalDataPopup();
        }
      }, {
        icon: 'logout',
        text: 'EditAccount.Logout',
        onClick: () => {
          showLogOutPopup();
        }
      }]
    });
```

**Note on `regularText`**: `ButtonMenuToggle` buttons use `text` for a `LangPackKey`. To pass an inline English string, `ButtonMenuItemOptions` exposes `regularText: string` (used elsewhere in the codebase — e.g. context menus). If TypeScript complains, fall back to using a proper lang key: add `'Nostra.ResetLocalData'` to `src/lang.ts` and use `text: 'Nostra.ResetLocalData'` instead. Verify in Step 4.

- [ ] **Step 3: Confirm `regularText` is the correct field**

Run: `grep -n "regularText\|interface ButtonMenuItemOptions\|type ButtonMenuItemOptions" src/components/buttonMenu.ts`
Expected: shows a `regularText?: string` field in the options type. If absent, check `src/components/buttonMenuToggle.ts` as well. If neither supports a plain string:
  1. Open `src/lang.ts` and add a new key — find the alphabetical neighborhood of existing Nostra keys (grep for `'Nostra.`) and insert `'Nostra.ResetLocalData': 'Reset Local Data',` following the surrounding comma conventions.
  2. Change the button to `text: 'Nostra.ResetLocalData' as LangPackKey` (import `LangPackKey` from `@lib/langPack` if not already in scope).
  3. Re-run the type check.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep -E "settings\.ts|error TS" | head -20`
Expected: no errors in `settings.ts`. If `regularText` path fails, apply the `lang.ts` fallback from Step 3.

- [ ] **Step 5: Visual smoke test**

Run: `pnpm start` (background), open `http://localhost:8080/?debug=1` in a browser already onboarded with a Nostra identity, navigate to Settings, click the hamburger menu in the header.
Expected: menu shows two entries — **Reset Local Data** (delete icon) on top, **Logout** (logout icon) below. Click Reset Local Data → confirmation popup appears with the title `Reset Local Data` and the long description. Close it (Cancel).

- [ ] **Step 6: Commit**

```bash
git add src/components/sidebarLeft/tabs/settings.ts
# if lang.ts fallback was used:
# git add src/lang.ts
git commit -m "feat(settings): add Reset Local Data menu entry above Logout

Second button in the settings header menu toggle. Triggers the
Reset Local Data popup; icon: delete, danger styling inherited
from the confirmation popup."
```

---

## Task 5: Call `maybeShowResetToast()` at boot

**Files:**
- Modify: `src/index.ts:556-567`

- [ ] **Step 1: Add the boot hook**

Replace lines 556–567:

```ts
  try {
    const {mountNostraOnboarding} = await import('@/pages/nostra-onboarding-integration');
    const authContainer = document.querySelector('#auth-pages .scrollable') as HTMLElement;
    if(authContainer) {
      document.getElementById('auth-pages')!.style.display = '';
      await mountNostraOnboarding(authContainer);
      return; // Skip Telegram auth flow entirely
    }
  } catch(err) {
    console.error('[Nostra.chat] Failed to mount onboarding:', err);
    // Fall through to existing Telegram auth on error
  }
```

with:

```ts
  try {
    const {mountNostraOnboarding} = await import('@/pages/nostra-onboarding-integration');
    const {maybeShowResetToast} = await import('@components/popups/resetLocalData');
    const authContainer = document.querySelector('#auth-pages .scrollable') as HTMLElement;
    if(authContainer) {
      document.getElementById('auth-pages')!.style.display = '';
      await mountNostraOnboarding(authContainer);
      maybeShowResetToast();
      return; // Skip Telegram auth flow entirely
    }
  } catch(err) {
    console.error('[Nostra.chat] Failed to mount onboarding:', err);
    // Fall through to existing Telegram auth on error
  }
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit 2>&1 | grep -E "index\.ts|error TS" | head -20`
Expected: no errors in `src/index.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat(boot): surface Reset Local Data confirmation toast

Call maybeShowResetToast() after mountNostraOnboarding so users
see a 'Local data reset' toast on first render after the flow."
```

---

## Task 6: Manual verification

**Files:** none (runtime verification)

- [ ] **Step 1: Build and start**

Run: `pnpm start`
Expected: dev server listens on :8080.

- [ ] **Step 2: Fresh-identity, no-passphrase path**

1. Open `http://localhost:8080/` in a clean browser profile (or incognito).
2. Complete onboarding without a passphrase.
3. Send at least one message to a test peer (or just open a chat).
4. Open Settings → header menu → **Reset Local Data** → confirm.
5. Wait for reload.

Expected:
- Overlay shows `Resetting…` → `Local data reset — reloading…`.
- Page reloads to origin.
- App boots directly into the chat UI (no passphrase prompt).
- Chat list empty, settings cleared, relays at defaults.
- Toast appears: **Local data reset**.
- `localStorage.nostra_identity` still present (check via devtools Application tab).

- [ ] **Step 3: Passphrase path**

1. Fresh browser profile, onboard **with a passphrase**, send a message.
2. Reset Local Data → confirm → wait for reload.

Expected:
- Same overlay + reload flow.
- On boot, passphrase unlock screen appears.
- Enter passphrase → app unlocks to empty chat list.
- Toast: **Local data reset**.

- [ ] **Step 4: Cancel path**

1. Settings → Reset Local Data → click **Cancel** on the confirmation.

Expected: popup closes, no overlay, nothing wiped, no toast on subsequent reload.

- [ ] **Step 5: No commit (verification only)**

If all three paths pass, proceed to Task 7. If any path fails, stop and diagnose — do NOT patch symptoms blindly.

---

## Task 7: Update CLAUDE.md `Logout & Data Cleanup` section

**Files:**
- Modify: `CLAUDE.md` — `### Logout & Data Cleanup` subsection

**Rationale:** `CLAUDE.md` documents the logout/cleanup flow and the set of Nostra IDB/LS keys. The new helper + new popup deserve a one-line mention so future sessions discover them.

- [ ] **Step 1: Find the section**

Run: `grep -n "Logout & Data Cleanup\|clearAllNostraData\|nostra-cleanup" CLAUDE.md`
Expected: prints the section header line + the existing `clearAllNostraData` / `nostra-cleanup.ts` mentions.

- [ ] **Step 2: Append a bullet to the Logout & Data Cleanup section**

Add (after the existing bullets, before the next section):

```markdown
- **Reset Local Data** (sibling of logout): `showResetLocalDataPopup()` in `src/components/popups/resetLocalData.ts` wipes everything except the seed via `clearAllExceptSeed()` in `nostra-cleanup.ts` and calls `apiManager.logOut(undefined, {keepNostraIdentity: true})` so the Worker-side `deleteEncryptedIdentity()` is skipped. A `sessionStorage` marker (`nostra-just-reset`) triggers a confirmation toast on the next boot via `maybeShowResetToast()` called from `src/index.ts`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): document Reset Local Data flow

Note the new clearAllExceptSeed helper, the keepNostraIdentity
flag on logOut, and the boot-side reset toast hook."
```

---

## Self-Review Checklist

- [x] **Spec coverage**
  - UX entry point in settings menu → Task 4
  - Confirmation popup copy → Task 3 (inline English, conditional passphrase wording)
  - Overlay + reload flow → Task 3
  - Post-reload toast → Task 3 (helper) + Task 5 (boot call)
  - Nostra IDB wipe (5 of 6) → Task 1
  - Nostra LS wipe (all except seed) → Task 1
  - tweb state wipe → Task 2 (reuse `apiManager.logOut` minus identity)
  - Seed preservation → Tasks 1 + 2 (both skip paths)
  - Error handling on DB delete → Task 1 returns failed list; Task 3 surfaces `Reset incomplete` in overlay
- [x] **Placeholder scan** — no TBDs, no "add validation", every code block complete
- [x] **Type consistency** — `clearAllExceptSeed` / `clearAllNostraData` / `maybeShowResetToast` / `showResetLocalDataPopup` / `keepNostraIdentity` all referenced consistently across tasks
- [x] **Fallback paths** — Task 4 step 3 handles `regularText` unavailability; Task 3 step 2 handles title/description type quirks

---

## Execution notes

- No new unit test. The refactor is structural and the skip-filter is trivial; existing logout path remains exercised by its current callers.
- E2E `e2e-reset-local-data.ts` is **not** in scope (flagged in spec as nice-to-have).
- Commits are atomic per task; each task leaves the tree buildable.
