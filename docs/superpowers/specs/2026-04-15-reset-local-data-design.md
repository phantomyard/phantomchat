# Reset Local Data — Design

Date: 2026-04-15
Status: Approved

## Goal

Add a "Reset Local Data" action next to Logout in the settings menu that wipes every local byte of Nostra + tweb state **except the user's seed**, so the account boots as if freshly re-imported: default relays, no cached profile, no contacts, no messages, no settings.

## Non-goals

- Multi-account reset. Nostra.chat is single-account today; this feature only affects the active account.
- Remote state: no attempt to republish kind 0 / clean up relay data.
- Undo. The operation is destructive and final.

## UX

### Entry point

`src/components/sidebarLeft/tabs/settings.ts` already hosts a `ButtonMenuToggle` in the header with a single "Logout" entry. Add a second entry **above** Logout:

```ts
{
  icon: 'delete',
  text: 'Reset Local Data',
  onClick: () => showResetLocalDataPopup(),
  danger: true
}
```

Inline English text (matches existing `logOut.ts` style — no `lang.ts` churn).

### Confirmation popup

Fratello di `src/components/popups/logOut.ts`. Uses `confirmationPopup({...})`:

- **Title**: `Reset Local Data`
- **Description**: `This will delete all messages, contacts, relays, and settings. Your seed will be kept — if you set a passphrase, you'll be asked for it on restart. Continue?`
- **Button**: `Reset`, `isDanger: true`

On confirm → dark overlay with text `Resetting…` (reuse `createOverlay` helper pattern from `logOut.ts`; extract shared helper in the same file or inline-copy — inline copy is fine given both files are ~50 lines).

### Post-reload toast

After `location.href = location.origin` reload, show a toast: `Local data reset`. Persist a flag across reload via `sessionStorage.setItem('nostra-just-reset', '1')` **before** triggering the reload (sessionStorage survives in-tab reloads). On boot, check the flag, call `toast(...)`, delete the flag.

Toast invocation hook: add a `maybeShowResetToast()` export in `resetLocalData.ts`, invoked from `src/pages/nostra-onboarding-integration.ts` after UI init (same file that orchestrates boot). Toast relies on `@components/toast` which is already used across the codebase.

## What is cleared

### Nostra IndexedDB (5 of 6 deleted)

- `nostra-messages`
- `nostra-message-requests`
- `nostra-virtual-peers`
- `nostra-groups`
- `NostraPool`

**Kept**: `Nostra.chat` (holds the encrypted identity per `src/lib/nostra/identity.ts:192`).

### Nostra localStorage (all except seed)

Cleared:
- `nostra-relay-config`
- `nostra-last-seen-timestamp`
- `nostra:read-receipts-enabled`
- `nostra-folders-last-published`
- `nostra-folders-last-modified`
- `nostra-profile-cache`

**Kept**: `nostra_identity`.

### tweb state (all)

All tweb account/session/cache data, mirroring the cleanup block inside `apiManager.logOut()` (lines 305–331 in `src/lib/appManagers/apiManager.ts`):

- `AppStoragesManager.clearAllStoresForAccount(1)`
- `AppStoragesManager.clearSessionStores()`
- `commonStateStorage.clear()`
- `EncryptedStorageLayer.getInstance(...).clear()`
- `CacheStorageController.deleteAllStorages()`
- `sessionStorage` auth/dc/session keys (same list as logOut)

The one difference vs a real logout: **skip `deleteEncryptedIdentity()`** (the Worker-side Nostra seed wipe).

## Architecture

### 1. `src/lib/nostra/nostra-cleanup.ts` — add `clearAllExceptSeed()`

Refactor the existing `clearAllNostraData()` so the DB/LS lists are shared and a skip-set is parameterised:

```ts
const SEED_DB_NAME = 'Nostra.chat';
const SEED_LS_KEY = 'nostra_identity';

async function clearNostraData(opts: {keepSeed: boolean}): Promise<string[]> {
  const dbNames = opts.keepSeed
    ? NOSTRA_DB_NAMES.filter(n => n !== SEED_DB_NAME)
    : NOSTRA_DB_NAMES;
  const lsKeys = opts.keepSeed
    ? NOSTRA_LS_KEYS.filter(k => k !== SEED_LS_KEY)
    : NOSTRA_LS_KEYS;
  // …existing close / forceClose / delete / LS-clear logic, but using dbNames/lsKeys
}

export function clearAllNostraData()   { return clearNostraData({keepSeed: false}); }
export function clearAllExceptSeed()   { return clearNostraData({keepSeed: true});  }
```

**Caveat**: the existing `clearAllNostraData()` closes singleton DB connections via `destroy()` on message-store / message-requests / virtual-peers / group-store. None of those touch `Nostra.chat`, so keeping them in the close phase is safe for the `keepSeed` path. The `Nostra.chat` DB is opened on-demand by `identity.ts` / `key-storage.ts` and does not have a long-lived singleton connection to close.

### 2. `src/lib/appManagers/apiManager.ts` — add `keepNostraIdentity` flag

Minimal surgical change to `logOut()`:

```ts
public async logOut(
  migrateAccountTo?: ActiveAccountNumber,
  opts?: {keepNostraIdentity?: boolean}
) { … }
```

Wrap the existing call at line 344–349:

```ts
if(!opts?.keepNostraIdentity) {
  try {
    const {deleteEncryptedIdentity} = await import('../nostra/key-storage');
    await deleteEncryptedIdentity();
  } catch(err) { … }
}
```

Nothing else in `logOut()` changes. The logout path still calls `logOut()` without the flag and behaves identically.

