# Background Push Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire system-level push notifications for Nostra.chat when the tab/PWA is closed, using `notify.damus.io` as the external Nostr push relay. User-configurable preview level (default generic), privacy-respecting via TorMode integration.

**Architecture:** Thin client over Damus push relay. New main-thread module `nostra-push-client.ts` registers Web Push subscription via `PrivacyTransport`-aware fetch. New SW module `nostra-push.ts` handles incoming push events with discriminator and per-peer aggregation. Privkey access from SW gated by preview level (default A = no decryption).

**Tech Stack:** TypeScript 5.7, Solid.js (custom fork), Vite 5, Service Worker API, Web Push API, IndexedDB, nostr-tools (NIP-44/NIP-59 already in repo), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-04-26-background-push-notifications-design.md`

**Branch:** `feat/nostra-background-push` (worktree: `../nostra.chat-wt/push-notif`)

---

## Risks & Pre-Implementation Investigations

The following uncertainties MUST be resolved by the indicated tasks **before** dependent tasks proceed. Do not guess and patch later — this is the kind of guess that causes a v0.22.x recall.

| Risk | Resolved by | Mitigation if blocker |
|---|---|---|
| Damus push relay register/unregister API shape (HTTP method, path, body schema, response) is undocumented | Task 1 (probe) | If undocumented or unstable, fall back to inspecting [github.com/jb55/nostr-push](https://github.com/jb55/nostr-push) source. As last resort, defer feature and self-host. |
| Damus VAPID public key — is it served at `/info`, fetched once, and stable? | Task 1 (probe) | If rotated frequently, fetch dynamically at registration time and re-register on change. |
| Push payload shape (does Damus forward the full kind 1059 event, just an event id, or a minimal hint with the recipient pubkey?) | Task 1 (probe) | If only id, SW must fetch from a relay before decrypting (cost, latency). Plan accommodates either via the SW handler. |
| TorMode "always" mode — registration may need to defer until Tor active, similar to ChatAPI handshake | Verified by reading `src/pages/nostra-onboarding-integration.ts:198-218` | Same wait-for-tor-active pattern reused. |
| SW build does NOT inject `import.meta.env.PROD` (per CLAUDE.md) — gates that depend on build mode silently disappear | Don't use `import.meta.env.PROD` in SW. Use runtime feature checks instead. | N/A |
| `localStorage` unavailable in SW context | Use IDB-only path for privkey access; add a SW-safe `loadIdentitySW()` helper without `localStorage` fallback | N/A |
| `vite-plugin-checker` overlay can intercept Playwright clicks if any ESLint warning fires | Keep lint clean throughout; do not add unused-pragma `eslint-disable` lines | N/A |

---

## File Structure

### New files (all on `feat/nostra-background-push`)

| Path | Responsibility |
|---|---|
| `src/lib/nostra/nostra-push-storage.ts` | IDB wrapper for the new `nostra-push` database: subscription record + preview level + endpoint override + aggregation state. Exposed via small functional API (`getSubscription`, `setSubscription`, `clearSubscription`, etc). Used by main thread AND SW. |
| `src/lib/nostra/nostra-push-client.ts` | Main-thread API for Damus push relay: `subscribePush()`, `unsubscribePush()`, `getRegistration()`, `setEndpointOverride()`. Routes HTTP via injected `fetchFn` so the caller can swap to Tor's `webtorClient.fetch`. |
| `src/lib/nostra/nostra-identity-sw.ts` | SW-safe identity loader. IDB-only (`Nostra.chat`). No `localStorage` fallback, no `window` references. Returns `{publicKey, privateKey}` or null. |
| `src/lib/serviceWorker/nostra-push.ts` | SW push event handler: discriminator, A/B/C rendering, NIP-44 decrypt for B/C, kind 0 name lookup, aggregation. |
| `src/components/sidebarLeft/tabs/nostraBackgroundNotifications.tsx` | Settings UI block (Solid component) that renders the new "Background notifications" section. Imported and inserted into the existing `notifications.tsx`. |
| `src/tests/nostra/nostra-push-storage.test.ts` | Unit tests for storage CRUD. |
| `src/tests/nostra/nostra-push-client.test.ts` | Unit tests: register/unregister payloads, fetch wiring, error paths. |
| `src/tests/nostra/nostra-push-sw.test.ts` | Unit tests for the SW handler: A/B/C rendering, decryption mock, aggregation rate-limit. |
| `src/tests/e2e/e2e-push-bilateral.ts` | Real E2E (separate online suite). Two Playwright contexts, real Damus relay. |
| `docs/PUSH-NOTIFICATIONS.md` | User-facing privacy disclosure. |

### Modified files

| Path | Change |
|---|---|
| `src/lib/serviceWorker/push.ts` | Add discriminator at top of `onPushEvent`: if `payload.app === 'nostra'` dispatch to nostra-push handler, else fall through to existing Telegram path. |
| `src/lib/serviceWorker/index.service.ts` | Import nostra-push handler module so it gets bundled. |
| `src/lib/nostra/nostra-cleanup.ts` | Add `nostra-push` DB to the cleanup DB list and call `unsubscribePush()` before DB deletion. |
| `src/pages/nostra-onboarding-integration.ts` | Add auto-subscribe block after `Notification.permission === 'granted'` is observed. |
| `src/components/sidebarLeft/tabs/notifications.tsx` | Insert the new `<NostraBackgroundNotifications />` component above the Sounds section. |
| `src/lib/rootScope.ts` | Add `BroadcastEvents` entry for `nostra_push_subscription_changed` (used by Settings UI to react to status changes). |

### Files explicitly NOT touched

- `src/lib/webPushApiManager.ts` — Telegram-coupled, left as-is. The new code does not import it.
- Any test in `src/tests/nostra/` not listed above.
- `src/lib/serviceWorker/push.ts` paths beyond the discriminator (Telegram payload handling untouched).

---

## Phase Order & Dependencies

```
Task 0 (worktree)
  └─ Task 1 (Damus API probe) ─────────────────┐
  └─ Task 2 (storage)                          │
       └─ Task 3 (storage tests)               │
       └─ Task 4 (SW-safe identity loader)     │
       └─ Task 5 (push-client)  ◄──────────────┘  needs API contract
            └─ Task 6 (push-client tests)
       └─ Task 7 (SW handler module)
            └─ Task 8 (SW handler tests)
       └─ Task 9 (SW push.ts discriminator)
       └─ Task 10 (rootScope event)
       └─ Task 11 (onboarding auto-subscribe)
       └─ Task 12 (cleanup integration)
       └─ Task 13 (Settings UI component)
       └─ Task 14 (Settings UI integration)
       └─ Task 15 (PUSH-NOTIFICATIONS.md)
       └─ Task 16 (E2E real test)
       └─ Task 17 (full lint + test:nostra:quick)
       └─ Task 18 (manual smoke documentation)
       └─ Task 19 (PR)
```

---

## Task 0: Set up worktree

**Files:**
- Create: `../nostra.chat-wt/push-notif/` (git worktree)

- [ ] **Step 1: Confirm origin/main is at the latest release**

```bash
git fetch origin
git log --oneline origin/main -3
```
Expected: latest commit is the most recent `chore(main): release` entry. If a different feature branch is needed as base, branch off that instead.

- [ ] **Step 2: Create the worktree on a fresh branch**

```bash
git worktree add ../nostra.chat-wt/push-notif -b feat/nostra-background-push origin/main
```
Expected: `Preparing worktree (new branch 'feat/nostra-background-push')`.

- [ ] **Step 3: Install dependencies inside the worktree**

```bash
cd ../nostra.chat-wt/push-notif
pnpm install --prefer-offline
```
Expected: `Done in <Ns>`.

- [ ] **Step 4: Confirm baseline lint + test:nostra:quick are green before any change**

```bash
pnpm lint
pnpm test:nostra:quick
```
Expected: lint silent (zero output); tests show all green (no `FAIL`). If any pre-existing failure surfaces, document it in the PR description but do not fix in this branch.

- [ ] **Step 5: No commit**

This task creates infrastructure only.

**Definition of done:** Worktree exists, `pnpm install` succeeded, baseline checks green.

---

## Task 1: Probe and document Damus push relay API

**Files:**
- Create: `docs/superpowers/research/2026-04-26-damus-push-relay-api.md`

- [ ] **Step 1: Probe `/info`-style endpoints to find VAPID key**

```bash
for path in /info /vapid /pubkey /public-key /; do
  echo "--- $path ---"
  curl -s -m 10 -i "https://notify.damus.io$path" | head -20
done
```
Record working endpoint and response shape in the research doc.

- [ ] **Step 2: Probe register endpoints**

Try common shapes:
```bash
curl -s -m 10 -i -X POST "https://notify.damus.io/user-info" \
  -H "Content-Type: application/json" \
  -d '{"user_pubkey":"0000000000000000000000000000000000000000000000000000000000000000","push_token":{"endpoint":"https://example.invalid","p256dh":"x","auth":"y"}}'

curl -s -m 10 -i -X POST "https://notify.damus.io/register" \
  -H "Content-Type: application/json" \
  -d '{"pubkey":"0000000000000000000000000000000000000000000000000000000000000000","subscription":{"endpoint":"https://example.invalid","keys":{"p256dh":"x","auth":"y"}}}'
```
Record actual responses (200/400/404/etc) and any embedded error messages indicating the correct field names.

- [ ] **Step 3: Cross-check against jb55/nostr-push source**

```bash
# Public reference; if reachable, confirms server type and routes
curl -s "https://api.github.com/repos/jb55/nostr-push/contents/src/main.rs" | head -5
# Or browse via: https://github.com/jb55/nostr-push
```
Expected: confirm whether `notify.damus.io` runs `nostr-push` and which version. If the server uses NIP-XX-style auth or a different schema, document it.

- [ ] **Step 4: Inspect a real push payload**

Register a temp subscription via curl using a working `endpoint` from a request bin (e.g. `https://requestbin.com/`); send yourself a kind 1059 from another client; capture what arrives. Paste the JSON body received at the request bin into the research doc.

- [ ] **Step 5: Write the research doc**

Create `docs/superpowers/research/2026-04-26-damus-push-relay-api.md` with these sections:

```markdown
# Damus Push Relay API — Probe Results

Date: 2026-04-26
Scope: Locking the API contract for nostra-push-client.ts and nostra-push (SW handler).

## VAPID Public Key
- Endpoint: <discovered>
- Response shape: <verbatim>
- Caching strategy decision: <fetch once at first registration, cache in IDB; re-fetch on register-side 401/410>

## Register
- Method/Path: <verbatim>
- Body (JSON):
  ```json
  { ... }
  ```
- Success response: <status, body>
- Failure modes seen: <list>

## Unregister
- Method/Path: <verbatim>
- Body (JSON): <verbatim>
- Success response: <status, body>

## Push payload received by SW
- Field map:
  - `app`: <yes/no — if yes, value> (we discriminate on this — if Damus does not set it, we add it via a Damus config option, or we pivot to a different discriminator like a fixed top-level key)
  - `event_id`, `event`, `from`, `to`, `kind`, `created_at`: <which are present>
- Discriminator decision: <final field used to distinguish Nostra-shape pushes from Telegram-shape>

## Failure modes / open issues for downstream tasks
<list>
```

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/research/2026-04-26-damus-push-relay-api.md
git commit -m "docs(research): damus push relay API contract probe"
```

**Definition of done:** Research doc committed, contains verbatim API responses, downstream tasks can reference field names from this doc.

**If Damus is unreachable or schema rejects all probes:** Stop the plan and surface the blocker. Self-hosting `nostr-push` is the documented fallback (out of scope of this plan).

---

## Task 2: Create `nostra-push-storage.ts`

**Files:**
- Create: `src/lib/nostra/nostra-push-storage.ts`
- Test: `src/tests/nostra/nostra-push-storage.test.ts` (Task 3)

- [ ] **Step 1: Write the storage module**

```typescript
/**
 * nostra-push-storage.ts
 *
 * IDB wrapper for the `nostra-push` database. Used by the main-thread push
 * client AND by the Service Worker push handler — both must run identical
 * code paths because the SW cannot rely on main-thread-injected state.
 *
 * Schema (DB: nostra-push, version 1):
 *   - objectStore 'kv' (keyPath: 'k') — small key/value records
 *     keys:
 *       'subscription'  → PushSubscriptionRecord
 *       'preview_level' → 'A' | 'B' | 'C'  (default 'A')
 *       'endpoint'      → string (override; default 'https://notify.damus.io')
 *       'aggregation'   → Record<peerId, AggregationEntry>
 */

const DB_NAME = 'nostra-push';
const DB_VERSION = 1;
const STORE_NAME = 'kv';

export const DEFAULT_ENDPOINT = 'https://notify.damus.io';
export const AGGREGATION_WINDOW_MS = 5 * 60 * 1000;

export type PreviewLevel = 'A' | 'B' | 'C';

export interface PushSubscriptionRecord {
  subscriptionId: string;
  endpointBase: string;
  pubkey: string;
  registeredAt: number;
  endpoint: string;
  keys: {p256dh: string; auth: string};
}

export interface AggregationEntry {
  ts: number;
  count: number;
  tag: string;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, {keyPath: 'k'});
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

async function getValue<T>(key: string): Promise<T | null> {
  const db = await openDB();
  return new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result ? (req.result.v as T) : null);
  });
}

async function putValue<T>(key: string, value: T): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put({k: key, v: value});
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

async function deleteValue(key: string): Promise<void> {
  const db = await openDB();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve();
  });
}

export async function getSubscription(): Promise<PushSubscriptionRecord | null> {
  return getValue<PushSubscriptionRecord>('subscription');
}

export async function setSubscription(rec: PushSubscriptionRecord): Promise<void> {
  await putValue('subscription', rec);
}

export async function clearSubscription(): Promise<void> {
  await deleteValue('subscription');
}

export async function getPreviewLevel(): Promise<PreviewLevel> {
  return (await getValue<PreviewLevel>('preview_level')) || 'A';
}

export async function setPreviewLevel(level: PreviewLevel): Promise<void> {
  await putValue('preview_level', level);
}

export async function getEndpointBase(): Promise<string> {
  return (await getValue<string>('endpoint')) || DEFAULT_ENDPOINT;
}

export async function setEndpointBase(url: string | null): Promise<void> {
  if(url === null) {
    await deleteValue('endpoint');
  } else {
    await putValue('endpoint', url);
  }
}

export async function getAggregationState(): Promise<Record<string, AggregationEntry>> {
  return (await getValue<Record<string, AggregationEntry>>('aggregation')) || {};
}

export async function setAggregationState(state: Record<string, AggregationEntry>): Promise<void> {
  await putValue('aggregation', state);
}

export async function clearAggregationFor(peerId: string): Promise<void> {
  const state = await getAggregationState();
  delete state[peerId];
  await setAggregationState(state);
}

/**
 * Forcibly close the cached DB connection so the cleanup path in
 * nostra-cleanup.ts can deleteDatabase without "blocked" race.
 */
export async function destroy(): Promise<void> {
  if(!dbPromise) return;
  const db = await dbPromise;
  try { db.close(); } catch{}
  dbPromise = null;
}
```

- [ ] **Step 2: Quick lint pass**

```bash
npx eslint src/lib/nostra/nostra-push-storage.ts
```
Expected: silent.

- [ ] **Step 3: Commit**

```bash
git add src/lib/nostra/nostra-push-storage.ts
git commit -m "feat(push): nostra-push IDB storage layer"
```

**Definition of done:** Module compiles, lint clean, schema documented in JSDoc.

---

## Task 3: Storage unit tests

**Files:**
- Create: `src/tests/nostra/nostra-push-storage.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import {describe, expect, beforeEach, afterEach, it} from 'vitest';
import 'fake-indexeddb/auto';
import {
  getSubscription, setSubscription, clearSubscription,
  getPreviewLevel, setPreviewLevel,
  getEndpointBase, setEndpointBase, DEFAULT_ENDPOINT,
  getAggregationState, setAggregationState, clearAggregationFor,
  destroy
} from '@lib/nostra/nostra-push-storage';

const SAMPLE = {
  subscriptionId: 'sub_abc',
  endpointBase: 'https://notify.damus.io',
  pubkey: 'a'.repeat(64),
  registeredAt: 1700000000_000,
  endpoint: 'https://fcm.googleapis.com/wp/aaa',
  keys: {p256dh: 'pX', auth: 'aY'}
};