### 3. `src/components/popups/resetLocalData.ts` — new file, ~60 lines

Structure (sibling of `logOut.ts`):

```ts
import rootScope from '@lib/rootScope';
import confirmationPopup from '@components/confirmationPopup';
import {toast} from '@components/toast';

const RESET_FLAG_KEY = 'nostra-just-reset';

function createOverlay(text: string): HTMLDivElement { /* same as logOut.ts */ }

export default function showResetLocalDataPopup() {
  confirmationPopup({
    titleLangKey: 'Reset Local Data' as any,  // inline string, same trick as logOut
    descriptionLangKey: '…' as any,
    button: {langKey: 'Reset' as any, isDanger: true}
  }).then(async() => {
    const overlay = createOverlay('Resetting…');
    try {
      const {clearAllExceptSeed} = await import('@lib/nostra/nostra-cleanup');
      await clearAllExceptSeed();
    } catch(err) {
      console.warn('[Nostra.chat] reset error:', err);
    }
    try { sessionStorage.setItem(RESET_FLAG_KEY, '1'); } catch{}
    rootScope.managers.apiManager.logOut(undefined, {keepNostraIdentity: true});
    setTimeout(() => { location.href = location.origin; }, 4000);
  });
}

export function maybeShowResetToast() {
  try {
    if(sessionStorage.getItem(RESET_FLAG_KEY) === '1') {
      sessionStorage.removeItem(RESET_FLAG_KEY);
      toast('Local data reset');
    }
  } catch{}
}
```

**Note on `confirmationPopup`**: it takes `titleLangKey` / `descriptionLangKey` / `button.langKey`. Current `logOut.ts` passes real lang keys. For inline English we either:
(a) cast to `any` (hacky but matches the "inline English" directive without touching `lang.ts`), or
(b) check if `confirmationPopup` accepts plain strings via an alternative prop (`title` / `description`).

During implementation, verify `confirmationPopup`'s actual signature and pick (b) if it supports plain strings; fall back to (a) only if it does not. This is a minor implementation detail flagged for the plan.

### 4. `src/components/sidebarLeft/tabs/settings.ts` — add menu entry

Change the `ButtonMenuToggle` buttons array from one entry to two, with Reset above Logout. Import `showResetLocalDataPopup` alongside `showLogOutPopup`.

### 5. `src/pages/nostra-onboarding-integration.ts` — boot-side toast hook

Import `maybeShowResetToast` from `@components/popups/resetLocalData` and call it once after UI init (somewhere it's safe to call `toast()` — after the root Solid render completes).

## Data flow

```
User clicks Reset Local Data
  └─ confirmationPopup → user confirms
      └─ createOverlay("Resetting…")
          └─ clearAllExceptSeed()          // Nostra DBs + LS minus seed
              └─ sessionStorage.setItem('nostra-just-reset', '1')
                  └─ apiManager.logOut(undefined, {keepNostraIdentity: true})
                      │   ├─ clears tweb stores/session/cache
                      │   └─ skips deleteEncryptedIdentity (seed survives)
                      └─ 4s safety: location.href = origin

Reload → boot
  └─ identity.ts reads nostra_identity + Nostra.chat DB
      └─ passphrase unlock if encrypted, else auto-unlock
          └─ app renders (fresh: default relays, no contacts, no messages)
              └─ maybeShowResetToast() → toast("Local data reset")
```

## Error handling

- `clearAllExceptSeed()` catches per-DB errors and returns a list of failed DBs (existing pattern). Overlay text updates to `Reset incomplete — reloading…` if any DB failed. Reload still fires.
- `sessionStorage.setItem` in private-browsing mode may throw: wrap in try/catch, toast is best-effort.
- `apiManager.logOut({keepNostraIdentity: true})` failing: the 4s `setTimeout` safety reload handles it.
- The user must have the passphrase memorised if they set one. The confirmation copy flags this explicitly.

## Testing

### Manual

1. Create identity with passphrase → send/receive messages → set custom relay → reset → reload → verify passphrase prompt → verify empty chat list, default relays, toast shown.
2. Same flow without passphrase → reset → verify auto-unlock boot with empty state.
3. Reset during active Tor session → verify no crash, Tor re-bootstraps post-reload.

### Unit

No new unit test required (the refactored `clearNostraData` is exercised by the existing logout path; the only net-new surface is the skip-filter which is trivial).

### E2E

Optional follow-up: `src/tests/e2e/e2e-reset-local-data.ts` — fresh identity → seed persists across reset (check `localStorage.nostra_identity` retained) + chat list empty + toast appears. Not required for this PR; flag in the plan as a nice-to-have.

## Files touched

| File | Change |
|---|---|
| `src/lib/nostra/nostra-cleanup.ts` | Refactor + add `clearAllExceptSeed()` |
| `src/lib/appManagers/apiManager.ts` | Add `opts.keepNostraIdentity` to `logOut()` |
| `src/components/popups/resetLocalData.ts` | **New** — popup + `maybeShowResetToast()` |
| `src/components/sidebarLeft/tabs/settings.ts` | Second menu entry + import |
| `src/pages/nostra-onboarding-integration.ts` | Call `maybeShowResetToast()` on boot |

## Open implementation details (for the plan)

1. Confirm `confirmationPopup` accepts plain `title` / `description` strings or forces `langKey`. Prefer plain strings; fall back to `as any` cast if needed.
2. Exact boot location in `nostra-onboarding-integration.ts` for `maybeShowResetToast()` — needs to be after `toast()` is usable (post-UI mount).
3. Whether `delete` is the right icon (matches Logout's `logout` icon semantically); alternative: `refresh` or `cancel`.