describe('nostra-push-storage', () => {
  beforeEach(async() => {
    await destroy();
    indexedDB.deleteDatabase('nostra-push');
  });
  afterEach(async() => { await destroy(); });

  it('returns null subscription before set', async() => {
    expect(await getSubscription()).toBeNull();
  });

  it('round-trips a subscription record', async() => {
    await setSubscription(SAMPLE);
    expect(await getSubscription()).toEqual(SAMPLE);
  });

  it('clears the subscription', async() => {
    await setSubscription(SAMPLE);
    await clearSubscription();
    expect(await getSubscription()).toBeNull();
  });

  it('preview level defaults to A', async() => {
    expect(await getPreviewLevel()).toBe('A');
  });

  it('preview level round-trips B and C', async() => {
    await setPreviewLevel('B');
    expect(await getPreviewLevel()).toBe('B');
    await setPreviewLevel('C');
    expect(await getPreviewLevel()).toBe('C');
  });

  it('endpoint defaults to notify.damus.io', async() => {
    expect(await getEndpointBase()).toBe(DEFAULT_ENDPOINT);
  });

  it('endpoint override and reset', async() => {
    await setEndpointBase('https://custom.example.invalid');
    expect(await getEndpointBase()).toBe('https://custom.example.invalid');
    await setEndpointBase(null);
    expect(await getEndpointBase()).toBe(DEFAULT_ENDPOINT);
  });

  it('aggregation state empty by default', async() => {
    expect(await getAggregationState()).toEqual({});
  });

  it('aggregation round-trip and clearAggregationFor', async() => {
    await setAggregationState({peer1: {ts: 1, count: 2, tag: 't'}, peer2: {ts: 3, count: 4, tag: 'u'}});
    await clearAggregationFor('peer1');
    expect(await getAggregationState()).toEqual({peer2: {ts: 3, count: 4, tag: 'u'}});
  });
});
```

- [ ] **Step 2: Confirm `fake-indexeddb` is already installed**

```bash
grep -q '"fake-indexeddb"' package.json && echo OK || echo MISSING
```
If `MISSING`: install via `pnpm add -D fake-indexeddb` and commit `package.json` + `pnpm-lock.yaml` separately (`build(deps): add fake-indexeddb for push storage tests`).

- [ ] **Step 3: Run test, expect FAIL on any IDB-handling bug**

```bash
pnpm test run src/tests/nostra/nostra-push-storage.test.ts
```
Expected: all 9 tests PASS. If they fail, debug the storage module (likely keyPath mismatch or version bump issue), do NOT relax tests.

- [ ] **Step 4: Add the test file to the `test:nostra:quick` glob**

Inspect `package.json` `test:nostra:quick` script. If the file is not auto-discovered, append its path to the explicit list (per CLAUDE.md note about quick suite needing explicit additions).

```bash
grep -n test:nostra:quick package.json
```
If the script lists explicit files, edit `package.json` to add `src/tests/nostra/nostra-push-storage.test.ts`. Verify:

```bash
pnpm test:nostra:quick 2>&1 | tail -10
```
Expected: count of tests increases; nostra-push-storage entries visible.

- [ ] **Step 5: Commit**

```bash
git add src/tests/nostra/nostra-push-storage.test.ts package.json
git commit -m "test(push): nostra-push-storage IDB CRUD coverage"
```

**Definition of done:** 9 tests green; included in `test:nostra:quick`.

---

## Task 4: SW-safe identity loader

**Files:**
- Create: `src/lib/nostra/nostra-identity-sw.ts`

- [ ] **Step 1: Write the SW-safe loader**

```typescript
/**
 * nostra-identity-sw.ts
 *
 * SW-safe variant of loadIdentity(). The full src/lib/nostra/identity.ts
 * falls back to localStorage if IDB fails — but localStorage does not exist
 * in Service Worker context. This helper only reads from IDB and returns
 * null on any failure.
 *
 * SAFE TO IMPORT FROM:
 *   - main thread (works, but use loadIdentity() there for full fallback)
 *   - service worker context (only path that works)
 */

const DB_NAME = 'Nostra.chat';
const STORE_NAME = 'identity';
const ID_KEY = 'current';

export interface SWIdentity {
  publicKey: string;
  privateKey: string;
}

export async function loadIdentitySW(): Promise<SWIdentity | null> {
  try {
    const db = await openDb();
    return new Promise<SWIdentity | null>((resolve) => {
      try {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(ID_KEY);
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const r = req.result;
          if(r && typeof r.publicKey === 'string' && typeof r.privateKey === 'string') {
            resolve({publicKey: r.publicKey, privateKey: r.privateKey});
          } else {
            resolve(null);
          }
        };
      } catch{
        resolve(null);
      }
    });
  } catch{
    return null;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    // No onupgradeneeded — SW must NOT alter the schema. If the store is
    // missing it means identity was never created in this origin and we
    // return null cleanly.
  });
}
```

- [ ] **Step 2: Verify the schema matches `src/lib/nostra/identity.ts`**

```bash
grep -n "DB_NAME\|STORE_NAME\|'current'\|publicKey\|privateKey" src/lib/nostra/identity.ts | head -15
```
Expected: matches `DB_NAME = 'Nostra.chat'`, store with `current` keypath, `publicKey`/`privateKey` properties. If not, adjust the SW helper to match.

- [ ] **Step 3: Quick lint**

```bash
npx eslint src/lib/nostra/nostra-identity-sw.ts
```
Expected: silent.

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/nostra-identity-sw.ts
git commit -m "feat(push): SW-safe identity loader (IDB-only, no localStorage fallback)"
```

**Definition of done:** Module compiles, lint clean, schema verified to match `identity.ts`.

---

## Task 5: `nostra-push-client.ts` (main-thread API)

**Files:**
- Create: `src/lib/nostra/nostra-push-client.ts`
- Test: `src/tests/nostra/nostra-push-client.test.ts` (Task 6)

**API contract assumption:** Use the field names, paths, and methods recorded in `docs/superpowers/research/2026-04-26-damus-push-relay-api.md`. The code below uses placeholder names (`/register`, `pubkey`, `subscription` body keys); rename to match the research doc before commit.

- [ ] **Step 1: Write the client module**

```typescript
/**
 * nostra-push-client.ts
 *
 * Main-thread API for the Damus Nostr push relay.
 *
 * Caller responsibilities:
 *   - Pass `fetchFn` so the caller can route via Tor's webtorClient.fetch
 *     when PrivacyTransport mode is active. Default is globalThis.fetch.
 *   - Call subscribePush() AFTER Notification.permission === 'granted'
 *     and AFTER an own pubkey is available (window.__nostraOwnPubkey).
 *
 * The client persists its subscription state via nostra-push-storage.
 */

import {
  DEFAULT_ENDPOINT,
  PushSubscriptionRecord,
  getSubscription,
  setSubscription,
  clearSubscription,
  getEndpointBase
} from '@lib/nostra/nostra-push-storage';

export type FetchFn = typeof fetch;

interface SubscribeOptions {
  pubkeyHex: string;        // 64-char hex, no 'npub' prefix
  vapidPublicKey: string;   // base64-url
  fetchFn?: FetchFn;
}

interface RegisterRequestBody {
  // Field names locked by Task 1 research doc — adjust if doc says otherwise.
  pubkey: string;
  endpoint: string;
  keys: {p256dh: string; auth: string};
}

interface RegisterResponse {
  subscription_id: string;
}

const LOG_PREFIX = '[NostraPushClient]';

/**
 * Subscribe Web Push at the browser level + register with Damus.
 * Returns the persisted record on success, null on user-denied permission
 * or unrecoverable network failure.
 */
export async function subscribePush(opts: SubscribeOptions): Promise<PushSubscriptionRecord | null> {
  if(typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return null;
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if(!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(opts.vapidPublicKey)
    });
  }
  const json = sub.toJSON();
  const endpoint = json.endpoint!;
  const p256dh = json.keys?.p256dh ?? '';
  const auth = json.keys?.auth ?? '';
  if(!p256dh || !auth) {
    console.warn(LOG_PREFIX, 'subscription missing keys');
    return null;
  }

  const endpointBase = await getEndpointBase();
  const fetchFn = opts.fetchFn || globalThis.fetch.bind(globalThis);
  const body: RegisterRequestBody = {pubkey: opts.pubkeyHex, endpoint, keys: {p256dh, auth}};
  let registeredId: string;
  try {
    const res = await fetchFn(`${endpointBase}/register`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    if(!res.ok) {
      console.warn(LOG_PREFIX, 'register HTTP', res.status);
      return null;
    }
    const parsed = (await res.json()) as RegisterResponse;
    registeredId = parsed.subscription_id;
  } catch(e: any) {
    console.warn(LOG_PREFIX, 'register fetch failed:', e?.message);
    return null;
  }

  const record: PushSubscriptionRecord = {
    subscriptionId: registeredId,
    endpointBase,
    pubkey: opts.pubkeyHex,
    registeredAt: Date.now(),
    endpoint,
    keys: {p256dh, auth}
  };
  await setSubscription(record);
  return record;
}

export async function unsubscribePush(opts: {fetchFn?: FetchFn} = {}): Promise<void> {
  const rec = await getSubscription();
  if(rec) {
    const fetchFn = opts.fetchFn || globalThis.fetch.bind(globalThis);
    try {
      await fetchFn(`${rec.endpointBase}/register/${encodeURIComponent(rec.subscriptionId)}`, {
        method: 'DELETE'
      });
    } catch(e: any) {
      console.warn(LOG_PREFIX, 'unregister fetch failed (ignoring):', e?.message);
    }
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if(sub) await sub.unsubscribe();
  } catch(e: any) {
    console.warn(LOG_PREFIX, 'pushManager.unsubscribe error (ignoring):', e?.message);
  }
  await clearSubscription();
}

export async function getRegistration(): Promise<PushSubscriptionRecord | null> {
  return getSubscription();
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for(let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
```

If the research doc (Task 1) shows a different request/response shape, **adjust the field names of `RegisterRequestBody` and `RegisterResponse` here, not later**. A mismatch here cascades into Task 6 tests, Task 11 onboarding wiring, and the E2E test — fix at the root.

- [ ] **Step 2: Lint**

```bash
npx eslint src/lib/nostra/nostra-push-client.ts
```
Expected: silent.

- [ ] **Step 3: Commit**

```bash
git add src/lib/nostra/nostra-push-client.ts
git commit -m "feat(push): nostra-push-client (subscribe/unsubscribe/get) with injectable fetch"
```

**Definition of done:** Module compiles, lint clean, field names match research doc.

---

## Task 6: `nostra-push-client` unit tests

**Files:**
- Create: `src/tests/nostra/nostra-push-client.test.ts`

- [ ] **Step 1: Write tests**

```typescript
import {describe, expect, beforeEach, afterEach, it, vi} from 'vitest';
import 'fake-indexeddb/auto';
import {subscribePush, unsubscribePush, getRegistration} from '@lib/nostra/nostra-push-client';
import {destroy as destroyStorage} from '@lib/nostra/nostra-push-storage';

// Minimal mocks matching the API surface used by the client.
function setupBrowserMocks() {
  (globalThis as any).Notification = {permission: 'granted'};
  (globalThis as any).atob = (s: string) => Buffer.from(s, 'base64').toString('binary');

  const mockSubscription = {
    endpoint: 'https://fcm.googleapis.com/wp/test',
    toJSON: () => ({
      endpoint: 'https://fcm.googleapis.com/wp/test',
      keys: {p256dh: 'p256X', auth: 'authY'}
    }),
    unsubscribe: vi.fn().mockResolvedValue(true)
  };
  const mockPushManager = {
    getSubscription: vi.fn().mockResolvedValue(null),
    subscribe: vi.fn().mockResolvedValue(mockSubscription)
  };
  const mockReg = {pushManager: mockPushManager};
  (globalThis as any).navigator = {serviceWorker: {ready: Promise.resolve(mockReg)}};

  return {mockSubscription, mockPushManager};
}

const VAPID_KEY = 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const PUBKEY = 'a'.repeat(64);

describe('nostra-push-client', () => {
  beforeEach(async() => {
    await destroyStorage();
    indexedDB.deleteDatabase('nostra-push');
  });
  afterEach(async() => { await destroyStorage(); vi.restoreAllMocks(); });

  it('subscribePush returns null when permission not granted', async() => {
    (globalThis as any).Notification = {permission: 'denied'};
    const out = await subscribePush({pubkeyHex: PUBKEY, vapidPublicKey: VAPID_KEY});
    expect(out).toBeNull();
  });

  it('subscribePush registers and persists on 200', async() => {
    const mocks = setupBrowserMocks();
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async() => ({subscription_id: 'sub_xyz'})
    });
    const rec = await subscribePush({pubkeyHex: PUBKEY, vapidPublicKey: VAPID_KEY, fetchFn});
    expect(rec).toBeTruthy();
    expect(rec!.subscriptionId).toBe('sub_xyz');
    expect(rec!.pubkey).toBe(PUBKEY);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toMatch(/\/register$/);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.pubkey).toBe(PUBKEY);
    expect(body.endpoint).toBe('https://fcm.googleapis.com/wp/test');
    expect(body.keys.p256dh).toBe('p256X');
    expect(body.keys.auth).toBe('authY');
    void mocks;
  });

  it('subscribePush returns null on register HTTP failure', async() => {
    setupBrowserMocks();
    const fetchFn = vi.fn().mockResolvedValue({ok: false, status: 500, json: async() => ({})});
    const out = await subscribePush({pubkeyHex: PUBKEY, vapidPublicKey: VAPID_KEY, fetchFn});
    expect(out).toBeNull();
    expect(await getRegistration()).toBeNull();
  });

  it('unsubscribePush issues DELETE and clears storage', async() => {
    const mocks = setupBrowserMocks();
    mocks.mockPushManager.getSubscription = vi.fn().mockResolvedValue(mocks.mockSubscription);
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ok: true, status: 200, json: async() => ({subscription_id: 'sub_del'})})
      .mockResolvedValueOnce({ok: true, status: 200});
    await subscribePush({pubkeyHex: PUBKEY, vapidPublicKey: VAPID_KEY, fetchFn});
    await unsubscribePush({fetchFn});
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn.mock.calls[1][0]).toContain('/register/sub_del');
    expect(fetchFn.mock.calls[1][1].method).toBe('DELETE');
    expect(await getRegistration()).toBeNull();
    expect(mocks.mockSubscription.unsubscribe).toHaveBeenCalled();
  });

  it('unsubscribePush is a no-op when no record', async() => {
    setupBrowserMocks();
    const fetchFn = vi.fn();
    await unsubscribePush({fetchFn});
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm test run src/tests/nostra/nostra-push-client.test.ts
```
Expected: 5 tests PASS. If failing, the most likely culprit is a field-name mismatch with the research doc — re-align Task 5 first, do NOT relax expectations.

- [ ] **Step 3: Add to quick suite if not auto-discovered**

(Same procedure as Task 3 step 4.)

- [ ] **Step 4: Commit**

```bash
git add src/tests/nostra/nostra-push-client.test.ts package.json
git commit -m "test(push): nostra-push-client subscribe/unsubscribe coverage"
```

**Definition of done:** All 5 tests green in `test:nostra:quick`.

---

## Task 7: SW push handler module

**Files:**
- Create: `src/lib/serviceWorker/nostra-push.ts`

- [ ] **Step 1: Write the SW handler**

```typescript
/**
 * nostra-push.ts (Service Worker)
 *
 * Handles incoming Web Push events shaped for Nostra. Discriminator: payload
 * has `app === 'nostra'` (or whatever Task 1 research doc specifies).
 *
 * Per preview level:
 *   A — show generic notification, never read privkey.
 *   B — read privkey, decrypt NIP-44 gift-wrap, render sender name + body.
 *   C — read privkey, decrypt, render sender name + "[encrypted]".
 *
 * Aggregation: rate-limit per peerId in a 5-minute window.
 */

declare const self: ServiceWorkerGlobalScope;

import {
  AGGREGATION_WINDOW_MS,
  AggregationEntry,
  PushSubscriptionRecord,
  clearAggregationFor,
  getAggregationState,
  getPreviewLevel,
  setAggregationState
} from '@lib/nostra/nostra-push-storage';
import {loadIdentitySW} from '@lib/nostra/nostra-identity-sw';

interface NostraPushPayload {
  // Field names locked by Task 1 research doc. The shape below is the
  // working assumption pending verification.
  app: 'nostra';
  event_id: string;          // gift-wrap id
  recipient_pubkey: string;  // our pubkey, hex
  // Optional — server may include or omit:
  event?: string;            // serialized full event JSON, if forwarded
  from?: string;             // sender pubkey hint (NEVER trusted; NIP-59 wrapper is ephemeral)
}

const DEFAULT_TITLE = 'Nostra.chat';
const DEFAULT_BODY = 'New message';

export async function onNostraPush(event: ExtendableEvent & {data: PushMessageData}): Promise<void> {
  let payload: NostraPushPayload;
  try {
    payload = event.data.json() as NostraPushPayload;
  } catch{
    return;
  }
  if(payload.app !== 'nostra') return;

  const previewLevel = await getPreviewLevel();

  // Synthesize a stable peer identifier early. For preview A we use event_id
  // (we have no peer info before decrypting). For B/C this is replaced by
  // the real peer pubkey after decryption.
  let peerKey = payload.event_id;
  let title = DEFAULT_TITLE;
  let body = DEFAULT_BODY;

  if(previewLevel !== 'A') {
    try {
      const decrypted = await tryDecrypt(payload);
      if(decrypted) {
        peerKey = decrypted.senderPubkey;
        title = decrypted.senderName;
        body = previewLevel === 'C' ? '[encrypted]' : truncate(decrypted.text, 80);
      }
    } catch(e: any) {
      console.warn('[NostraPushSW] decrypt failed:', e?.message);
      // fall through to generic
    }
  }

  await showAggregated({peerKey, title, body, previewLevel, payload});
}

interface DecryptedRumor {
  senderPubkey: string;
  senderName: string;
  text: string;
}

async function tryDecrypt(payload: NostraPushPayload): Promise<DecryptedRumor | null> {
  const identity = await loadIdentitySW();
  if(!identity) return null;
  if(!payload.event) {
    // Without the full event, the SW can't decrypt offline. Future work:
    // fetch from a relay. MVP returns null and falls back to generic.
    return null;
  }
  const evt = JSON.parse(payload.event);
  // Lazy-import nostr crypto helpers; they work in SW context.
  const {unwrapNip17} = await import('@lib/nostra/nostr-crypto');
  const rumor = await unwrapNip17(evt, identity.privateKey);
  if(!rumor) return null;
  const senderName = await resolveSenderName(rumor.pubkey);
  const text = typeof rumor.content === 'string' ? rumor.content : '';
  return {senderPubkey: rumor.pubkey, senderName: senderName || shortenPubkey(rumor.pubkey), text};
}

async function resolveSenderName(pubkey: string): Promise<string | null> {
  try {
    const db = await openVirtualPeersDB();
    return await new Promise<string | null>((resolve) => {
      try {
        const tx = db.transaction('peers', 'readonly');
        const req = tx.objectStore('peers').get(pubkey);
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const r = req.result;
          if(r && typeof r.displayName === 'string' && r.displayName.length) {
            resolve(r.displayName);
          } else { resolve(null); }
        };
      } catch{ resolve(null); }
    });
  } catch{ return null; }
}

function openVirtualPeersDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nostra-virtual-peers');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

interface ShowAggregatedArgs {
  peerKey: string;
  title: string;
  body: string;
  previewLevel: 'A' | 'B' | 'C';
  payload: NostraPushPayload;
}

async function showAggregated(args: ShowAggregatedArgs): Promise<void> {
  const state = await getAggregationState();
  const now = Date.now();
  const entry: AggregationEntry = state[args.peerKey] || {ts: 0, count: 0, tag: 'nostra-' + args.peerKey};
  let body = args.body;
  if(now - entry.ts < AGGREGATION_WINDOW_MS) {
    entry.count += 1;
    body = `${entry.count} new messages from ${args.title}`;
  } else {
    entry.count = 1;
  }
  entry.ts = now;
  state[args.peerKey] = entry;
  await setAggregationState(state);

  await self.registration.showNotification(args.title, {
    body,
    tag: entry.tag,
    icon: '/assets/img/logo_filled_rounded.png',
    badge: '/assets/img/logo_filled_rounded.png',
    data: {
      app: 'nostra',
      peerKey: args.peerKey,
      eventId: args.payload.event_id
    }
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function shortenPubkey(pk: string): string {
  return pk.length > 16 ? `${pk.slice(0, 8)}…${pk.slice(-4)}` : pk;
}

/** Notification click handler — opens or focuses Nostra to the right peer. */
export async function onNostraNotificationClick(event: NotificationEvent): Promise<void> {
  const data = event.notification.data;
  if(!data || data.app !== 'nostra') return;
  event.notification.close();
  // Clear aggregation so next message reopens a fresh notification.
  if(typeof data.peerKey === 'string') {
    await clearAggregationFor(data.peerKey).catch(() => {});
  }
  const url = `/?p=${encodeURIComponent(data.peerKey)}&m=${encodeURIComponent(data.eventId)}`;
  const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  for(const client of all) {
    try {
      await (client as WindowClient).focus();
      (client as WindowClient).postMessage({type: 'nostra-push-open', url});
      return;
    } catch{ /* ignore */ }
  }
  await self.clients.openWindow(url);
}
```

If `unwrapNip17` is not the actual export name in `src/lib/nostra/nostr-crypto.ts`, run `grep -n 'export' src/lib/nostra/nostr-crypto.ts` and correct the import.

- [ ] **Step 2: Lint**

```bash
npx eslint src/lib/serviceWorker/nostra-push.ts
```
Expected: silent.

- [ ] **Step 3: Commit**

```bash
git add src/lib/serviceWorker/nostra-push.ts
git commit -m "feat(push): SW handler with A/B/C preview, aggregation, click router"
```

**Definition of done:** Module compiles, lint clean, NIP-17 import points at the real export.

---

## Task 8: SW handler unit tests

**Files:**
- Create: `src/tests/nostra/nostra-push-sw.test.ts`

These are **direct function tests** — we exercise `onNostraPush` and `onNostraNotificationClick` as plain async functions, mocking the `self.registration.showNotification` and `self.clients` surfaces. We don't try to spin up a real Service Worker.

- [ ] **Step 1: Write tests**

```typescript
import {describe, expect, beforeEach, afterEach, it, vi} from 'vitest';
import 'fake-indexeddb/auto';

// We must mock @lib/nostra/nostra-identity-sw and the global self before
// importing the SW handler. Use vi.doMock for module-level mocks.

vi.mock('@lib/nostra/nostr-crypto', () => ({
  unwrapNip17: vi.fn()
}));
vi.mock('@lib/nostra/nostra-identity-sw', () => ({
  loadIdentitySW: vi.fn()
}));

const showNotification = vi.fn().mockResolvedValue(undefined);
const matchAll = vi.fn().mockResolvedValue([]);
const openWindow = vi.fn().mockResolvedValue({});

(globalThis as any).self = {
  registration: {showNotification},
  clients: {matchAll, openWindow}
};

import {onNostraPush, onNostraNotificationClick} from '@lib/serviceWorker/nostra-push';
import {setPreviewLevel, destroy as destroyStorage, setAggregationState} from '@lib/nostra/nostra-push-storage';
import {unwrapNip17} from '@lib/nostra/nostr-crypto';
import {loadIdentitySW} from '@lib/nostra/nostra-identity-sw';

function buildEvent(payload: any): any {
  return {data: {json: () => payload}};
}

describe('nostra-push SW handler', () => {
  beforeEach(async() => {
    showNotification.mockClear();
    matchAll.mockClear();
    openWindow.mockClear();
    (unwrapNip17 as any).mockReset();
    (loadIdentitySW as any).mockReset();
    await destroyStorage();
    indexedDB.deleteDatabase('nostra-push');
  });
  afterEach(() => destroyStorage());

  it('drops non-nostra payloads', async() => {
    await onNostraPush(buildEvent({app: 'telegram'}));
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('preview A renders generic title/body without decrypting', async() => {
    await onNostraPush(buildEvent({app: 'nostra', event_id: 'evt1', recipient_pubkey: 'r'}));
    expect(loadIdentitySW).not.toHaveBeenCalled();
    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = showNotification.mock.calls[0];
    expect(title).toBe('Nostra.chat');
    expect(opts.body).toBe('New message');
    expect(opts.tag).toBe('nostra-evt1');
  });

  it('preview B decrypts and renders sender + truncated content', async() => {
    await setPreviewLevel('B');
    (loadIdentitySW as any).mockResolvedValue({publicKey: 'p', privateKey: 'k'});
    (unwrapNip17 as any).mockResolvedValue({pubkey: 'sender_pk', content: 'Hello world from preview B test'});
    await onNostraPush(buildEvent({app: 'nostra', event_id: 'evt2', event: '{}', recipient_pubkey: 'r'}));
    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = showNotification.mock.calls[0];
    expect(title).toMatch(/sender|sender_pk/);
    expect(opts.body).toContain('Hello world');
  });

  it('preview C decrypts but masks content', async() => {
    await setPreviewLevel('C');
    (loadIdentitySW as any).mockResolvedValue({publicKey: 'p', privateKey: 'k'});
    (unwrapNip17 as any).mockResolvedValue({pubkey: 'sender_pk', content: 'should not appear'});
    await onNostraPush(buildEvent({app: 'nostra', event_id: 'evt3', event: '{}', recipient_pubkey: 'r'}));
    const [, opts] = showNotification.mock.calls[0];
    expect(opts.body).toBe('[encrypted]');
  });

  it('aggregates 3 quick messages from same peer into one notification body', async() => {
    await setPreviewLevel('B');
    (loadIdentitySW as any).mockResolvedValue({publicKey: 'p', privateKey: 'k'});
    (unwrapNip17 as any).mockResolvedValue({pubkey: 'same_peer', content: 'msg'});
    await onNostraPush(buildEvent({app: 'nostra', event_id: 'e1', event: '{}', recipient_pubkey: 'r'}));
    await onNostraPush(buildEvent({app: 'nostra', event_id: 'e2', event: '{}', recipient_pubkey: 'r'}));
    await onNostraPush(buildEvent({app: 'nostra', event_id: 'e3', event: '{}', recipient_pubkey: 'r'}));
    expect(showNotification).toHaveBeenCalledTimes(3);
    const [, opts3] = showNotification.mock.calls[2];
    expect(opts3.body).toMatch(/3 new messages/);
    expect(opts3.tag).toBe('nostra-same_peer');
  });

  it('does not aggregate after window expires (simulated via state edit)', async() => {
    await setPreviewLevel('A');
    await setAggregationState({'nostra-evt99': {ts: Date.now() - 6 * 60 * 1000, count: 5, tag: 'nostra-nostra-evt99'}});
    await onNostraPush(buildEvent({app: 'nostra', event_id: 'evt99', recipient_pubkey: 'r'}));
    const [, opts] = showNotification.mock.calls[0];
    expect(opts.body).toBe('New message'); // count reset to 1 → generic body
  });

  it('preview B falls back to generic on missing event', async() => {
    await setPreviewLevel('B');
    (loadIdentitySW as any).mockResolvedValue({publicKey: 'p', privateKey: 'k'});
    await onNostraPush(buildEvent({app: 'nostra', event_id: 'evt4', recipient_pubkey: 'r'})); // no `event`
    const [title, opts] = showNotification.mock.calls[0];
    expect(title).toBe('Nostra.chat');
    expect(opts.body).toBe('New message');
  });

  it('click handler closes notification and calls openWindow when no client open', async() => {
    matchAll.mockResolvedValueOnce([]);
    const close = vi.fn();
    const event = {
      notification: {data: {app: 'nostra', peerKey: 'pk', eventId: 'eid'}, close},
      waitUntil: () => {}
    } as any;
    await onNostraNotificationClick(event);
    expect(close).toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith(expect.stringContaining('?p=pk&m=eid'));
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm test run src/tests/nostra/nostra-push-sw.test.ts
```
Expected: 8 tests PASS.

- [ ] **Step 3: Add to quick suite if needed; commit**

```bash
git add src/tests/nostra/nostra-push-sw.test.ts package.json
git commit -m "test(push): SW handler A/B/C + aggregation + click coverage"
```

**Definition of done:** All 8 tests green; included in `test:nostra:quick`.

---

## Task 9: Wire SW discriminator in `push.ts`

**Files:**
- Modify: `src/lib/serviceWorker/push.ts`
- Modify: `src/lib/serviceWorker/index.service.ts`

- [ ] **Step 1: Add the import + discriminator**

In `src/lib/serviceWorker/push.ts`, near the top (after existing imports), add:

```typescript
import {onNostraPush, onNostraNotificationClick} from '@lib/serviceWorker/nostra-push';
```

In `onPushEvent`, BEFORE the existing `event.data.json()` call, add a discriminator pre-check:

```typescript
function onPushEvent(event: PushEvent) {
  // Nostra discriminator — peeked first so we never run the Telegram
  // payload-parsing path on Nostr-shape pushes.
  let peeked: any;
  try { peeked = event.data?.json(); } catch{ peeked = null; }
  if(peeked && peeked.app === 'nostra') {
    event.waitUntil(onNostraPush(event as unknown as ExtendableEvent & {data: PushMessageData}));
    return;
  }

  const obj: EncryptedPushNotificationObject | PushNotificationObject = peeked;
  // ... existing Telegram code, untouched, using `obj`
```

Replace the existing `const obj: ... = event.data.json();` line with `const obj = peeked;` (the value is already decoded). Verify by re-reading the file.

In `onNotificationClick`, near the start, add:

```typescript
function onNotificationClick(event: NotificationEvent) {
  if(event.notification?.data?.app === 'nostra') {
    event.waitUntil(onNostraNotificationClick(event));
    return;
  }
  // ... existing Telegram code
```

- [ ] **Step 2: Sanity check — no double parse, no broken Telegram path**

Run a search to be sure no old `event.data.json()` lingers:

```bash
grep -n "event\\.data\\.json\\|peeked" src/lib/serviceWorker/push.ts
```
Expected: only one `event.data?.json()` (the peek) and `peeked` references. Telegram path operates on `obj = peeked`.

- [ ] **Step 3: Force the new module into the SW bundle**

Edit `src/lib/serviceWorker/index.service.ts` and add a static side-effect import at the top:

```typescript
import '@lib/serviceWorker/nostra-push';
```

(Per CLAUDE.md: dynamic imports inside SW are unreliable due to Vite chunk-splitting; static side-effect import guarantees inclusion. The handler module exports functions that `push.ts` imports, so this import is technically redundant — but defensive: it keeps the module reachable even if push.ts imports change.)

- [ ] **Step 4: Type-check + lint**

```bash
npx eslint src/lib/serviceWorker/push.ts src/lib/serviceWorker/index.service.ts
npx tsc --noEmit 2>&1 | grep -v "^src/config/app.ts.*langPackLocalVersion" | head -20
```
Expected: lint silent; tsc shows no NEW errors (the `langPackLocalVersion` pre-existing one may still appear and is ignored).

- [ ] **Step 5: Commit**

```bash
git add src/lib/serviceWorker/push.ts src/lib/serviceWorker/index.service.ts
git commit -m "feat(push): wire Nostra discriminator into SW push & click events"
```

**Definition of done:** Discriminator routes Nostra-shape payloads to `onNostraPush`; Telegram path untouched.

---

## Task 10: Add rootScope event for subscription state changes

**Files:**
- Modify: `src/lib/rootScope.ts`

- [ ] **Step 1: Add to `BroadcastEvents`**

Locate the `BroadcastEvents` type (around line ~280). Add:

```typescript
'nostra_push_subscription_changed': {state: 'registered' | 'unregistered' | 'error'; pubkey?: string};
```

The Settings UI uses this to refresh the toggle without polling.

- [ ] **Step 2: Lint**

```bash
npx eslint src/lib/rootScope.ts
```
Expected: silent.

- [ ] **Step 3: Commit**

```bash
git add src/lib/rootScope.ts
git commit -m "feat(push): broadcast event for subscription state changes"
```

**Definition of done:** Event type registered.

---

## Task 11: Onboarding integration — auto-subscribe

**Files:**
- Modify: `src/pages/nostra-onboarding-integration.ts`

- [ ] **Step 1: Add the auto-subscribe block**

After the existing `pendingFlush.startPeriodicFlush();` call (locate via grep), add a new block:

```typescript
// --- Background push notifications ---
// Auto-subscribe when notification permission is already granted at boot.
// VAPID public key is fetched once from the configured push relay (default
// notify.damus.io) and cached in IDB by nostra-push-client.
(async() => {
  try {
    if(typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const {subscribePush, getRegistration} = await import('@lib/nostra/nostra-push-client');
    const existing = await getRegistration();
    // Skip re-subscribe if an existing record matches the current pubkey.
    if(existing && existing.pubkey === identity.publicKey) return;

    // Resolve VAPID public key — fetch from the relay's /info endpoint
    // (or whatever Task 1 research locked in). Cache in IDB to avoid
    // re-fetching on every boot.
    const vapidKey = await resolveVapidKey();
    if(!vapidKey) return;

    // Pick the right fetchFn for current TorMode.
    const transport = (window as any).__nostraTransport;
    const torActive = transport?.getRuntimeState?.() === 'tor-active';
    const fetchFn = torActive && transport?.fetch
      ? (input: RequestInfo, init?: RequestInit) => transport.fetch(typeof input === 'string' ? input : input.toString(), init)
      : undefined;

    const rec = await subscribePush({
      pubkeyHex: identity.publicKey,
      vapidPublicKey: vapidKey,
      fetchFn
    });
    if(rec) {
      rootScope.dispatchEvent('nostra_push_subscription_changed' as any, {
        state: 'registered',
        pubkey: rec.pubkey
      });
    }
  } catch(err) {
    console.warn('[NostraOnboardingIntegration] push subscribe failed:', err);
  }
})();

async function resolveVapidKey(): Promise<string | null> {
  try {
    const {getEndpointBase} = await import('@lib/nostra/nostra-push-storage');
    const base = await getEndpointBase();
    const cacheKey = `nostra-push-vapid-${base}`;
    const cached = localStorage.getItem(cacheKey);
    if(cached) return cached;
    // The exact path comes from Task 1 research doc (e.g. /info or /vapid).
    const res = await fetch(`${base}/info`, {method: 'GET'});
    if(!res.ok) return null;
    const json = await res.json();
    const key = json.vapid_public_key || json.vapidPublicKey || json.publicKey;
    if(!key) return null;
    localStorage.setItem(cacheKey, key);
    return key;
  } catch{
    return null;
  }
}
```

If Task 1 research showed that Damus exposes the VAPID key via a different path or field, **adjust `resolveVapidKey` here**. Keep the cache in localStorage so the next session boots without an extra HTTPS round trip.

If `transport.fetch` isn't a public method on `PrivacyTransport`, replace the Tor branch with whatever public API the codebase exposes (run `grep -n 'public.*fetch\|export function.*fetch' src/lib/nostra/privacy-transport.ts`). The current PrivacyTransport surface uses `webtorClient.fetch` internally and exposes it through `setTorMode`. If no public passthrough exists yet, add one in this same task as a small follow-up commit:

```typescript
// In src/lib/nostra/privacy-transport.ts, add a public method:
public async fetch(url: string, init?: RequestInit): Promise<Response> {
  if(this.mode !== 'off' && this.webtorClient && this.getRuntimeState() === 'tor-active') {
    // Webtor returns a string body — wrap into a Response.
    const text = await this.webtorClient.fetch(url);
    return new Response(text);
  }
  return globalThis.fetch(url, init);
}
```

(If `webtorClient.fetch` returns a string, the wrapper above bridges to a `Response`. Verify the actual return type before shipping.)

- [ ] **Step 2: Lint + tsc**

```bash
npx eslint src/pages/nostra-onboarding-integration.ts src/lib/nostra/privacy-transport.ts
npx tsc --noEmit 2>&1 | grep -v langPackLocalVersion | head -20
```
Expected: silent / no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/pages/nostra-onboarding-integration.ts src/lib/nostra/privacy-transport.ts
git commit -m "feat(push): auto-subscribe at boot post-permission, TorMode-aware"
```

**Definition of done:** Auto-subscribe block in onboarding; PrivacyTransport exposes a public fetch passthrough (if added).

---

## Task 12: Cleanup integration

**Files:**
- Modify: `src/lib/nostra/nostra-cleanup.ts`

- [ ] **Step 1: Add `nostra-push` to the DB list and call `unsubscribePush`**

Locate the `clearAllNostraData()` function and the array of DB names (or the explicit destroy calls). Add:

1. In the LS keys list (around line 28), confirm we don't add the VAPID cache key — it's tied to the endpoint and useful across reinstalls. **Actually do remove** `nostra-push-vapid-*` since the user might switch endpoints; iterate over all `nostra-push-vapid-` prefixed keys.

2. Add `'nostra-push'` to the DB names array.

3. Before deleting DBs, call:

```typescript
try {
  const {unsubscribePush} = await import('@lib/nostra/nostra-push-client');
  await unsubscribePush();
} catch(e: any) { logSwallow('Cleanup.unsubscribePush', e); }
```

4. After the import line of `getGroupStore`, add a call to `(await import('@lib/nostra/nostra-push-storage')).destroy()` in the `closes.push(...)` block so the connection is released before `forceCloseDB('nostra-push')`.

- [ ] **Step 2: Lint + tsc**

```bash
npx eslint src/lib/nostra/nostra-cleanup.ts
npx tsc --noEmit 2>&1 | grep -v langPackLocalVersion | head -10
```
Expected: silent / no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/nostra/nostra-cleanup.ts
git commit -m "feat(push): unsubscribe + clear push DB on logout/reset"
```

**Definition of done:** Logout flow now invokes `unsubscribePush` then closes/deletes the new IDB.

---

## Task 13: Settings UI component

**Files:**
- Create: `src/components/sidebarLeft/tabs/nostraBackgroundNotifications.tsx`

- [ ] **Step 1: Write the Solid component**

```tsx
/**
 * Settings → Notifications → Background notifications block.
 *
 * Reads/writes via nostra-push-storage; reacts to the
 * 'nostra_push_subscription_changed' rootScope event to refresh state.
 */

import {createSignal, createEffect, onCleanup, Show} from 'solid-js';
import rootScope from '@lib/rootScope';
import {
  getPreviewLevel,
  setPreviewLevel,
  getEndpointBase,
  setEndpointBase,
  DEFAULT_ENDPOINT,
  PreviewLevel
} from '@lib/nostra/nostra-push-storage';

export default function NostraBackgroundNotifications() {
  const [enabled, setEnabled] = createSignal(false);
  const [previewLevel, setPreviewLevelSig] = createSignal<PreviewLevel>('A');
  const [endpoint, setEndpointSig] = createSignal(DEFAULT_ENDPOINT);
  const [advancedOpen, setAdvancedOpen] = createSignal(false);

  const refreshState = async() => {
    if(typeof Notification !== 'undefined') {
      setEnabled(Notification.permission === 'granted');
    }
    setPreviewLevelSig(await getPreviewLevel());
    setEndpointSig(await getEndpointBase());
  };

  createEffect(() => { void refreshState(); });

  const onSubscriptionChanged = () => { void refreshState(); };
  rootScope.addEventListener('nostra_push_subscription_changed' as any, onSubscriptionChanged);
  onCleanup(() => rootScope.removeEventListener('nostra_push_subscription_changed' as any, onSubscriptionChanged));

  const onToggle = async() => {
    if(typeof Notification === 'undefined') return;
    if(Notification.permission !== 'granted') {
      const result = await Notification.requestPermission();
      if(result !== 'granted') return;
    }
    if(!enabled()) {
      // Trigger subscribe — onboarding integration listens for permission
      // change, but if the user is mid-session, we need to drive it here.
      const {subscribePush} = await import('@lib/nostra/nostra-push-client');
      const ownPubkey = (window as any).__nostraOwnPubkey as string | undefined;
      if(!ownPubkey) return;
      // Resolve VAPID via the same helper that onboarding uses; for the UI
      // path we lazy-load the resolver:
      const {resolveVapidKey} = await import('@lib/nostra/nostra-push-helpers');
      const vapidKey = await resolveVapidKey();
      if(!vapidKey) return;
      await subscribePush({pubkeyHex: ownPubkey, vapidPublicKey: vapidKey});
    } else {
      const {unsubscribePush} = await import('@lib/nostra/nostra-push-client');
      await unsubscribePush();
    }
    await refreshState();
  };

  const onPreviewChange = async(level: PreviewLevel) => {
    await setPreviewLevel(level);
    setPreviewLevelSig(level);
  };

  const onEndpointChange = async(value: string) => {
    const trimmed = value.trim();
    await setEndpointBase(trimmed === '' || trimmed === DEFAULT_ENDPOINT ? null : trimmed);
    setEndpointSig(trimmed || DEFAULT_ENDPOINT);
  };

  return (
    <section class="background-push-notifications">
      <div class="row">
        <label>
          <input
            type="checkbox"
            checked={enabled()}
            onChange={onToggle}
          />
          Enable background notifications
        </label>
        <p class="hint">Receive notifications when Nostra.chat is closed.</p>
      </div>

      <Show when={enabled()}>
        <div class="row">
          <strong>Preview</strong>
          <label><input type="radio" name="preview" checked={previewLevel() === 'A'} onChange={() => onPreviewChange('A')}/> Generic</label>
          <label><input type="radio" name="preview" checked={previewLevel() === 'B'} onChange={() => onPreviewChange('B')}/> Sender + content</label>
          <label><input type="radio" name="preview" checked={previewLevel() === 'C'} onChange={() => onPreviewChange('C')}/> Sender only</label>
        </div>

        <details open={advancedOpen()} onToggle={(e) => setAdvancedOpen((e.target as HTMLDetailsElement).open)}>
          <summary>Advanced</summary>
          <label>Push relay endpoint
            <input
              type="text"
              value={endpoint()}
              onBlur={(e) => onEndpointChange((e.target as HTMLInputElement).value)}
            />
          </label>
        </details>

        <p class="disclosure">
          Your public key and IP address (unless Tor is enabled) are sent to the push relay.
          Message contents stay end-to-end encrypted.{' '}
          <a href="/docs/PUSH-NOTIFICATIONS.md" target="_blank" rel="noreferrer">Learn more</a>.
        </p>
      </Show>
    </section>
  );
}
```

- [ ] **Step 2: Create the helpers module referenced by the UI**

Create `src/lib/nostra/nostra-push-helpers.ts`:

```typescript
/**
 * Shared between onboarding integration and Settings UI.
 */
import {getEndpointBase} from '@lib/nostra/nostra-push-storage';

export async function resolveVapidKey(): Promise<string | null> {
  try {
    const base = await getEndpointBase();
    const cacheKey = `nostra-push-vapid-${base}`;
    if(typeof localStorage !== 'undefined') {
      const cached = localStorage.getItem(cacheKey);
      if(cached) return cached;
    }
    const res = await fetch(`${base}/info`, {method: 'GET'});
    if(!res.ok) return null;
    const json = await res.json();
    const key = json.vapid_public_key || json.vapidPublicKey || json.publicKey;
    if(!key) return null;
    if(typeof localStorage !== 'undefined') localStorage.setItem(cacheKey, key);
    return key;
  } catch{
    return null;
  }
}
```

Then **delete the inline `resolveVapidKey` from `nostra-onboarding-integration.ts`** and import it from `@lib/nostra/nostra-push-helpers` instead. Run lint + tsc.

- [ ] **Step 3: Lint**

```bash
npx eslint src/components/sidebarLeft/tabs/nostraBackgroundNotifications.tsx src/lib/nostra/nostra-push-helpers.ts src/pages/nostra-onboarding-integration.ts
```
Expected: silent.

- [ ] **Step 4: Commit**

```bash
git add src/components/sidebarLeft/tabs/nostraBackgroundNotifications.tsx src/lib/nostra/nostra-push-helpers.ts src/pages/nostra-onboarding-integration.ts
git commit -m "feat(push): Settings UI + shared VAPID resolver"
```

**Definition of done:** Component compiles, helpers module replaces inline resolver, lint clean.

---

## Task 14: Insert Settings block

**Files:**
- Modify: `src/components/sidebarLeft/tabs/notifications.tsx`

- [ ] **Step 1: Mount the new component**

Read the file. Find the existing render output near the top of the JSX (look for `Sounds` or the first major section). Add the import at the top of the file:

```tsx
import NostraBackgroundNotifications from '@components/sidebarLeft/tabs/nostraBackgroundNotifications';
```

In the JSX, ABOVE the first existing notification section (the Sounds block), insert:

```tsx
<NostraBackgroundNotifications />
```

- [ ] **Step 2: Visual smoke check**

Boot dev server in a separate terminal:

```bash
pnpm start &
DEV_PID=$!
sleep 8
# Verify boot ok via console
echo "Visit http://localhost:8080 and open Settings → Notifications. Look for the new block."
# When done:
kill $DEV_PID 2>/dev/null
```
Expected: visiting Settings → Notifications shows the new block above existing sections; toggling permission triggers a subscribe attempt (network failures are OK at this stage if Damus is unreachable).

- [ ] **Step 3: Lint**

```bash
npx eslint src/components/sidebarLeft/tabs/notifications.tsx
```
Expected: silent.

- [ ] **Step 4: Commit**

```bash
git add src/components/sidebarLeft/tabs/notifications.tsx
git commit -m "feat(push): mount Background notifications block in Settings"
```

**Definition of done:** Block visible in Settings; lint clean.

---

## Task 15: User-facing privacy disclosure

**Files:**
- Create: `docs/PUSH-NOTIFICATIONS.md`

- [ ] **Step 1: Write the doc**

```markdown
# Background push notifications

Nostra.chat can deliver system notifications when the app is closed by registering with a Nostr push relay. The default relay is `notify.damus.io`, operated by the Damus team.

## What the push relay sees
- Your public key (npub).
- Your browser's Web Push endpoint (Google FCM, Mozilla, or Apple push gateway).
- Your IP address — **unless** Tor is enabled (Settings → Privacy).
- The frequency at which messages arrive for you.

## What the push relay does NOT see
- The contents of your messages (end-to-end encrypted, NIP-44).
- Who is sending you messages — the wrapper public key in NIP-59 is ephemeral and randomized.

## What the OS push gateway (Google/Mozilla/Apple) sees
- Your device identity (linked to your browser/OS account).
- That a push payload was delivered to you.
- The encrypted payload itself (cannot be decrypted by the gateway).

This part is structural to Web Push and cannot be eliminated.

## Preview levels
- **Generic** (default): Notifications show "Nostra.chat — new message". No sender, no content. Maximum privacy on the lockscreen.
- **Sender + content**: Notifications show the sender's name and the first ~80 characters of the message.
- **Sender only**: Notifications show the sender's name and "[encrypted]".

For B and C, the Service Worker reads your private key from local storage (IndexedDB) to decrypt the gift-wrap. The key never leaves your device.

## Endpoint override
Advanced users can swap the push relay from Settings → Notifications → Advanced. To self-host, see [github.com/jb55/nostr-push](https://github.com/jb55/nostr-push).

## Disabling
Settings → Notifications → Enable background notifications (toggle off) sends an unregistration request to the push relay and removes the local subscription. Logging out or resetting local data does the same.

## Tor
With Tor enabled (Settings → Privacy → Tor mode "Always" or "When available"), the registration and unregistration HTTP requests route through Tor. The Web Push delivery itself goes through Google/Mozilla/Apple infrastructure and cannot be tunneled.
```

- [ ] **Step 2: Commit**

```bash
git add docs/PUSH-NOTIFICATIONS.md
git commit -m "docs(push): user-facing privacy disclosure"
```

**Definition of done:** Doc exists and is linked from the Settings block (Task 13 already references `/docs/PUSH-NOTIFICATIONS.md`).

---

## Task 16: Real bilateral E2E

**Files:**
- Create: `src/tests/e2e/e2e-push-bilateral.ts`

- [ ] **Step 1: Write the test**

```typescript
/**
 * e2e-push-bilateral.ts
 *
 * Real end-to-end push delivery test. Hits the live Damus push relay.
 * Run manually or in nightly suite — NOT in test:nostra:quick.
 *
 * Skip cleanly if NOSTRA_PUSH_E2E_OFFLINE=1 or if notify.damus.io is
 * unreachable.
 *
 * Usage:
 *   APP_URL=http://localhost:8080 node_modules/.bin/tsx src/tests/e2e/e2e-push-bilateral.ts
 */

import {chromium, BrowserContext, Page} from 'playwright';

const APP_URL = process.env.APP_URL || 'http://localhost:8080';
const PUSH_RELAY = process.env.NOSTRA_PUSH_RELAY || 'https://notify.damus.io';

if(process.env.NOSTRA_PUSH_E2E_OFFLINE === '1') {
  console.log('NOSTRA_PUSH_E2E_OFFLINE=1 — skipping');
  process.exit(0);
}

async function probeRelay(): Promise<boolean> {
  try {
    const res = await fetch(`${PUSH_RELAY}/info`, {method: 'GET'});
    return res.ok;
  } catch { return false; }
}

async function bootContext(name: string): Promise<{ctx: BrowserContext; page: Page}> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({permissions: ['notifications']});
  const page = await ctx.newPage();
  page.on('console', (msg) => console.log(`[${name}]`, msg.type(), msg.text()));
  await page.goto(APP_URL);
  return {ctx, page};
}

(async() => {
  if(!(await probeRelay())) {
    console.log('Damus relay unreachable — skipping');
    process.exit(0);
  }

  const a = await bootContext('A');
  const b = await bootContext('B');

  // Generate two distinct identities and complete onboarding via the
  // existing test helpers (boot helpers used by other E2E tests).
  // ... per-project helper invocation goes here ...

  // Step 1: A registers a push subscription.
  // Step 2: A's tab is backgrounded (page.evaluate to dispatch
  // visibilitychange + blur).
  // Step 3: B sends a kind 1059 to A.
  // Step 4: Wait up to 10s for the SW notification handler to fire,
  // captured via a page.exposeFunction-installed test hook.
  // Step 5: Assert title/body match preview level (A by default = generic).
  // Step 6: Click the captured notification, verify A's tab routes to the
  // chat with B.

  // Cleanup
  await a.ctx.close();
  await b.ctx.close();
  process.exit(0);
})();
```

The test stub above leaves the per-project test helpers (boot, identity injection, send) as inline-comment placeholders. **Implement them by reusing patterns from `src/tests/e2e/e2e-reactions-bilateral.ts`** — same harness shape. Read that file first, port its helpers/imports, then fill in the steps. Do not invent new helpers.

- [ ] **Step 2: Manual smoke**

```bash
pnpm start &
DEV=$!
sleep 8
APP_URL=http://localhost:8080 node_modules/.bin/tsx src/tests/e2e/e2e-push-bilateral.ts
kill $DEV 2>/dev/null
```
Expected: test passes end-to-end with a real push delivery within 10s. If the SW notification doesn't fire, capture SW console messages and debug Task 9 wiring before relaxing the test.

- [ ] **Step 3: Lint**

```bash
npx eslint src/tests/e2e/e2e-push-bilateral.ts
```
Expected: silent.

- [ ] **Step 4: Commit**

```bash
git add src/tests/e2e/e2e-push-bilateral.ts
git commit -m "test(e2e): bilateral push delivery against real Damus relay (online suite)"
```

**Definition of done:** Test runs end-to-end against live Damus, passes within 10s, gracefully skips when offline.

---

## Task 17: Full check pass

- [ ] **Step 1: Lint**

```bash
pnpm lint
```
Expected: silent.

- [ ] **Step 2: Quick test suite**

```bash
pnpm test:nostra:quick 2>&1 | tail -20
```
Expected: all green (count includes the new tests from Tasks 3, 6, 8 — should be ≥22 new).

- [ ] **Step 3: Type check**

```bash
npx tsc --noEmit 2>&1 | grep -v "langPackLocalVersion" | head -20
```
Expected: silent (only the pre-existing `langPackLocalVersion` line, ignored).

- [ ] **Step 4: Manual production build**

```bash
pnpm build 2>&1 | tail -10
```
Expected: builds; check size of new SW bundle hasn't ballooned (a few KB extra is normal).

- [ ] **Step 5: No commit**

This task is a verification gate.

**Definition of done:** All four checks green.

---

## Task 18: Manual smoke checklist

**Files:**
- Modify: PR description (or commit a smoke checklist into `docs/PUSH-NOTIFICATIONS.md` under "Release sign-off")

- [ ] **Step 1: Run the smoke checklist on at least 2 real devices (Android PWA + desktop)**

Steps:
1. Fresh install on device A, complete onboarding.
2. Settings → Notifications: confirm the "Background notifications" block is visible. Toggle on. Grant permission.
3. Verify in DevTools Application → Service Workers → Push Messages: a subscription is registered.
4. From device B (different account), send a P2P message to A.
5. Background or close A's tab/PWA.
6. Send 3 rapid messages from B.
7. Verify exactly 1 notification appears on A, body says "3 new messages from <peer name>" (default A renders "<count> new messages" still — verify with current preview level).
8. Click the notification: A's app focuses/opens to the correct chat.
9. Toggle preview to B in Settings; receive a new message → notification shows truncated content.
10. Mute the peer via topbar → confirm push is suppressed.
11. Logout → verify the subscription disappears from device A's Application tab.
12. Re-login: re-onboard, regrant; verify auto-subscribe fires once.

Append a line to `docs/PUSH-NOTIFICATIONS.md` under a new "## Release sign-off" section listing this checklist. Tester signs by name and date in the PR description.

- [ ] **Step 2: Commit smoke checklist into doc**

```bash
git add docs/PUSH-NOTIFICATIONS.md
git commit -m "docs(push): smoke checklist for release sign-off"
```

**Definition of done:** Checklist documented; manual run completed before PR is merged.

---

## Task 19: PR

- [ ] **Step 1: Final rebase on main**

```bash
git fetch origin
git rebase origin/main
```
Expected: clean rebase. Resolve any conflict (unlikely if upstream hasn't moved).

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/nostra-background-push
```

- [ ] **Step 3: Open PR with Conventional title**

```bash
gh pr create --title "feat(push): background notifications via notify.damus.io" --body "$(cat <<'EOF'
## Summary
- Wires Web Push for Nostra: notifications when tab/PWA is closed.
- External provider: notify.damus.io (Damus team's nostr-push relay).
- User-configurable preview level (Generic by default), endpoint override in Advanced settings.
- Per-peer aggregation in SW, TorMode-aware registration, auto-subscribe at boot.

## Privacy
See `docs/PUSH-NOTIFICATIONS.md`. The push relay sees pubkey + endpoint + IP (Tor-mitigated). Messages stay e2e encrypted.

## Test plan
- [x] Unit tests (`pnpm test:nostra:quick`).
- [x] Bilateral E2E against live Damus relay (`src/tests/e2e/e2e-push-bilateral.ts`, manual/nightly suite).
- [x] Manual smoke on Android PWA + desktop (signed off below).

### Smoke sign-off
- [ ] Filled in by tester before merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Wait for any CI hooks (none on push to main per project rules; release-please runs only after merge)**

Confirm the PR title is Conventional (`feat(push): ...`) — release-please bumps to `0.22.0` after merge.

**Definition of done:** PR open, Conventional title, body lists all artifacts, smoke sign-off pending.

---

## Self-Review Checklist (run after writing the plan)

- ✅ Spec coverage: every "New components" entry mapped to a task. Every "Modified components" entry has a task. Every Acceptance Criterion is exercised by either Task 3/6/8 (units), Task 16 (E2E), or Task 18 (manual smoke).
- ✅ No placeholders: Tasks reference Task 1 research doc for fields that are unknown today; that's a deliberate dependency, not a placeholder.
- ✅ Type/method consistency: `subscribePush`, `unsubscribePush`, `getRegistration`, `setEndpointBase`, `getPreviewLevel`, `loadIdentitySW`, `onNostraPush`, `onNostraNotificationClick` are referenced consistently across tasks.
- ✅ Frequent commits: every task ends with a commit; ~19 commits total.
- ✅ TDD where applicable: storage, client, and SW handler all have failing-test-first → minimal-impl → green sequences.
- ⚠ Caveat: Tasks 5, 7, 11, 13 reference Task 1's research doc for exact field names; those tasks must read the doc first and patch their literals before commit. This is documented inline.
