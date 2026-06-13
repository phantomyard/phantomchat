# Bug Fuzzer Phase 2b.1 Implementation Plan — reactions NIP-25 + stabilization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship NIP-25 reactions RX bilaterale (publish + receive + remove + multi-emoji + aggregation), chiudere i 5 FIND aperti da Phase 2a overnight (incluse 2 crash tweb `reaction.ts`), committare baseline v2b1, triple gate.

**Architecture:** 3 nuovi moduli Nostra (`nostra-reactions-store.ts` IDB-backed, `nostra-reactions-publish.ts` kind-7 publisher, `nostra-reactions-receive.ts` subscriber con out-of-order buffer). Relay subscription `{kinds: [1059, 7, 5], '#p': [ownPubkey]}` in `chat-api.ts`. Fix chirurgico guard mancanti in `reaction.ts` (con feature-flag fallback). Fuzz: 3 nuove invariants RX + 2 nuove actions + 3 postconditions. `nostra-reactions-local.ts` (sender-only Phase 2a) diventa shim sopra il nuovo store.

**Tech Stack:** TypeScript (`// @ts-nocheck` per file fuzz), Vitest + fake-indexeddb per store tests, Playwright per fuzz runtime, `nostr-tools` per event signing, `ChatAPI.publishEvent` per relay fanout.

**Spec:** [`docs/superpowers/specs/2026-04-19-bug-fuzzer-phase-2b-design.md`](../specs/2026-04-19-bug-fuzzer-phase-2b-design.md) §1-2, §4, §5 (2b.1 scope).

---

## File Structure

| File | Role | Change |
|---|---|---|
| `src/lib/nostra/nostra-reactions-store.ts` | Reactions store (IDB-backed `nostra-reactions`) | Create |
| `src/lib/nostra/nostra-reactions-publish.ts` | Publish kind-7 / kind-5 | Create |
| `src/lib/nostra/nostra-reactions-receive.ts` | Subscribe kind-7 / kind-5, out-of-order buffer | Create |
| `src/lib/nostra/nostra-reactions-local.ts` | Legacy sender-only shim (Phase 2a) | Modify — delegate al nuovo store |
| `src/lib/nostra/chat-api.ts` | ChatAPI orchestrator | Modify — extend subscription + route kind-7/5 |
| `src/lib/nostra/nostr-relay.ts` | Relay connection | Modify — subscription filter kinds list |
| `src/lib/nostra/virtual-mtproto-server.ts` | VMT bridge | Modify — add `messages.sendReaction` handler |
| `src/lib/appManagers/apiManager.ts` | MTProto intercept | Modify — `messages.sendReaction` in `NOSTRA_BRIDGE_METHODS` |
| `src/lib/appManagers/appReactionsManager.ts` | Tweb reactions manager | Modify — P2P shortcut in `sendReaction` |
| `src/components/chat/reaction.ts` | Tweb reaction renderer | Modify — guard `availableReaction` access sites + Nostra feature flag fallback |
| `src/lib/nostra/nostra-cleanup.ts` | IDB cleanup | Modify — add `nostra-reactions` DB |
| `src/tests/nostra/nostra-reactions-store.test.ts` | Store unit test | Create |
| `src/tests/nostra/nostra-reactions-publish.test.ts` | Publish unit test | Create |
| `src/tests/nostra/nostra-reactions-receive.test.ts` | Receive unit test | Create |
| `src/tests/nostra/reactions-nip25.test.ts` | E2E publish+receive+remove | Create |
| `src/tests/nostra/reactions-local.test.ts` | Extend existing Phase 2a test | Modify |
| `src/tests/nostra/reaction-guard.test.ts` | Tweb guard regression test | Create |
| `src/tests/fuzz/actions/messaging.ts` | Fuzz actions | Modify — extend `reactToRandomBubble`; add `removeReaction`, `reactMultipleEmoji` |
| `src/tests/fuzz/actions/index.ts` | Action registry | Modify — register 2 new actions |
| `src/tests/fuzz/invariants/reactions.ts` | Reactions invariants (5) | Create |
| `src/tests/fuzz/invariants/reactions.test.ts` | Reactions invariants unit | Create |
| `src/tests/fuzz/invariants/index.ts` | Invariant registry | Modify — register 5 new invariants |
| `src/tests/fuzz/postconditions/messaging.ts` | Messaging postconditions | Modify — add 3 new postconditions |
| `src/tests/fuzz/postconditions/index.ts` | Postcondition map | Modify — register 3 new postconditions |
| `src/tests/fuzz/replay.ts` | Replay loader | Modify — prefer latest `v2bN.json` baseline |
| `src/tests/fuzz/fuzz.ts` | Main loop | Modify — update `fuzzerVersion` bump to `phase2b1` |
| `docs/fuzz-baseline/baseline-seed42.json` | v2a baseline | Delete |
| `docs/fuzz-baseline/baseline-seed42-v2b1.json` | v2b1 baseline | Create (generated) |
| `docs/fuzz-reports/FIND-9df3527d/README.md` | Triage report | Create |
| `docs/fuzz-reports/FIND-f7b0117c/README.md` | Triage report | Create |
| `docs/fuzz-reports/FIND-2f61ff8b/README.md` | Triage report | Create |
| `docs/fuzz-reports/FIND-2fda8762/README.md` | Triage + fix report | Create |
| `docs/fuzz-reports/FIND-7fd7bc72/README.md` | Triage + fix report | Create |
| `docs/FUZZ-FINDINGS.md` | Findings index | Modify — close/reclassify 5 |
| `docs/VERIFICATION_2B1.md` | Manual 2-device checklist | Create |
| `CLAUDE.md` | Project guide | Modify — add Phase 2b.1 section (~8 righe) |

---

## Task 1: Pre-flight — replay 5 open FINDs

**Files:**
- No code changes. Output: 5 triage files created/updated.

Context for engineer: Before touching code, verify which of the 5 findings from Phase 2a overnight reproduce on post-2a `main`. Some may be stale (already fixed by commit `633aed78`). This task produces the status artifacts that later tasks reference.

- [ ] **Step 1: Start a fresh dev server terminal**

Run in one terminal (keep it running):
```bash
pnpm start
```
Wait until it logs `Local: http://localhost:8080`.

- [ ] **Step 2: Replay FIND-9df3527d (trailing-space "y ")**

In a separate terminal:
```bash
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --replay=FIND-9df3527d 2>&1 | tail -20
```
Expected: either `[replay] all steps passed — bug not reproduced` (stale — fixed in 2a) OR POST fail output (reproduces).

- [ ] **Step 3: Replay FIND-f7b0117c (sibling to 9df3527d)**

```bash
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --replay=FIND-f7b0117c 2>&1 | tail -20
```
Expected: similar outcome to 9df3527d.

- [ ] **Step 4: Replay FIND-2f61ff8b (Solid createRoot leak)**

```bash
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --replay=FIND-2f61ff8b 2>&1 | tail -30
```
Expected: likely reproduces; note the final trace step.

- [ ] **Step 5: Replay FIND-2fda8762 (reaction.ts center_icon crash)**

```bash
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --replay=FIND-2fda8762 2>&1 | tail -30
```
Expected: likely reproduces with crash in `reaction.ts` around line 205 or similar. Capture the exact line number reported.

- [ ] **Step 6: Replay FIND-7fd7bc72 (wrapSticker crash)**

```bash
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --replay=FIND-7fd7bc72 2>&1 | tail -30
```
Expected: likely reproduces in `wrapSticker` at `sticker.ts:72`.

- [ ] **Step 7: Create triage README for FIND-9df3527d**

Create `docs/fuzz-reports/FIND-9df3527d/README.md`:

```markdown
# FIND-9df3527d — POST-sendText-bubble-appears ("y " trailing-space)

**Status**: <fixed-in-2a | reproduced>
**Phase 2a-closing commit (if applicable)**: `633aed78` (fix(fuzz): INV-sent-bubble-visible-after-send uses trimmed text)
**Phase 2b.1 decision**: <close-as-stale | fix-in-2b1-commit-<sha>>

## Original assertion

"sent bubble with text \"y \" never appeared on sender" — trailing whitespace
edge case. Post-commit 633aed78 the postcondition's bubble text query was
updated to trim before matching, which is the same trim the invariant
already applied.

## Replay outcome (post-2a main)

Ran `pnpm fuzz --replay=FIND-9df3527d` on <date>.
Result: <all steps passed — stale / reproduced at step N>
```

Fill in the `<...>` placeholders with the actual replay outcome.

- [ ] **Step 8: Create triage READMEs for FIND-f7b0117c, FIND-2f61ff8b, FIND-2fda8762, FIND-7fd7bc72**

Use the same template as Step 7. For each, record:
- Status
- Replay outcome
- For FIND-2fda8762 / FIND-7fd7bc72: **exact line number** from the error stack (e.g. `reaction.ts:205:33`). These lines drive Task 11.

- [ ] **Step 9: Commit triage artifacts**

```bash
git add docs/fuzz-reports/FIND-9df3527d/README.md \
        docs/fuzz-reports/FIND-f7b0117c/README.md \
        docs/fuzz-reports/FIND-2f61ff8b/README.md \
        docs/fuzz-reports/FIND-2fda8762/README.md \
        docs/fuzz-reports/FIND-7fd7bc72/README.md
git commit -m "docs(fuzz): triage 5 open FINDs from Phase 2a overnight run"
```

---

## Task 2: Create `nostra-reactions-store.ts` (IDB schema + CRUD)

**Files:**
- Create: `src/lib/nostra/nostra-reactions-store.ts`
- Modify: `src/lib/nostra/nostra-cleanup.ts`

Context: The store persists `kind-7` rows keyed by `(targetEventId, fromPubkey, emoji)` so aggregation counts survive reload. `reactionEventId` (the kind-7 `id`) is stored for later `kind-5` remove. Pattern mirrors `message-store.ts` — IDB `nostra-reactions`, one store `reactions`, two indexes (`targetEventId`, `fromPubkey`).

- [ ] **Step 1: Write the failing test**

Create `src/tests/nostra/nostra-reactions-store.test.ts`:

```ts
// @vitest-environment jsdom
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import 'fake-indexeddb/auto';

describe('nostra-reactions-store', () => {
  let store: any;
  beforeEach(async () => {
    vi.resetModules();
    // Fresh IDB per test.
    (globalThis as any).indexedDB.deleteDatabase('nostra-reactions');
    const mod = await import('@lib/nostra/nostra-reactions-store');
    store = mod.nostraReactionsStore;
    await store.init();
  });

  afterEach(async () => {
    await store.destroy?.();
  });

  it('add + get roundtrips a reaction row', async () => {
    const row = {
      targetEventId: 'evt123',
      targetMid: 12345,
      targetPeerId: 1e16,
      fromPubkey: 'pubABC',
      emoji: '👍',
      reactionEventId: 'r1',
      createdAt: 1000
    };
    await store.add(row);
    const got = await store.getByTarget('evt123');
    expect(got).toHaveLength(1);
    expect(got[0].emoji).toBe('👍');
    expect(got[0].reactionEventId).toBe('r1');
  });

  it('dedupes on (targetEventId, fromPubkey, emoji) compound key', async () => {
    const row = {
      targetEventId: 'evt1', targetMid: 1, targetPeerId: 1e16,
      fromPubkey: 'pub1', emoji: '👍', reactionEventId: 'r1', createdAt: 1
    };
    await store.add(row);
    await store.add({...row, reactionEventId: 'r2', createdAt: 2}); // same compound key
    const got = await store.getByTarget('evt1');
    expect(got).toHaveLength(1);
    expect(got[0].reactionEventId).toBe('r1'); // first-write-wins
  });

  it('keeps multi-emoji per user as distinct rows', async () => {
    const base = {
      targetEventId: 'evt1', targetMid: 1, targetPeerId: 1e16,
      fromPubkey: 'pub1', createdAt: 1
    };
    await store.add({...base, emoji: '👍', reactionEventId: 'r1'});
    await store.add({...base, emoji: '❤️', reactionEventId: 'r2'});
    const got = await store.getByTarget('evt1');
    expect(got.map((r: any) => r.emoji).sort()).toEqual(['❤️', '👍']);
  });

  it('removeByReactionEventId drops the matching row only', async () => {
    const base = {
      targetEventId: 'evt1', targetMid: 1, targetPeerId: 1e16,
      fromPubkey: 'pub1', createdAt: 1
    };
    await store.add({...base, emoji: '👍', reactionEventId: 'r1'});
    await store.add({...base, emoji: '❤️', reactionEventId: 'r2'});
    await store.removeByReactionEventId('r1');
    const got = await store.getByTarget('evt1');
    expect(got).toHaveLength(1);
    expect(got[0].emoji).toBe('❤️');
  });

  it('getByFromPubkey returns all rows for a pubkey', async () => {
    await store.add({
      targetEventId: 'evt1', targetMid: 1, targetPeerId: 1e16,
      fromPubkey: 'pub1', emoji: '👍', reactionEventId: 'r1', createdAt: 1
    });
    await store.add({
      targetEventId: 'evt2', targetMid: 2, targetPeerId: 1e16,
      fromPubkey: 'pub1', emoji: '❤️', reactionEventId: 'r2', createdAt: 2
    });
    const got = await store.getByFromPubkey('pub1');
    expect(got).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/tests/nostra/nostra-reactions-store.test.ts 2>&1 | tail -10
```
Expected: FAIL — `Cannot find module '@lib/nostra/nostra-reactions-store'`.

- [ ] **Step 3: Create the store implementation**

Create `src/lib/nostra/nostra-reactions-store.ts`:

```ts
/**
 * Persistent store for NIP-25 reaction rows.
 *
 * Rows are keyed by the compound (targetEventId, fromPubkey, emoji) so that
 * a user adding multiple emoji on the same target produces multiple distinct
 * rows, while duplicate same-emoji publishes (e.g. self-echo from relay) are
 * idempotent. Each row preserves the originating kind-7 `reactionEventId` so
 * a later kind-5 delete can target it.
 *
 * Schema — IDB `nostra-reactions`, store `reactions`:
 *   keyPath: 'compoundKey' (= `${targetEventId}|${fromPubkey}|${emoji}`)
 *   indexes: by targetEventId, by fromPubkey
 */

export interface ReactionRow {
  /** compoundKey = `${targetEventId}|${fromPubkey}|${emoji}` — IDB keyPath */
  compoundKey?: string;
  targetEventId: string;
  /** tweb message id (derived) of the target for downstream dispatch. */
  targetMid: number;
  /** peerId of the chat the target belongs to. */
  targetPeerId: number;
  fromPubkey: string;
  emoji: string;
  /** kind-7 event id — used by kind-5 delete to remove this reaction. */
  reactionEventId: string;
  createdAt: number;
}

const DB_NAME = 'nostra-reactions';
const STORE = 'reactions';
const DB_VERSION = 1;

class NostraReactionsStore {
  private db: IDBDatabase | null = null;

  async init(): Promise<void> {
    if(this.db) return;
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, {keyPath: 'compoundKey'});
          os.createIndex('byTarget', 'targetEventId', {unique: false});
          os.createIndex('byFromPubkey', 'fromPubkey', {unique: false});
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private compound(row: Pick<ReactionRow, 'targetEventId' | 'fromPubkey' | 'emoji'>): string {
    return `${row.targetEventId}|${row.fromPubkey}|${row.emoji}`;
  }

  async add(row: ReactionRow): Promise<void> {
    await this.init();
    const compoundKey = this.compound(row);
    const tx = this.db!.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    await new Promise<void>((resolve, reject) => {
      // First-write-wins: check existing before put.
      const getReq = os.get(compoundKey);
      getReq.onsuccess = () => {
        if(getReq.result) return resolve(); // idempotent
        const putReq = os.put({...row, compoundKey});
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async getByTarget(targetEventId: string): Promise<ReactionRow[]> {
    await this.init();
    const tx = this.db!.transaction(STORE, 'readonly');
    const os = tx.objectStore(STORE);
    const idx = os.index('byTarget');
    return new Promise<ReactionRow[]>((resolve, reject) => {
      const req = idx.getAll(targetEventId);
      req.onsuccess = () => resolve(req.result as ReactionRow[]);
      req.onerror = () => reject(req.error);
    });
  }

  async getByFromPubkey(fromPubkey: string): Promise<ReactionRow[]> {
    await this.init();
    const tx = this.db!.transaction(STORE, 'readonly');
    const os = tx.objectStore(STORE);
    const idx = os.index('byFromPubkey');
    return new Promise<ReactionRow[]>((resolve, reject) => {
      const req = idx.getAll(fromPubkey);
      req.onsuccess = () => resolve(req.result as ReactionRow[]);
      req.onerror = () => reject(req.error);
    });
  }

  async removeByReactionEventId(reactionEventId: string): Promise<void> {
    await this.init();
    const tx = this.db!.transaction(STORE, 'readwrite');
    const os = tx.objectStore(STORE);
    await new Promise<void>((resolve, reject) => {
      const req = os.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if(!cur) return resolve();
        if((cur.value as ReactionRow).reactionEventId === reactionEventId) {
          cur.delete();
        }
        cur.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(): Promise<ReactionRow[]> {
    await this.init();
    const tx = this.db!.transaction(STORE, 'readonly');
    const os = tx.objectStore(STORE);
    return new Promise<ReactionRow[]>((resolve, reject) => {
      const req = os.getAll();
      req.onsuccess = () => resolve(req.result as ReactionRow[]);
      req.onerror = () => reject(req.error);
    });
  }

  async destroy(): Promise<void> {
    this.db?.close();
    this.db = null;
  }
}

export const nostraReactionsStore = new NostraReactionsStore();

if(typeof window !== 'undefined') {
  (window as any).__nostraReactionsStore = nostraReactionsStore;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/tests/nostra/nostra-reactions-store.test.ts 2>&1 | tail -10
```
Expected: all 5 tests PASS.

- [ ] **Step 5: Add the DB to `nostra-cleanup.ts`**

Open `src/lib/nostra/nostra-cleanup.ts` and locate the array of IDB names (near line 20). Add `'nostra-reactions'` alongside `'nostra-groups'`, `'nostra-virtual-peers'`, etc.

Search:
```
grep -n "nostra-messages\|nostra-groups\|NOSTRA_IDB_NAMES\|DATABASES_TO_CLEAR" src/lib/nostra/nostra-cleanup.ts
```

Find the array constant and add the new name:
```ts
'nostra-reactions',
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/nostra/nostra-reactions-store.ts \
        src/tests/nostra/nostra-reactions-store.test.ts \
        src/lib/nostra/nostra-cleanup.ts
git commit -m "feat(nostra): add nostra-reactions-store (IDB-backed NIP-25 rows)"
```

---

## Task 3: Create `nostra-reactions-publish.ts`

**Files:**
- Create: `src/lib/nostra/nostra-reactions-publish.ts`
- Create: `src/tests/nostra/nostra-reactions-publish.test.ts`
- Modify: `src/lib/nostra/chat-api.ts` (change `publishEvent` to return the signed event instead of `void`)
- Modify: `src/lib/rootScope.ts` (add `'nostra_reactions_changed': {peerId: PeerId | number; mid: number}` to `BroadcastEvents`)

Context: Wraps `ChatAPI.publishEvent` to emit kind-7 (add reaction) and kind-5 (remove). Also writes to `nostraReactionsStore` synchronously so sender UI updates before relay round-trip. The module is pure orchestration — it delegates signing/fanout to `ChatAPI`.

**Important invariants** (from code-review C1/C2):
- `ChatAPI.publishEvent` must return the signed event (`{id, pubkey, sig, ...}`), NOT `Promise<void>` — the publisher needs `signed.id` as `reactionEventId`.
- Mutation notifications use the typed **`nostra_reactions_changed`** event (Nostra-specific). Do NOT reuse tweb's `messages_reactions` — that event is typed as an array-shape `[{message, changedResults, removedResults}]` and consumers (`appReactionsManager`, `bubbles.ts`) will crash on shape mismatch.

- [ ] **Step 1: Write the failing test**

Create `src/tests/nostra/nostra-reactions-publish.test.ts`:

```ts
// @vitest-environment jsdom
import {describe, it, expect, beforeEach, vi} from 'vitest';
import 'fake-indexeddb/auto';

describe('nostra-reactions-publish', () => {
  let publishMod: any;
  let storeMod: any;
  let mockChatAPI: any;
  let publishedEvents: any[];

  beforeEach(async () => {
    vi.resetModules();
    (globalThis as any).indexedDB.deleteDatabase('nostra-reactions');
    publishedEvents = [];
    mockChatAPI = {
      publishEvent: vi.fn(async (unsigned: any) => {
        const signed = {...unsigned, id: `fakeid-${publishedEvents.length}`, pubkey: 'ownpk'};
        publishedEvents.push(signed);
        return signed;
      }),
      ownId: 'ownpk'
    };
    storeMod = await import('@lib/nostra/nostra-reactions-store');
    publishMod = await import('@lib/nostra/nostra-reactions-publish');
    publishMod.setChatAPI(mockChatAPI);
    await storeMod.nostraReactionsStore.init();
  });

  it('publish() emits kind-7 with e/p tags + emoji content', async () => {
    await publishMod.nostraReactionsPublish.publish({
      targetEventId: 'evtX',
      targetMid: 42,
      targetPeerId: 1e16,
      targetAuthor: 'peerpk',
      emoji: '👍'
    });
    expect(mockChatAPI.publishEvent).toHaveBeenCalledTimes(1);
    const call = mockChatAPI.publishEvent.mock.calls[0][0];
    expect(call.kind).toBe(7);
    expect(call.content).toBe('👍');
    const tagKeys = call.tags.map((t: any[]) => t[0]);
    expect(tagKeys).toContain('e');
    expect(tagKeys).toContain('p');
    const eTag = call.tags.find((t: any[]) => t[0] === 'e');
    expect(eTag[1]).toBe('evtX');
    const pTag = call.tags.find((t: any[]) => t[0] === 'p');
    expect(pTag[1]).toBe('peerpk');
  });

  it('publish() persists row with reactionEventId from published event', async () => {
    await publishMod.nostraReactionsPublish.publish({
      targetEventId: 'evtX',
      targetMid: 42,
      targetPeerId: 1e16,
      targetAuthor: 'peerpk',
      emoji: '👍'
    });
    const rows = await storeMod.nostraReactionsStore.getByTarget('evtX');
    expect(rows).toHaveLength(1);
    expect(rows[0].reactionEventId).toBe('fakeid-0');
    expect(rows[0].fromPubkey).toBe('ownpk');
  });

  it('unpublish() emits kind-5 delete referencing the reaction event id', async () => {
    await publishMod.nostraReactionsPublish.publish({
      targetEventId: 'evtX', targetMid: 42, targetPeerId: 1e16,
      targetAuthor: 'peerpk', emoji: '👍'
    });
    await publishMod.nostraReactionsPublish.unpublish('fakeid-0');
    expect(mockChatAPI.publishEvent).toHaveBeenCalledTimes(2);
    const call = mockChatAPI.publishEvent.mock.calls[1][0];
    expect(call.kind).toBe(5);
    const eTag = call.tags.find((t: any[]) => t[0] === 'e');
    expect(eTag[1]).toBe('fakeid-0');
  });

  it('unpublish() removes the row from the store', async () => {
    await publishMod.nostraReactionsPublish.publish({
      targetEventId: 'evtX', targetMid: 42, targetPeerId: 1e16,
      targetAuthor: 'peerpk', emoji: '👍'
    });
    await publishMod.nostraReactionsPublish.unpublish('fakeid-0');
    const rows = await storeMod.nostraReactionsStore.getByTarget('evtX');
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/tests/nostra/nostra-reactions-publish.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create the publish module**

Create `src/lib/nostra/nostra-reactions-publish.ts`:

```ts
/**
 * NIP-25 publisher — kind-7 (reaction) + kind-5 (delete for remove).
 *
 * The module is a thin orchestrator: ChatAPI signs & fans out, store
 * persists. Consumers (appReactionsManager P2P shortcut, fuzz actions)
 * invoke publish()/unpublish() synchronously vs the UI update — the UI
 * reads the store, not the network.
 */
import rootScope from '@lib/rootScope';
import {nostraReactionsStore} from './nostra-reactions-store';

export interface PublishArgs {
  targetEventId: string;
  targetMid: number;
  targetPeerId: number;
  targetAuthor: string;
  emoji: string;
}

interface ChatAPILike {
  publishEvent(unsigned: {kind: number; created_at: number; tags: string[][]; content: string}): Promise<{id: string; pubkey: string; sig: string; kind: number; created_at: number; tags: string[][]; content: string}>;
  ownId: string;
}

let chatAPI: ChatAPILike | null = null;

export function setChatAPI(c: ChatAPILike) {
  chatAPI = c;
}

class NostraReactionsPublish {
  async publish(args: PublishArgs): Promise<string> {
    if(!chatAPI) throw new Error('[nostra-reactions-publish] ChatAPI not wired — call setChatAPI first');
    const unsigned = {
      kind: 7,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', args.targetEventId],
        ['p', args.targetAuthor]
      ],
      content: args.emoji
    };
    const signed = await chatAPI.publishEvent(unsigned);
    const reactionEventId = signed?.id;
    if(!reactionEventId) throw new Error('[nostra-reactions-publish] published event has no id');
    await nostraReactionsStore.add({
      targetEventId: args.targetEventId,
      targetMid: args.targetMid,
      targetPeerId: args.targetPeerId,
      fromPubkey: chatAPI.ownId,
      emoji: args.emoji,
      reactionEventId,
      createdAt: unsigned.created_at
    });
    rootScope.dispatchEventSingle('nostra_reactions_changed', {
      peerId: args.targetPeerId,
      mid: args.targetMid
    });
    return reactionEventId;
  }

  async unpublish(reactionEventId: string): Promise<void> {
    if(!chatAPI) throw new Error('[nostra-reactions-publish] ChatAPI not wired');
    const rows = await nostraReactionsStore.getAll();
    const row = rows.find((r) => r.reactionEventId === reactionEventId);
    if(!row) return;
    const unsigned = {
      kind: 5,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['e', reactionEventId]],
      content: ''
    };
    await chatAPI.publishEvent(unsigned);
    await nostraReactionsStore.removeByReactionEventId(reactionEventId);
    rootScope.dispatchEventSingle('nostra_reactions_changed', {
      peerId: row.targetPeerId,
      mid: row.targetMid
    });
  }
}

export const nostraReactionsPublish = new NostraReactionsPublish();

if(typeof window !== 'undefined') {
  (window as any).__nostraReactionsPublish = nostraReactionsPublish;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/tests/nostra/nostra-reactions-publish.test.ts 2>&1 | tail -10
```
Expected: all 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/nostra-reactions-publish.ts \
        src/tests/nostra/nostra-reactions-publish.test.ts
git commit -m "feat(nostra): add nostra-reactions-publish (kind-7/kind-5 via ChatAPI)"
```

---

## Task 4: Create `nostra-reactions-receive.ts` with out-of-order buffer

**Files:**
- Create: `src/lib/nostra/nostra-reactions-receive.ts`
- Create: `src/tests/nostra/nostra-reactions-receive.test.ts`

Context: On incoming kind-7, resolve target via `message-store.getByEventId` or fall back to a 5-second buffer (the kind-7 can arrive before the kind-1059 gift-wrap of the target message). Kind-5 delete targets remove any reaction with matching `reactionEventId`. Author verification: the event's own `pubkey` is the author; `['p']` tag must contain my pubkey (filter already ensures this at the relay subscription level, but we re-check).

- [ ] **Step 1: Write the failing test**

Create `src/tests/nostra/nostra-reactions-receive.test.ts`:

```ts
// @vitest-environment jsdom
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import 'fake-indexeddb/auto';

describe('nostra-reactions-receive', () => {
  let recv: any;
  let store: any;
  let messageStoreMock: Map<string, {mid: number; peerId: number}>;

  beforeEach(async () => {
    vi.resetModules();
    (globalThis as any).indexedDB.deleteDatabase('nostra-reactions');
    messageStoreMock = new Map();
    const recvMod = await import('@lib/nostra/nostra-reactions-receive');
    recv = recvMod.nostraReactionsReceive;
    recv.setOwnPubkey('ownpk');
    recv.setMessageResolver(async (eventId: string) => messageStoreMock.get(eventId));
    const storeMod = await import('@lib/nostra/nostra-reactions-store');
    store = storeMod.nostraReactionsStore;
    await store.init();
  });

  afterEach(() => { recv.clearBuffer(); });

  it('onKind7 persists row when target resolves immediately', async () => {
    messageStoreMock.set('evtA', {mid: 10, peerId: 1e16});
    await recv.onKind7({
      id: 'r1', kind: 7, pubkey: 'peerpk', created_at: 100,
      tags: [['e', 'evtA'], ['p', 'ownpk']],
      content: '👍'
    });
    const rows = await store.getByTarget('evtA');
    expect(rows).toHaveLength(1);
    expect(rows[0].emoji).toBe('👍');
    expect(rows[0].fromPubkey).toBe('peerpk');
  });

  it('onKind7 drops event where p tag is not me', async () => {
    messageStoreMock.set('evtA', {mid: 10, peerId: 1e16});
    await recv.onKind7({
      id: 'r1', kind: 7, pubkey: 'peerpk', created_at: 100,
      tags: [['e', 'evtA'], ['p', 'someonelse']],
      content: '👍'
    });
    const rows = await store.getByTarget('evtA');
    expect(rows).toHaveLength(0);
  });

  it('onKind7 buffers unresolved target, flushes once target arrives', async () => {
    // Target not resolvable yet.
    await recv.onKind7({
      id: 'r1', kind: 7, pubkey: 'peerpk', created_at: 100,
      tags: [['e', 'evtB'], ['p', 'ownpk']],
      content: '❤️'
    });
    expect((await store.getByTarget('evtB'))).toHaveLength(0);
    // Target arrives — simulate by calling the flush hook.
    messageStoreMock.set('evtB', {mid: 20, peerId: 1e16});
    await recv.flushPending('evtB');
    const rows = await store.getByTarget('evtB');
    expect(rows).toHaveLength(1);
    expect(rows[0].emoji).toBe('❤️');
  });

  it('onKind5 removes any reaction referenced by e tag', async () => {
    messageStoreMock.set('evtC', {mid: 30, peerId: 1e16});
    await recv.onKind7({
      id: 'r5', kind: 7, pubkey: 'peerpk', created_at: 200,
      tags: [['e', 'evtC'], ['p', 'ownpk']],
      content: '🔥'
    });
    expect((await store.getByTarget('evtC'))).toHaveLength(1);
    await recv.onKind5({
      id: 'd1', kind: 5, pubkey: 'peerpk', created_at: 201,
      tags: [['e', 'r5']],
      content: ''
    });
    expect((await store.getByTarget('evtC'))).toHaveLength(0);
  });

  it('onKind5 from non-author is ignored', async () => {
    messageStoreMock.set('evtC', {mid: 30, peerId: 1e16});
    await recv.onKind7({
      id: 'r5', kind: 7, pubkey: 'peerpk', created_at: 200,
      tags: [['e', 'evtC'], ['p', 'ownpk']],
      content: '🔥'
    });
    // attacker tries to delete peerpk's reaction
    await recv.onKind5({
      id: 'd1', kind: 5, pubkey: 'attackerpk', created_at: 201,
      tags: [['e', 'r5']],
      content: ''
    });
    expect((await store.getByTarget('evtC'))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/tests/nostra/nostra-reactions-receive.test.ts 2>&1 | tail -10
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create the receive module**

Create `src/lib/nostra/nostra-reactions-receive.ts`:

```ts
/**
 * NIP-25 receiver — handles kind-7 (new reaction) and kind-5 (delete reaction).
 *
 * Out-of-order tolerance: kind-7 can arrive on the wire before the kind-1059
 * gift-wrap of the target message, so when the target eventId isn't resolvable
 * via the message store, the event is buffered for BUFFER_MS; a caller
 * (NostraSync on new-message ingest) may invoke flushPending(eventId).
 *
 * Author integrity:
 *   - kind-7: trust `event.pubkey` as the reactor. Filter at subscription
 *     level ensures `#p: [ownPubkey]`; we re-check defensively.
 *   - kind-5 delete: only accepted when `delete.pubkey === reaction.pubkey`.
 */
import rootScope from '@lib/rootScope';
import {nostraReactionsStore, type ReactionRow} from './nostra-reactions-store';

const BUFFER_MS = 5000;

interface NostrEventLite {
  id: string;
  kind: number;
  pubkey: string;
  created_at: number;
  tags: any[][];
  content: string;
}

type MessageResolver = (eventId: string) => Promise<{mid: number; peerId: number} | undefined>;

interface PendingEntry {
  event: NostrEventLite;
  expiresAt: number;
}

class NostraReactionsReceive {
  private ownPubkey = '';
  private resolver: MessageResolver | null = null;
  private pending = new Map<string, PendingEntry[]>(); // keyed by targetEventId

  setOwnPubkey(pk: string) { this.ownPubkey = pk; }
  setMessageResolver(r: MessageResolver) { this.resolver = r; }

  clearBuffer() { this.pending.clear(); }

  async onKind7(event: NostrEventLite): Promise<void> {
    const eTag = event.tags.find((t) => t[0] === 'e');
    const pTag = event.tags.find((t) => t[0] === 'p');
    if(!eTag || !pTag) return; // malformed
    if(this.ownPubkey && pTag[1] !== this.ownPubkey) return; // not for me
    const targetEventId = eTag[1];
    const target = this.resolver ? await this.resolver(targetEventId) : undefined;
    if(!target) {
      this.bufferEvent(targetEventId, event);
      return;
    }
    await this.persist(event, targetEventId, target.mid, target.peerId);
  }

  async flushPending(targetEventId: string): Promise<void> {
    const queue = this.pending.get(targetEventId);
    if(!queue || !queue.length) return;
    const target = this.resolver ? await this.resolver(targetEventId) : undefined;
    if(!target) return;
    for(const entry of queue) {
      if(Date.now() > entry.expiresAt) continue;
      await this.persist(entry.event, targetEventId, target.mid, target.peerId);
    }
    this.pending.delete(targetEventId);
  }

  async onKind5(event: NostrEventLite): Promise<void> {
    const eTags = event.tags.filter((t) => t[0] === 'e').map((t) => t[1] as string);
    if(!eTags.length) return;
    const rows = await nostraReactionsStore.getAll();
    for(const reactionEventId of eTags) {
      const row = rows.find((r) => r.reactionEventId === reactionEventId);
      if(!row) continue;
      if(row.fromPubkey !== event.pubkey) continue; // author mismatch — reject
      await nostraReactionsStore.removeByReactionEventId(reactionEventId);
      rootScope.dispatchEventSingle('nostra_reactions_changed', {
        peerId: row.targetPeerId,
        mid: row.targetMid
      });
    }
  }

  private bufferEvent(targetEventId: string, event: NostrEventLite): void {
    const list = this.pending.get(targetEventId) || [];
    list.push({event, expiresAt: Date.now() + BUFFER_MS});
    this.pending.set(targetEventId, list);
    setTimeout(() => {
      const cur = this.pending.get(targetEventId);
      if(!cur) return;
      const live = cur.filter((e) => e.expiresAt > Date.now());
      if(live.length === 0) this.pending.delete(targetEventId);
      else this.pending.set(targetEventId, live);
    }, BUFFER_MS + 100);
  }

  private async persist(event: NostrEventLite, targetEventId: string, targetMid: number, targetPeerId: number): Promise<void> {
    const row: ReactionRow = {
      targetEventId,
      targetMid,
      targetPeerId,
      fromPubkey: event.pubkey,
      emoji: event.content,
      reactionEventId: event.id,
      createdAt: event.created_at
    };
    await nostraReactionsStore.add(row);
    rootScope.dispatchEventSingle('nostra_reactions_changed', {
      peerId: targetPeerId,
      mid: targetMid
    });
  }
}

export const nostraReactionsReceive = new NostraReactionsReceive();

if(typeof window !== 'undefined') {
  (window as any).__nostraReactionsReceive = nostraReactionsReceive;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/tests/nostra/nostra-reactions-receive.test.ts 2>&1 | tail -10
```
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/nostra/nostra-reactions-receive.ts \
        src/tests/nostra/nostra-reactions-receive.test.ts
git commit -m "feat(nostra): add nostra-reactions-receive (kind-7/5 with out-of-order buffer)"
```

---

## Task 5: Extend relay subscription filter to kinds [1059, 7, 5]

**Files:**
- Modify: `src/lib/nostra/nostr-relay.ts:442-445`
- Modify: `src/lib/nostra/chat-api.ts` (routing)

Context: `NostrRelay.subscribeMessages()` currently subscribes `{kinds: [NOSTR_KIND_GIFTWRAP], #p: [me]}`. Extend to include kind-7 (reactions) and kind-5 (delete). The `#p` filter stays — we only want events targeting me.

- [ ] **Step 1: Locate the subscription filter**

```bash
grep -n "kinds.*NOSTR_KIND_GIFTWRAP\|kinds.*\[1059\]" src/lib/nostra/nostr-relay.ts
```
Expected: one match around line 443.

- [ ] **Step 2: Add kind constants and extend the filter**

Open `src/lib/nostra/nostr-relay.ts`. Near the top of the file (where `NOSTR_KIND_GIFTWRAP` is defined), add:

```ts
const NOSTR_KIND_REACTION = 7;
const NOSTR_KIND_DELETE = 5;
```

Then replace the filter block:

```ts
const filter: Record<string, unknown> = {
  'kinds': [NOSTR_KIND_GIFTWRAP, NOSTR_KIND_REACTION, NOSTR_KIND_DELETE],
  '#p': [this.publicKey]
};
```

Note: kind-5 delete events carry a `p` tag referencing the authors involved per NIP-09; Nostra's own kind-5 delete events emitted by `nostra-reactions-publish` must include `['p', ownPubkey]` to self-echo back through the `#p` filter. Update the publisher in Step 3.

- [ ] **Step 3: Update `nostra-reactions-publish.ts` kind-5 to include `p` tag**

Open `src/lib/nostra/nostra-reactions-publish.ts`. In `unpublish()`, change the tags:

```ts
const unsigned = {
  kind: 5,
  created_at: Math.floor(Date.now() / 1000),
  tags: [['e', reactionEventId], ['p', chatAPI.ownId]],
  content: ''
};
```

- [ ] **Step 4: Update the publish unit test to assert the p tag on kind-5**

Open `src/tests/nostra/nostra-reactions-publish.test.ts`. In the "unpublish() emits kind-5 delete" test, after the existing assertions add:

```ts
const pTag5 = call.tags.find((t: any[]) => t[0] === 'p');
expect(pTag5[1]).toBe('ownpk');
```

- [ ] **Step 5: Run the publish test to verify**

```bash
npx vitest run src/tests/nostra/nostra-reactions-publish.test.ts 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 6: Route kind-7/5 from relay pool to receiver in `chat-api.ts`**

Open `src/lib/nostra/chat-api.ts`. Find `handleRelayMessage` (grep if unsure):

```bash
grep -n "handleRelayMessage\|handleIncomingMessage" src/lib/nostra/chat-api.ts | head -5
```

Before the gift-wrap (kind 1059) branch, add kind-7 and kind-5 routing. Add the import at the top:

```ts
import {nostraReactionsReceive} from './nostra-reactions-receive';
```

Then in `handleRelayMessage` (or the equivalent entry point dispatched from `RelayPool.handleIncomingMessage`), add at the top of the dispatch:

```ts
if(event.kind === 7) {
  await nostraReactionsReceive.onKind7(event as any);
  return;
}
if(event.kind === 5) {
  await nostraReactionsReceive.onKind5(event as any);
  return;
}
```

Then in `initGlobalSubscription()`, after `this.relayPool.subscribeMessages()`, wire the receiver's pubkey and resolver:

```ts
nostraReactionsReceive.setOwnPubkey(this.ownId);
nostraReactionsReceive.setMessageResolver(async (eventId) => {
  const {getMessageStore} = await import('./message-store');
  const store = await getMessageStore();
  const row = await store.getByEventId?.(eventId);
  if(!row) return undefined;
  return {mid: row.mid, peerId: row.twebPeerId};
});
```

- [ ] **Step 7: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -E "nostr-relay|chat-api|nostra-reactions" | head -5
```
Expected: no new errors.

- [ ] **Step 8: Commit**

```bash
git add src/lib/nostra/nostr-relay.ts \
        src/lib/nostra/chat-api.ts \
        src/lib/nostra/nostra-reactions-publish.ts \
        src/tests/nostra/nostra-reactions-publish.test.ts
git commit -m "feat(nostra): route kind-7/5 to reactions receiver; subscribe to kind list"
```

---

## Task 6: Add `messages.sendReaction` Nostra handler

**Files:**
- Modify: `src/lib/appManagers/apiManager.ts`
- Modify: `src/lib/nostra/virtual-mtproto-server.ts`
- Create: `src/tests/nostra/reactions-vmt-bridge.test.ts`

Context: When `appReactionsManager.sendReaction()` invokes `messages.sendReaction`, the call today falls through to `{pFlags: {}}`. Route it via the bridge so the Nostra server can emit kind-7 via `nostraReactionsPublish.publish()`.

- [ ] **Step 1: Write the failing bridge test**

Create `src/tests/nostra/reactions-vmt-bridge.test.ts`:

```ts
// @vitest-environment jsdom
import {describe, it, expect, beforeEach, vi} from 'vitest';
import 'fake-indexeddb/auto';

describe('VMT messages.sendReaction handler', () => {
  let vmtMod: any;
  let publishSpy: any;

  beforeEach(async () => {
    vi.resetModules();
    (globalThis as any).indexedDB.deleteDatabase('nostra-reactions');
    publishSpy = vi.fn(async () => 'fakeReactionId');
    vi.doMock('@lib/nostra/nostra-reactions-publish', () => ({
      nostraReactionsPublish: {publish: publishSpy, unpublish: vi.fn()},
      setChatAPI: vi.fn()
    }));
    vmtMod = await import('@lib/nostra/virtual-mtproto-server');
  });

  it('handles messages.sendReaction → calls nostraReactionsPublish.publish', async () => {
    const server = new vmtMod.NostraMTProtoServer({
      // minimal stub
      getMessageByPeerMid: () => ({peerId: 1e16, relayEventId: 'evtTarget', senderPubkey: 'peerpk'})
    });
    const result = await server.handleMethod('messages.sendReaction', {
      message: {peerId: 1e16, mid: 42},
      reaction: {_: 'reactionEmoji', emoticon: '👍'}
    });
    expect(publishSpy).toHaveBeenCalledWith(expect.objectContaining({
      targetEventId: 'evtTarget',
      targetMid: 42,
      targetPeerId: 1e16,
      targetAuthor: 'peerpk',
      emoji: '👍'
    }));
    // Tweb expects an 'updates' shape in return.
    expect(result).toEqual(expect.objectContaining({_: 'updates'}));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/tests/nostra/reactions-vmt-bridge.test.ts 2>&1 | tail -10
```
Expected: FAIL — either the class doesn't have the handler or the constructor signature mismatches. Read the error and adapt the mock's constructor call in Step 1 to match the real signature.

Inspect the real class:
```bash
grep -n "class NostraMTProtoServer\|handleMethod" src/lib/nostra/virtual-mtproto-server.ts | head -5
```

Update the test's `new vmtMod.NostraMTProtoServer(...)` invocation to match the real required args (look at how `apiManagerProxy.ts` constructs it — search for `new NostraMTProtoServer`).

- [ ] **Step 3: Add the handler in `virtual-mtproto-server.ts`**

Open `src/lib/nostra/virtual-mtproto-server.ts`. Find `handleMethod` (the big switch). Add a new case:

```ts
if(method === 'messages.sendReaction') {
  const {nostraReactionsPublish} = await import('./nostra-reactions-publish');
  const peerId = Number(params.message?.peerId);
  const mid = Number(params.message?.mid);
  const emoji = params.reaction?.emoticon || '';

  // Resolve target kind-1059 event id + target author.
  const resolved = this.getMessageByPeerMid?.(peerId, mid);
  if(!resolved?.relayEventId) {
    return {_: 'updates', updates: [], users: [], chats: [], date: Math.floor(Date.now() / 1000), seq: 0};
  }
  try {
    await nostraReactionsPublish.publish({
      targetEventId: resolved.relayEventId,
      targetMid: mid,
      targetPeerId: peerId,
      targetAuthor: resolved.senderPubkey,
      emoji
    });
  } catch(e) {
    console.warn('[VMT] sendReaction publish failed', e);
  }
  return {_: 'updates', updates: [], users: [], chats: [], date: Math.floor(Date.now() / 1000), seq: 0};
}
```

If `handleMethod` uses a switch on `method` variable, insert the branch appropriately. If it uses a method-name dispatch table, add the entry there. Follow the file's existing conventions.

- [ ] **Step 4: Register `messages.sendReaction` in `NOSTRA_BRIDGE_METHODS`**

Open `src/lib/appManagers/apiManager.ts`. Find the `NOSTRA_BRIDGE_METHODS` set:

```bash
grep -n "NOSTRA_BRIDGE_METHODS" src/lib/appManagers/apiManager.ts
```

Add `'messages.sendReaction'` to the set/array.

- [ ] **Step 5: Run the bridge test**

```bash
npx vitest run src/tests/nostra/reactions-vmt-bridge.test.ts 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 6: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep -E "apiManager|virtual-mtproto-server" | head -5
```
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add src/lib/appManagers/apiManager.ts \
        src/lib/nostra/virtual-mtproto-server.ts \
        src/tests/nostra/reactions-vmt-bridge.test.ts
git commit -m "feat(nostra): VMT handler for messages.sendReaction routes to kind-7 publisher"
```

---

## Task 7: Wire `appReactionsManager.sendReaction` P2P shortcut

**Files:**
- Modify: `src/lib/appManagers/appReactionsManager.ts`

Context: The tweb `appReactionsManager.sendReaction()` runs on Worker side. For P2P peers, skip the legacy MTProto path entirely and invoke `messages.sendReaction` via the VMT bridge added in Task 6. The existing `processLocalUpdate('updateMessageReactions')` Worker-side is still needed for mirror drift.

- [ ] **Step 1: Locate `sendReaction` in `appReactionsManager.ts`**

```bash
grep -n "public sendReaction\|public async sendReaction" src/lib/appManagers/appReactionsManager.ts | head -5
```

- [ ] **Step 2: Add P2P shortcut early-branch**

At the top of `sendReaction`, add:

```ts
const peerId = message?.peerId;
if(peerId && Number(peerId) >= 1e15) {
  // Nostra P2P path — the VMT bridge will publish kind-7 + persist locally.
  // We still want tweb's local mirror update so that re-rendering paths
  // that inspect appReactionsManager.messagesReactions see the new state.
  return this.apiManager.invokeApi('messages.sendReaction', {
    message, reaction, add_to_recent: true
  });
}
```

Place it **before** any `message.reactions` mutation or `processLocalUpdate` call — the P2P path intentionally bypasses the legacy local mutation because the Nostra store is the source of truth.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep appReactionsManager | head -5
```
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/appManagers/appReactionsManager.ts
git commit -m "fix(reactions): P2P shortcut routes sendReaction via VMT bridge"
```

---

## Task 8: Extend `nostra-reactions-local.ts` as shim over the new store

**Files:**
- Modify: `src/lib/nostra/nostra-reactions-local.ts`
- Modify: `src/tests/nostra/reactions-local.test.ts`

Context: Phase 2a added `nostra-reactions-local.ts` as an in-memory sender-only store to unblock the fuzz postcondition. Phase 2b.1 replaces its internal Map with a read-through from `nostraReactionsStore`. Public API (`addReaction`, `getReactions`, `clear`) stays signature-compatible so existing callers (`bubbles.ts`, etc.) continue to work. Writing a reaction now publishes via the new pipeline.

- [ ] **Step 1: Read the current impl + test**

```bash
cat src/lib/nostra/nostra-reactions-local.ts
```

- [ ] **Step 2: Rewrite the module**

Replace the file with:

```ts
/**
 * Legacy shim for code expecting the Phase 2a sender-only reactions store.
 *
 * Phase 2b.1 replaces the in-memory Map with a read-through facade over
 * `nostraReactionsStore` (IDB-backed). Callers use `addReaction()` and
 * `getReactions()` as before; internally:
 *  - addReaction triggers nostraReactionsPublish.publish (relay + store)
 *  - getReactions reads from the store synchronously via a local cache
 *
 * The sync cache is needed because `bubbles.ts` calls `getReactions()`
 * during render and can't await an IDB transaction. We warm the cache on
 * every store mutation via the `nostra_reactions_changed` rootScope event.
 */
import rootScope from '@lib/rootScope';
import {nostraReactionsStore} from './nostra-reactions-store';
import {nostraReactionsPublish} from './nostra-reactions-publish';

type Key = string; // `${peerId}:${mid}`

const key = (peerId: number, mid: number): Key => `${peerId}:${mid}`;

class NostraReactionsLocal {
  /** Sync cache for render-time access. Hydrated from store + updated on events. */
  private cache: Map<Key, Set<string>> = new Map();

  constructor() {
    rootScope.addEventListener('nostra_reactions_changed', async ({peerId, mid}) => {
      if(!peerId || !mid) return;
      await this.refreshCache(peerId as number, mid);
    });
  }

  async addReaction(peerId: number, mid: number, emoji: string, context?: {targetEventId: string; targetAuthor: string}): Promise<void> {
    if(!context) {
      // No relay context provided (legacy callers); update cache only.
      const k = key(peerId, mid);
      let set = this.cache.get(k);
      if(!set) {set = new Set(); this.cache.set(k, set);}
      set.add(emoji);
      return;
    }
    await nostraReactionsPublish.publish({
      targetEventId: context.targetEventId,
      targetMid: mid,
      targetPeerId: peerId,
      targetAuthor: context.targetAuthor,
      emoji
    });
  }

  getReactions(peerId: number, mid: number): string[] {
    const set = this.cache.get(key(peerId, mid));
    return set ? Array.from(set) : [];
  }

  clear(): void {
    this.cache.clear();
  }

  private async refreshCache(peerId: number, mid: number): Promise<void> {
    // Load all reactions for the target and project into cache.
    const rows = await nostraReactionsStore.getAll();
    const matching = rows.filter((r) => r.targetPeerId === peerId && r.targetMid === mid);
    const set = new Set<string>(matching.map((r) => r.emoji));
    this.cache.set(key(peerId, mid), set);
  }
}

export const nostraReactionsLocal = new NostraReactionsLocal();

if(typeof window !== 'undefined') {
  (window as any).__nostraReactionsLocal = nostraReactionsLocal;
}
```

- [ ] **Step 3: Update `reactions-local.test.ts` to cover the new shim**

Open `src/tests/nostra/reactions-local.test.ts`. Replace / add tests to cover:

```ts
// @vitest-environment jsdom
import {describe, it, expect, beforeEach, vi} from 'vitest';
import 'fake-indexeddb/auto';

describe('nostraReactionsLocal (shim over nostraReactionsStore)', () => {
  let local: any;
  let store: any;

  beforeEach(async () => {
    vi.resetModules();
    (globalThis as any).indexedDB.deleteDatabase('nostra-reactions');
    const storeMod = await import('@lib/nostra/nostra-reactions-store');
    store = storeMod.nostraReactionsStore;
    await store.init();
    const localMod = await import('@lib/nostra/nostra-reactions-local');
    local = localMod.nostraReactionsLocal;
  });

  it('getReactions returns cached emoji set for peerId/mid', async () => {
    await store.add({
      targetEventId: 'evt1', targetMid: 1, targetPeerId: 1e16,
      fromPubkey: 'pub1', emoji: '👍', reactionEventId: 'r1', createdAt: 1
    });
    // Simulate the event that would normally fire on store add
    const rootScope = (await import('@lib/rootScope')).default;
    rootScope.dispatchEventSingle('nostra_reactions_changed', {peerId: 1e16, mid: 1});
    await new Promise((r) => setTimeout(r, 10));
    expect(local.getReactions(1e16, 1)).toEqual(['👍']);
  });

  it('addReaction without context updates local cache only (legacy path)', async () => {
    await local.addReaction(1e16, 2, '❤️');
    expect(local.getReactions(1e16, 2)).toEqual(['❤️']);
  });
});
```

- [ ] **Step 4: Run the tests**

```bash
npx vitest run src/tests/nostra/reactions-local.test.ts 2>&1 | tail -10
```
Expected: PASS.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep nostra-reactions-local | head -5
```
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/nostra/nostra-reactions-local.ts \
        src/tests/nostra/reactions-local.test.ts
git commit -m "refactor(nostra): nostra-reactions-local shim over persistent reactions store"
```

---

## Task 9: Wire `ChatAPI.publishEvent` into `nostraReactionsPublish`

**Files:**
- Modify: `src/lib/nostra/chat-api.ts`

Context: `nostra-reactions-publish.ts` requires `setChatAPI()` called once at ChatAPI boot. The existing `initGlobalSubscription` is the right place.

**Acceptance criteria:**
- `ChatAPI.publishEvent` returns the *signed* event (`{id, pubkey, kind, created_at, tags, content, sig}`), not `Promise<void>`. The Task 3 fix already tightened this — callers that ignore the return value (e.g. `FoldersSync.publish`) continue to work unchanged since a wider return type is backward-compatible. Verify with `grep -rn "\.publishEvent(" src/lib/` that no caller destructures return properties expecting `void`.

- [ ] **Step 1: Import the setter**

In `src/lib/nostra/chat-api.ts` near existing nostra-reactions-receive import:

```ts
import {setChatAPI as setReactionsChatAPI} from './nostra-reactions-publish';
```

- [ ] **Step 2: Call the setter in `initGlobalSubscription`**

After the `nostraReactionsReceive.setOwnPubkey(...)` line added in Task 5, add:

```ts
setReactionsChatAPI(this as any);
```

(ChatAPI exposes `publishEvent` and `ownId` which is the interface nostra-reactions-publish expects.)

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep chat-api | head -5
```
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/chat-api.ts
git commit -m "wire(nostra): ChatAPI set as reactions publisher backend on init"
```

---

## Task 10: E2E test — publish + receive + remove bilateral

**Files:**
- Create: `src/tests/nostra/reactions-nip25.test.ts`

Context: Exercises the full pipeline via Playwright with 2 users + LocalRelay. Pattern mirrors `src/tests/e2e/e2e-bug-regression.ts` bootstrap.

- [ ] **Step 1: Write the E2E test**

Create `src/tests/nostra/reactions-nip25.test.ts`:

```ts
// @ts-nocheck
import {test, expect} from '@playwright/test';
import {launchOptions} from '../e2e/helpers/launch-options';
import {LocalRelay} from '../e2e/helpers/local-relay';
import {dismissOverlays} from '../e2e/helpers/dismiss-overlays';

test.describe('NIP-25 reactions end-to-end', () => {
  test('A reacts on B message → B sees reaction; A removes → B loses it', async ({browser}) => {
    const relay = new LocalRelay();
    await relay.start();

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await ctxA.addInitScript((url) => { (window as any).__nostraTestRelays = [{url, read: true, write: true}]; }, relay.url);
    await ctxB.addInitScript((url) => { (window as any).__nostraTestRelays = [{url, read: true, write: true}]; }, relay.url);

    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    for(const p of [pageA, pageB]) {
      await p.goto('http://localhost:8080', {waitUntil: 'load', timeout: 60000});
      await p.waitForTimeout(5000);
      await p.reload({waitUntil: 'load', timeout: 60000});
      await p.waitForTimeout(15000);
      await dismissOverlays(p);
      await p.getByRole('button', {name: 'Create New Identity'}).click();
      await p.waitForTimeout(2000);
      await p.getByRole('button', {name: 'Continue'}).click();
      await p.waitForTimeout(2000);
      await p.getByRole('textbox').fill(p === pageA ? 'Alice' : 'Bob');
      await p.getByRole('button', {name: 'Get Started'}).click();
      await p.waitForTimeout(8000);
    }

    const [npubA, npubB] = await Promise.all([
      pageA.evaluate(() => {
        for(const e of document.querySelectorAll('*')) {
          if(e.children.length === 0 && e.textContent?.includes('npub1')) return e.textContent.trim();
        }
        return '';
      }),
      pageB.evaluate(() => {
        for(const e of document.querySelectorAll('*')) {
          if(e.children.length === 0 && e.textContent?.includes('npub1')) return e.textContent.trim();
        }
        return '';
      })
    ]);

    for(const {page, otherNpub, otherName} of [
      {page: pageA, otherNpub: npubB, otherName: 'Bob'},
      {page: pageB, otherNpub: npubA, otherName: 'Alice'}
    ]) {
      await page.evaluate(async ({pk, nm}) => {
        const {addP2PContact} = await import('/src/lib/nostra/add-p2p-contact.ts');
        await addP2PContact({pubkey: pk, nickname: nm, source: 'e2e-reactions-test'});
      }, {pk: otherNpub, nm: otherName});
    }

    // B sends a message to A.
    const peerIdBOnA = await pageA.evaluate(async () => {
      const rs = (window as any).rootScope;
      const proxy = (window as any).apiManagerProxy;
      const peers = proxy?.mirrors?.peers || {};
      for(const [pid, p] of Object.entries<any>(peers)) {
        if(Number(pid) >= 1e15) return Number(pid);
      }
      return 0;
    });
    const peerIdAOnB = await pageB.evaluate(async () => {
      const proxy = (window as any).apiManagerProxy;
      const peers = proxy?.mirrors?.peers || {};
      for(const [pid, p] of Object.entries<any>(peers)) {
        if(Number(pid) >= 1e15) return Number(pid);
      }
      return 0;
    });

    await pageB.evaluate(async (peerId) => {
      const rs = (window as any).rootScope;
      (window as any).appImManager?.setPeer?.({peerId});
      await new Promise((r) => setTimeout(r, 500));
      const input = document.querySelector('.chat-input [contenteditable="true"]') as HTMLElement;
      input.focus();
      document.execCommand('insertText', false, 'hello from B');
      (document.querySelector('.chat-input button.btn-send') as HTMLElement).click();
    }, peerIdAOnB);
    await pageB.waitForTimeout(2000);

    // A opens chat and reacts with 👍.
    await pageA.evaluate(async (peerId) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, peerIdBOnA);
    await pageA.waitForTimeout(1000);

    const targetMidOnA = await pageA.evaluate(() => {
      const b = document.querySelector('.bubbles-inner .bubble[data-mid].is-in') as HTMLElement;
      return b ? Number(b.dataset.mid) : 0;
    });
    expect(targetMidOnA).toBeGreaterThan(0);

    await pageA.evaluate(async (mid) => {
      const rs = (window as any).rootScope;
      const peerId = (window as any).appImManager?.chat?.peerId;
      await rs.managers.appReactionsManager.sendReaction({
        message: {peerId, mid},
        reaction: {_: 'reactionEmoji', emoticon: '👍'}
      });
    }, targetMidOnA);
    await pageA.waitForTimeout(3000);

    // B sees the reaction.
    const bSees = await pageB.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble.is-out'));
      for(const b of bubbles) {
        const rt = b.querySelector('.reactions');
        if(rt && rt.textContent?.includes('👍')) return true;
      }
      return false;
    });
    expect(bSees).toBe(true);

    // A removes the reaction (click same emoji again, which in tweb toggles off).
    await pageA.evaluate(async (mid) => {
      const rs = (window as any).rootScope;
      const peerId = (window as any).appImManager?.chat?.peerId;
      // Remove: invoke unpublish directly on the store-adjacent helper.
      const rows = await (window as any).__nostraReactionsStore.getAll();
      const ownRow = rows.find((r: any) => r.fromPubkey !== 'x' && r.targetMid === mid);
      if(ownRow) await (window as any).__nostraReactionsPublish.unpublish(ownRow.reactionEventId);
    }, targetMidOnA);
    await pageA.waitForTimeout(3000);

    const bNoLonger = await pageB.evaluate(() => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble.is-out'));
      for(const b of bubbles) {
        const rt = b.querySelector('.reactions');
        if(rt && rt.textContent?.includes('👍')) return false;
      }
      return true;
    });
    expect(bNoLonger).toBe(true);

    await ctxA.close();
    await ctxB.close();
    await relay.stop();
  });
});
```

- [ ] **Step 2: Run the E2E test**

Start dev server in a terminal (`pnpm start`), then in another:

```bash
npx playwright test src/tests/nostra/reactions-nip25.test.ts --reporter=list 2>&1 | tail -20
```
Expected: the test may FAIL initially if the `.reactions` DOM selector doesn't match — this is expected because bubbles.ts rendering path for Nostra P2P needs wiring in Task 12. Leave the test failing for now (TDD red); it will go green after Task 12.

- [ ] **Step 3: Commit the red test**

```bash
git add src/tests/nostra/reactions-nip25.test.ts
git commit -m "test(nostra): E2E reactions NIP-25 (red — pending bubble render wiring)"
```

---

## Task 11: Diagnose and fix tweb `reaction.ts` guard crashes

**Files:**
- Modify: `src/components/chat/reaction.ts`
- Create: `src/tests/nostra/reaction-guard.test.ts`

Context: FIND-2fda8762 reports `Cannot read 'center_icon'` at `reaction.ts:205:33` (line number from Vite HMR version). FIND-7fd7bc72 reports `Cannot read 'sticker'` at `wrapSticker` triggered from `reaction.ts:419`. The root cause is `getReaction()` returning `undefined` for Nostra (empty `availableReactions` catalog) at access sites that lack the guard present at line 340.

- [ ] **Step 1: Enumerate all `availableReaction` access sites**

```bash
grep -n "availableReaction\." src/components/chat/reaction.ts
```
Expected output includes:
- Line ~340: `if(!availableReaction) return;` (GUARDED)
- Line ~350: `availableReaction.center_icon ?? availableReaction.static_icon` (protected by Step-1 return)
- Line ~416-420: access inside `onAvailableReaction` or similar — check context
- Line ~630: `doc: sticker || availableReaction.center_icon` (UNGUARDED at value)

- [ ] **Step 2: Add guards at unguarded sites**

For each unguarded access site identified in Step 1, wrap in:

```ts
if(!availableReaction) { /* Nostra mode: no sticker catalog — render plain emoji */ return; }
```

For the line 630 case (inside an object literal), restructure:

```ts
// Before:
//   doc: sticker || availableReaction.center_icon
// After:
const fallbackDoc = sticker || availableReaction?.center_icon;
if(!fallbackDoc) { /* Nostra mode, or missing sticker — emoji-only fallback */ return; }
```

Take care not to break existing tweb behavior — the guards only return early / fall back when `availableReaction` is undefined, which in native tweb never happens.

- [ ] **Step 3: Write a regression test**

Create `src/tests/nostra/reaction-guard.test.ts`:

```ts
// @vitest-environment jsdom
import {describe, it, expect, vi, beforeEach} from 'vitest';

describe('reaction.ts guards tolerate undefined availableReaction (Nostra mode)', () => {
  let mod: any;

  beforeEach(async () => {
    vi.resetModules();
    // Minimal stubs for module-scope side imports. The exact setup depends on
    // how src/components/chat/reaction.ts imports tweb singletons; update if
    // tests run in a browser environment instead.
    mod = await import('@components/chat/reaction');
  });

  it('module loads without throwing when imported in Nostra context', () => {
    // Smoke check — the diagnose pass revealed that module top-level side
    // effects can already throw on init if a guard is missing. Loading the
    // module must not throw.
    expect(mod).toBeDefined();
  });

  // Add site-specific guard tests here based on the diagnose results from
  // Task 1. If a specific function can be exported, call it with
  // `availableReaction = undefined` and assert no throw.
});
```

Expand the test with a specific call pattern once the unguarded site's surrounding function is understood (e.g. if there's an exported `renderReactionWithStickerMaybe(availableReaction, …)` you can call with `undefined`).

- [ ] **Step 4: Run the test**

```bash
npx vitest run src/tests/nostra/reaction-guard.test.ts 2>&1 | tail -10
```
Expected: PASS (smoke) + site-specific PASS if you added those assertions.

- [ ] **Step 5: Re-replay FIND-2fda8762 and FIND-7fd7bc72**

Ensure dev server is still running. Then:

```bash
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --replay=FIND-2fda8762 2>&1 | tail -20
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --replay=FIND-7fd7bc72 2>&1 | tail -20
```
Expected: BOTH report `all steps passed — bug not reproduced`.

If either still reproduces, fall back to the feature-flag approach. Add to `src/components/chat/reaction.ts` near the top:

```ts
const NOSTRA_SKIP_REACTION_STICKER_RENDER = true; // Phase 2b.1: tweb sticker catalog path bypasses Nostra
```

And at the entry of `renderReactionWithStickerMaybe` (or the relevant function), wrap:

```ts
if(NOSTRA_SKIP_REACTION_STICKER_RENDER && isP2PPeer(this.peerId)) {
  // Render plain emoji only — no sticker animation for P2P.
  this.renderPlainEmojiFallback(this.reaction.emoticon);
  return;
}
```

You'll need to import `isP2PPeer` from `@lib/nostra/nostra-bridge` and implement `renderPlainEmojiFallback` as a minimal DOM append of the emoji Unicode char.

- [ ] **Step 6: Update FIND-2fda8762 and FIND-7fd7bc72 READMEs**

In `docs/fuzz-reports/FIND-2fda8762/README.md` and `docs/fuzz-reports/FIND-7fd7bc72/README.md`, set status to `fixed-in-2b1` and add the commit SHA after Step 7.

- [ ] **Step 7: Commit**

```bash
git add src/components/chat/reaction.ts \
        src/tests/nostra/reaction-guard.test.ts \
        docs/fuzz-reports/FIND-2fda8762/README.md \
        docs/fuzz-reports/FIND-7fd7bc72/README.md
git commit -m "fix(reaction): guard availableReaction access sites for Nostra mode (no sticker catalog)"
```

---

## Task 12: Wire bubble re-render on `nostra_reactions_changed` event

**Files:**
- Modify: `src/components/chat/bubbles.ts` (single function add)

Context: The `nostra-reactions-local.ts` shim dispatches `nostra_reactions_changed` (a typed Nostra-specific event defined in `BroadcastEvents`) on mutation. `bubbles.ts` must have a listener that recomputes the `.reactions` DOM for the affected `data-mid` bubble. Note: tweb legacy `messages_reactions` is an array-shape event used by the MTProto flow — do NOT repurpose it; Nostra uses its own typed event to avoid shape collisions.

- [ ] **Step 1: Check for existing listener**

```bash
grep -n "nostra_reactions_changed" src/components/chat/bubbles.ts
```

Expected: no match (you're adding the first listener).

- [ ] **Step 2: Add / patch listener**

Locate the `bubbles.ts` subscription region (grep `addEventListener('message_sent'` or similar) and add:

```ts
rootScope.addEventListener('nostra_reactions_changed', async ({peerId, mid}) => {
  if(!this.peerId || this.peerId !== peerId) return;
  const bubble = this.bubbles[mid];
  if(!bubble) return;
  // Nostra P2P path: read from the shim (sync cache, already hydrated
  // from store on event fire per reactions-local.ts).
  if(Number(peerId) >= 1e15) {
    const {nostraReactionsLocal} = await import('@lib/nostra/nostra-reactions-local');
    const emojis = nostraReactionsLocal.getReactions(peerId as number, mid);
    this.renderNostraReactions(bubble, emojis);
    return;
  }
  // …existing tweb path if any…
});
```

Then implement `renderNostraReactions(bubble, emojis)` at the appropriate place in the Bubbles class:

```ts
private renderNostraReactions(bubble: HTMLElement, emojis: string[]): void {
  let container = bubble.querySelector(':scope > .reactions') as HTMLElement | null;
  if(!container) {
    container = document.createElement('div');
    container.className = 'reactions nostra-reactions';
    bubble.appendChild(container);
  }
  container.textContent = emojis.join(' ');
  container.style.display = emojis.length ? '' : 'none';
}
```

- [ ] **Step 3: Re-run E2E test from Task 10**

```bash
npx playwright test src/tests/nostra/reactions-nip25.test.ts --reporter=list 2>&1 | tail -20
```
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/bubbles.ts
git commit -m "feat(bubbles): render Nostra reactions from store on nostra_reactions_changed event"
```

---

## Task 13: Fuzz action — extend `reactToRandomBubble` with `fromTarget`

**Files:**
- Modify: `src/tests/fuzz/actions/messaging.ts`

Context: Current `reactToRandomBubble` picks any bubble (`ownOnly: false`). Phase 2b.1 wants a clearly-directed arg: `'own'` = react to one of my own, `'peer'` = react to one from peer.

- [ ] **Step 1: Update the action**

Open `src/tests/fuzz/actions/messaging.ts`. Replace the `reactToRandomBubble` block:

```ts
export const reactToRandomBubble: ActionSpec = {
  name: 'reactToRandomBubble',
  weight: 12,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    fromTarget: fc.constantFrom('own', 'peer'),
    emoji: fc.constantFrom('❤️', '👍', '😂', '🔥', '🤔')
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(300);

    const ownOnly = action.args.fromTarget === 'own';
    const mid = await pickRandomBubbleMid(ctx, from, ownOnly);
    if(!mid) {action.skipped = true; return action;}

    const ok = await sender.page.evaluate(async ({targetMid, emoji}: any) => {
      const rs = (window as any).rootScope;
      const peerId = (window as any).appImManager?.chat?.peerId;
      const mgr = rs?.managers?.appReactionsManager;
      if(!mgr?.sendReaction || !peerId) return false;
      try{
        await mgr.sendReaction({
          message: {peerId, mid: Number(targetMid)},
          reaction: {_: 'reactionEmoji', emoticon: emoji}
        });
        return true;
      } catch{ return false; }
    }, {targetMid: mid, emoji: action.args.emoji});
    if(!ok) {action.skipped = true; return action;}

    action.meta = {reactedMid: mid, emoji: action.args.emoji, fromTarget: action.args.fromTarget};
    return action;
  }
};
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "fuzz/actions" | head -5
```
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/tests/fuzz/actions/messaging.ts
git commit -m "feat(fuzz): reactToRandomBubble adds fromTarget arg (own|peer)"
```

---

## Task 14: Fuzz action — `removeReaction`

**Files:**
- Modify: `src/tests/fuzz/actions/messaging.ts`
- Modify: `src/tests/fuzz/actions/index.ts`

Context: Pick a random own reaction row from the sender's store → call `nostraReactionsPublish.unpublish()` → postcondition validates the reaction disappears bilaterally.

- [ ] **Step 1: Append the action to `messaging.ts`**

At the bottom of `src/tests/fuzz/actions/messaging.ts`:

```ts
export const removeReaction: ActionSpec = {
  name: 'removeReaction',
  weight: 4,
  generateArgs: () => fc.record({user: fc.constantFrom('userA', 'userB')}),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(200);

    const picked = await sender.page.evaluate(async () => {
      const store = (window as any).__nostraReactionsStore;
      if(!store) return null;
      const rows = await store.getAll();
      const own = rows.filter((r: any) => r.fromPubkey && r.reactionEventId);
      if(!own.length) return null;
      const p = own[Math.floor(Math.random() * own.length)];
      return {reactionEventId: p.reactionEventId, mid: p.targetMid, emoji: p.emoji};
    });
    if(!picked) {action.skipped = true; return action;}

    const ok = await sender.page.evaluate(async (reId: string) => {
      try {
        await (window as any).__nostraReactionsPublish.unpublish(reId);
        return true;
      } catch { return false; }
    }, picked.reactionEventId);
    if(!ok) {action.skipped = true; return action;}

    action.meta = {removedReactionId: picked.reactionEventId, mid: picked.mid, emoji: picked.emoji};
    return action;
  }
};
```

- [ ] **Step 2: Register in `actions/index.ts`**

Open `src/tests/fuzz/actions/index.ts`. Add import and register:

```ts
import {sendText, replyToRandomBubble, editRandomOwnBubble, deleteRandomOwnBubble, reactToRandomBubble, removeReaction} from './messaging';
// ...
export const ACTION_REGISTRY: ActionSpec[] = [
  sendText,
  replyToRandomBubble,
  editRandomOwnBubble,
  deleteRandomOwnBubble,
  reactToRandomBubble,
  removeReaction,
  openRandomChat,
  scrollHistoryUp,
  waitForPropagation
];
```

- [ ] **Step 3: Commit**

```bash
git add src/tests/fuzz/actions/messaging.ts src/tests/fuzz/actions/index.ts
git commit -m "feat(fuzz): add removeReaction action"
```

---

## Task 15: Fuzz action — `reactMultipleEmoji`

**Files:**
- Modify: `src/tests/fuzz/actions/messaging.ts`
- Modify: `src/tests/fuzz/actions/index.ts`

Context: Pick a bubble, react with 2-3 distinct emoji in quick succession. Postcondition validates multi-emoji row aggregation on the target.

- [ ] **Step 1: Append the action**

At the bottom of `src/tests/fuzz/actions/messaging.ts`:

```ts
export const reactMultipleEmoji: ActionSpec = {
  name: 'reactMultipleEmoji',
  weight: 3,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    emojis: fc.uniqueArray(fc.constantFrom('❤️', '👍', '😂', '🔥', '🤔'), {minLength: 2, maxLength: 3})
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(200);

    const mid = await pickRandomBubbleMid(ctx, from, false);
    if(!mid) {action.skipped = true; return action;}

    const emojis: string[] = action.args.emojis;
    for(const emoji of emojis) {
      const ok = await sender.page.evaluate(async ({targetMid, em}: any) => {
        const rs = (window as any).rootScope;
        const peerId = (window as any).appImManager?.chat?.peerId;
        try {
          await rs.managers.appReactionsManager.sendReaction({
            message: {peerId, mid: Number(targetMid)},
            reaction: {_: 'reactionEmoji', emoticon: em}
          });
          return true;
        } catch { return false; }
      }, {targetMid: mid, em: emoji});
      if(!ok) {action.skipped = true; return action;}
      await sender.page.waitForTimeout(300); // let each publish settle
    }

    action.meta = {targetMid: mid, emojis};
    return action;
  }
};
```

- [ ] **Step 2: Register in `actions/index.ts`**

```ts
import {sendText, replyToRandomBubble, editRandomOwnBubble, deleteRandomOwnBubble, reactToRandomBubble, removeReaction, reactMultipleEmoji} from './messaging';
// ...
export const ACTION_REGISTRY: ActionSpec[] = [
  sendText,
  replyToRandomBubble,
  editRandomOwnBubble,
  deleteRandomOwnBubble,
  reactToRandomBubble,
  removeReaction,
  reactMultipleEmoji,
  openRandomChat,
  scrollHistoryUp,
  waitForPropagation
];
```

- [ ] **Step 3: Commit**

```bash
git add src/tests/fuzz/actions/messaging.ts src/tests/fuzz/actions/index.ts
git commit -m "feat(fuzz): add reactMultipleEmoji action"
```

---

## Task 16: Fuzz invariants — `reactions.ts` (5 invariants)

**Files:**
- Create: `src/tests/fuzz/invariants/reactions.ts`
- Create: `src/tests/fuzz/invariants/reactions.test.ts`

Context: 5 invariants across cheap/medium/regression tiers.

- [ ] **Step 1: Write the invariants file**

Create `src/tests/fuzz/invariants/reactions.ts`:

```ts
// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult} from '../types';

async function storeAllOn(user: any): Promise<any[]> {
  return user.page.evaluate(async () => {
    const s = (window as any).__nostraReactionsStore;
    if(!s) return [];
    return await s.getAll();
  });
}

export const reactionDedupe: Invariant = {
  id: 'INV-reaction-dedupe',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const rows = await storeAllOn(ctx.users[id]);
      const seen = new Map<string, number>();
      for(const r of rows) {
        const k = `${r.targetEventId}|${r.fromPubkey}|${r.emoji}`;
        seen.set(k, (seen.get(k) || 0) + 1);
      }
      for(const [k, n] of seen) {
        if(n > 1) return {ok: false, message: `duplicate reaction row on ${id}: ${k} × ${n}`, evidence: {user: id, key: k, count: n}};
      }
    }
    return {ok: true};
  }
};

export const noKind7SelfEchoDrop: Invariant = {
  id: 'INV-no-kind7-self-echo-drop',
  tier: 'cheap',
  async check(ctx: FuzzContext, action?: any): Promise<InvariantResult> {
    // Only check right after a reactToRandomBubble or reactMultipleEmoji.
    if(!action || (action.name !== 'reactToRandomBubble' && action.name !== 'reactMultipleEmoji')) return {ok: true};
    if(action.skipped) return {ok: true};
    const user = ctx.users[action.args.user as 'userA' | 'userB'];
    const rows = await storeAllOn(user);
    const expected: string[] = action.name === 'reactMultipleEmoji' ? action.args.emojis : [action.args.emoji];
    for(const em of expected) {
      const match = rows.find((r: any) => r.emoji === em && r.fromPubkey);
      if(!match) {
        return {ok: false, message: `own kind-7 emoji ${em} missing from sender store (self-echo drop)`, evidence: {user: action.args.user, expected: em}};
      }
    }
    return {ok: true};
  }
};

export const reactionBilateral: Invariant = {
  id: 'INV-reaction-bilateral',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    const [rowsA, rowsB] = await Promise.all([
      storeAllOn(ctx.users.userA),
      storeAllOn(ctx.users.userB)
    ]);
    // Every row on A with fromPubkey=ownPubkeyA must appear on B too (and vice versa).
    const ownA = await ctx.users.userA.page.evaluate(() => (window as any).__nostraOwnPubkey);
    const ownB = await ctx.users.userB.page.evaluate(() => (window as any).__nostraOwnPubkey);
    for(const row of rowsA) {
      if(row.fromPubkey !== ownA) continue;
      const mirror = rowsB.find((r: any) => r.reactionEventId === row.reactionEventId);
      if(!mirror) {
        return {ok: false, message: `reaction ${row.emoji} (${row.reactionEventId}) from A not propagated to B`, evidence: {row}};
      }
    }
    for(const row of rowsB) {
      if(row.fromPubkey !== ownB) continue;
      const mirror = rowsA.find((r: any) => r.reactionEventId === row.reactionEventId);
      if(!mirror) {
        return {ok: false, message: `reaction ${row.emoji} (${row.reactionEventId}) from B not propagated to A`, evidence: {row}};
      }
    }
    return {ok: true};
  }
};

export const reactionAuthorCheck: Invariant = {
  id: 'INV-reaction-author-check',
  tier: 'regression',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const rows = await storeAllOn(ctx.users[id]);
      // Check: for each row, verify reactionEventId is a well-formed hex (NIP-01 64 chars).
      for(const r of rows) {
        if(!/^[0-9a-f]{64}$/i.test(r.reactionEventId)) {
          return {ok: false, message: `malformed reactionEventId on ${id}: ${r.reactionEventId}`, evidence: {user: id, row: r}};
        }
      }
    }
    return {ok: true};
  }
};

export const reactionRemoveKind: Invariant = {
  id: 'INV-reaction-remove-kind',
  tier: 'regression',
  async check(ctx: FuzzContext, action?: any): Promise<InvariantResult> {
    // Only triggered post-removeReaction: verify kind-5 event exists on relay
    // referencing the removed reactionEventId.
    if(!action || action.name !== 'removeReaction' || action.skipped) return {ok: true};
    const removedId = action.meta?.removedReactionId;
    if(!removedId) return {ok: true};
    const events = await ctx.relay.getAllEvents();
    const deletes = events.filter((e: any) => e.kind === 5);
    const match = deletes.find((e: any) => e.tags?.some((t: any[]) => t[0] === 'e' && t[1] === removedId));
    if(!match) {
      return {ok: false, message: `removeReaction did not emit a kind-5 targeting ${removedId}`, evidence: {removedId, kind5Count: deletes.length}};
    }
    return {ok: true};
  }
};
```

- [ ] **Step 2: Write the invariants unit test**

Create `src/tests/fuzz/invariants/reactions.test.ts`:

```ts
// @vitest-environment jsdom
import {describe, it, expect, vi} from 'vitest';
import {reactionDedupe, noKind7SelfEchoDrop, reactionAuthorCheck} from './reactions';

function mkCtx(rowsByUser: Record<'userA' | 'userB', any[]>): any {
  const mk = (rows: any[]) => ({
    page: {
      evaluate: vi.fn(async () => rows)
    }
  });
  return {
    users: {userA: mk(rowsByUser.userA), userB: mk(rowsByUser.userB)},
    relay: {getAllEvents: vi.fn(async () => [])}
  };
}

describe('INV-reaction-dedupe', () => {
  it('passes when compound keys are unique', async () => {
    const ctx = mkCtx({
      userA: [{targetEventId: 'e1', fromPubkey: 'p1', emoji: '👍'}],
      userB: []
    });
    const r = await reactionDedupe.check(ctx);
    expect(r.ok).toBe(true);
  });

  it('fails when compound key repeats', async () => {
    const ctx = mkCtx({
      userA: [
        {targetEventId: 'e1', fromPubkey: 'p1', emoji: '👍'},
        {targetEventId: 'e1', fromPubkey: 'p1', emoji: '👍'}
      ],
      userB: []
    });
    const r = await reactionDedupe.check(ctx);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/duplicate/);
  });
});

describe('INV-no-kind7-self-echo-drop', () => {
  it('passes when own emoji is in the store', async () => {
    const ctx = mkCtx({
      userA: [{emoji: '👍', fromPubkey: 'pA'}],
      userB: []
    });
    const r = await noKind7SelfEchoDrop.check(ctx, {
      name: 'reactToRandomBubble', args: {user: 'userA', emoji: '👍'}
    });
    expect(r.ok).toBe(true);
  });

  it('fails when own emoji missing', async () => {
    const ctx = mkCtx({
      userA: [{emoji: '❤️', fromPubkey: 'pA'}],
      userB: []
    });
    const r = await noKind7SelfEchoDrop.check(ctx, {
      name: 'reactToRandomBubble', args: {user: 'userA', emoji: '👍'}
    });
    expect(r.ok).toBe(false);
  });
});

describe('INV-reaction-author-check', () => {
  it('fails on malformed reactionEventId', async () => {
    const ctx = mkCtx({
      userA: [{emoji: '👍', fromPubkey: 'pA', reactionEventId: 'not-hex'}],
      userB: []
    });
    const r = await reactionAuthorCheck.check(ctx);
    expect(r.ok).toBe(false);
  });

  it('passes on well-formed reactionEventId (64 hex)', async () => {
    const ctx = mkCtx({
      userA: [{emoji: '👍', fromPubkey: 'pA', reactionEventId: 'a'.repeat(64)}],
      userB: []
    });
    const r = await reactionAuthorCheck.check(ctx);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run the test**

```bash
npx vitest run src/tests/fuzz/invariants/reactions.test.ts 2>&1 | tail -10
```
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tests/fuzz/invariants/reactions.ts \
        src/tests/fuzz/invariants/reactions.test.ts
git commit -m "feat(fuzz): add 5 reaction invariants (dedupe, self-echo, bilateral, author, remove-kind)"
```

---

## Task 17: Register reactions invariants in the tier runner

**Files:**
- Modify: `src/tests/fuzz/invariants/index.ts`

- [ ] **Step 1: Import and register**

Open `src/tests/fuzz/invariants/index.ts`. Add imports:

```ts
import {reactionDedupe, noKind7SelfEchoDrop, reactionBilateral, reactionAuthorCheck, reactionRemoveKind} from './reactions';
```

Add to `ALL_INVARIANTS`:

```ts
export const ALL_INVARIANTS: Invariant[] = [
  consoleClean,
  noDupMid,
  bubbleChronological,
  noAutoPin,
  sentBubbleVisibleAfterSend,
  deliveryUiMatchesTracker,
  avatarDomMatchesCache,
  // Cheap — reactions
  reactionDedupe,
  noKind7SelfEchoDrop,
  // Medium tier
  mirrorsIdbCoherent,
  peersComplete,
  deliveryTrackerNoOrphans,
  offlineQueuePurged,
  reactionBilateral,
  // Regression tier
  noNip04,
  idbSeedEncrypted,
  editPreservesMidTimestamp,
  editAuthorCheck,
  virtualPeerIdStable,
  reactionAuthorCheck,
  reactionRemoveKind
];
```

- [ ] **Step 2: Run the full fuzz invariant suite**

```bash
npx vitest run src/tests/fuzz/invariants/ 2>&1 | tail -10
```
Expected: ALL PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tests/fuzz/invariants/index.ts
git commit -m "feat(fuzz): register 5 reaction invariants in tier runner"
```

---

## Task 18: Fuzz postconditions — 3 new reactions postconditions

**Files:**
- Modify: `src/tests/fuzz/postconditions/messaging.ts`
- Modify: `src/tests/fuzz/postconditions/index.ts`

Context:
- `POST_react_peer_sees_emoji` — after reactToRandomBubble, peer's DOM has the emoji within 3s
- `POST_remove_reaction_peer_disappears` — after removeReaction, peer's DOM loses the emoji within 3s
- `POST_react_multi_emoji_separate` — after reactMultipleEmoji, sender DOM shows all emojis

- [ ] **Step 1: Add the postconditions in `messaging.ts`**

Open `src/tests/fuzz/postconditions/messaging.ts`. At the bottom add:

```ts
export const POST_react_peer_sees_emoji: Postcondition = {
  id: 'POST_react_peer_sees_emoji',
  async check(ctx: FuzzContext, action: Action) {
    if(action.skipped) return {ok: true};
    const fromUser: 'userA' | 'userB' = action.args.user;
    const toUser: 'userA' | 'userB' = fromUser === 'userA' ? 'userB' : 'userA';
    const peer = ctx.users[toUser];
    const emoji = action.args.emoji;
    const mid = action.meta?.reactedMid;
    if(!mid) return {ok: true};
    // Poll up to 3s.
    const deadline = Date.now() + 3000;
    while(Date.now() < deadline) {
      const has = await peer.page.evaluate((target) => {
        const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
        for(const b of bubbles) {
          if((b as HTMLElement).dataset.mid !== String(target.mid)) continue;
          const rt = b.querySelector('.reactions');
          if(rt && rt.textContent?.includes(target.emoji)) return true;
        }
        return false;
      }, {mid, emoji});
      if(has) return {ok: true};
      await peer.page.waitForTimeout(250);
    }
    return {ok: false, message: `peer ${toUser} never saw emoji ${emoji} on bubble ${mid}`, evidence: {from: fromUser, to: toUser, mid, emoji}};
  }
};

export const POST_remove_reaction_peer_disappears: Postcondition = {
  id: 'POST_remove_reaction_peer_disappears',
  async check(ctx: FuzzContext, action: Action) {
    if(action.skipped) return {ok: true};
    const fromUser: 'userA' | 'userB' = action.args.user;
    const toUser: 'userA' | 'userB' = fromUser === 'userA' ? 'userB' : 'userA';
    const peer = ctx.users[toUser];
    const emoji = action.meta?.emoji;
    const mid = action.meta?.mid;
    if(!emoji || !mid) return {ok: true};
    const deadline = Date.now() + 3000;
    while(Date.now() < deadline) {
      const stillThere = await peer.page.evaluate((target) => {
        const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
        for(const b of bubbles) {
          if((b as HTMLElement).dataset.mid !== String(target.mid)) continue;
          const rt = b.querySelector('.reactions');
          if(rt && rt.textContent?.includes(target.emoji)) return true;
        }
        return false;
      }, {mid, emoji});
      if(!stillThere) return {ok: true};
      await peer.page.waitForTimeout(250);
    }
    return {ok: false, message: `peer ${toUser} still shows removed emoji ${emoji} on bubble ${mid}`, evidence: {from: fromUser, to: toUser, mid, emoji}};
  }
};

export const POST_react_multi_emoji_separate: Postcondition = {
  id: 'POST_react_multi_emoji_separate',
  async check(ctx: FuzzContext, action: Action) {
    if(action.skipped) return {ok: true};
    const fromUser: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[fromUser];
    const emojis: string[] = action.meta?.emojis || [];
    const mid = action.meta?.targetMid;
    if(!emojis.length || !mid) return {ok: true};
    const deadline = Date.now() + 3000;
    while(Date.now() < deadline) {
      const visible = await sender.page.evaluate((target) => {
        const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
        for(const b of bubbles) {
          if((b as HTMLElement).dataset.mid !== String(target.mid)) continue;
          const rt = b.querySelector('.reactions');
          return rt?.textContent || '';
        }
        return '';
      }, {mid});
      if(emojis.every((em) => visible.includes(em))) return {ok: true};
      await sender.page.waitForTimeout(250);
    }
    return {ok: false, message: `sender ${fromUser} missing one of ${emojis.join(',')} on bubble ${mid}`, evidence: {user: fromUser, mid, emojis}};
  }
};
```

- [ ] **Step 2: Register in `postconditions/index.ts`**

Open `src/tests/fuzz/postconditions/index.ts`. Update the imports and the `POSTCONDITIONS` map:

```ts
import {
  POST_sendText_bubble_appears,
  POST_sendText_input_cleared,
  POST_edit_preserves_mid,
  POST_edit_content_updated,
  POST_delete_local_bubble_gone,
  POST_react_emoji_appears,
  POST_react_peer_sees_emoji,
  POST_remove_reaction_peer_disappears,
  POST_react_multi_emoji_separate
} from './messaging';

export const POSTCONDITIONS: Record<string, Postcondition[]> = {
  sendText: [POST_sendText_bubble_appears, POST_sendText_input_cleared],
  replyToRandomBubble: [POST_sendText_bubble_appears],
  editRandomOwnBubble: [POST_edit_preserves_mid, POST_edit_content_updated],
  deleteRandomOwnBubble: [POST_delete_local_bubble_gone],
  reactToRandomBubble: [POST_react_emoji_appears, POST_react_peer_sees_emoji],
  removeReaction: [POST_remove_reaction_peer_disappears],
  reactMultipleEmoji: [POST_react_multi_emoji_separate]
};
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "fuzz/postconditions" | head -5
```
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/tests/fuzz/postconditions/messaging.ts src/tests/fuzz/postconditions/index.ts
git commit -m "feat(fuzz): register 3 reactions postconditions (peer-sees, remove-disappears, multi-emoji)"
```

---

## Task 19: Re-verify 3 "potentially-stale" FINDs via replay

**Files:**
- Modify: `docs/fuzz-reports/FIND-9df3527d/README.md`
- Modify: `docs/fuzz-reports/FIND-f7b0117c/README.md`
- Modify: `docs/fuzz-reports/FIND-2f61ff8b/README.md`

Context: Task 1 triaged these. Now that reactions refactor is done, some may have closed by cascade (especially FIND-2f61ff8b — Solid createRoot leak on react path). Re-replay and finalize status.

- [ ] **Step 1: Re-replay each FIND**

Dev server running. Then:

```bash
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --replay=FIND-9df3527d 2>&1 | tail -10
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --replay=FIND-f7b0117c 2>&1 | tail -10
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --replay=FIND-2f61ff8b 2>&1 | tail -10
```

- [ ] **Step 2: For each FIND**

If `not reproduced`: update README with status `closed-stale-verified-in-2b1` and the commit SHA from Task 12 (which introduces the render path; if the leak came from a different site, cite the relevant commit).

If `reproduced`: investigate. Likely small — the Solid createRoot leak in FIND-2f61ff8b may need a `createRoot` wrapper around the reactions renderer. Add a task to hunt and fix inline; document in the FIND README.

- [ ] **Step 3: Commit READMEs**

```bash
git add docs/fuzz-reports/FIND-9df3527d/README.md \
        docs/fuzz-reports/FIND-f7b0117c/README.md \
        docs/fuzz-reports/FIND-2f61ff8b/README.md
git commit -m "docs(fuzz): re-verify 3 FINDs post reactions refactor"
```

---

## Task 20: Update `FUZZ-FINDINGS.md` — close 5 findings

**Files:**
- Modify: `docs/FUZZ-FINDINGS.md`

- [ ] **Step 1: Rewrite the findings index**

Open `docs/FUZZ-FINDINGS.md`. Update the top banner:

```markdown
# Fuzz Findings

Last updated: <YYYY-MM-DD HH:MM:SS>
Open bugs: 0 · Fixed: 5 (in Phase 2b.1)
```

For each of the 5 findings, move them from "Open" to a new "## Fixed — Phase 2b.1" section with a `**Status**: fixed-in-2b1` / `**Status**: closed-stale-verified-in-2b1` line and reference to the relevant commit SHA.

Keep the old timeline (first-seen / last-seen dates) intact as historical record.

- [ ] **Step 2: Commit**

```bash
git add docs/FUZZ-FINDINGS.md
git commit -m "docs(fuzz): close 5 Phase 2a findings in index (all fixed in 2b.1)"
```

---

## Task 21: Emit v2b1 baseline

**Files:**
- Create: `docs/fuzz-baseline/baseline-seed42-v2b1.json`
- Delete: `docs/fuzz-baseline/baseline-seed42.json`
- Modify: `src/tests/fuzz/fuzz.ts`
- Modify: `src/tests/fuzz/replay.ts`

Context: Bump fuzzer version to `phase2b1`; update `replay.ts` to load the latest `v2bN.json`. Then run `--emit-baseline` to generate the new baseline artifact.

- [ ] **Step 1: Bump fuzzerVersion in `fuzz.ts`**

Open `src/tests/fuzz/fuzz.ts`. Find:

```ts
fuzzerVersion: 'phase2a'
```

Change to:

```ts
fuzzerVersion: 'phase2b1'
```

- [ ] **Step 2: Update `replay.ts` to prefer latest v2bN**

Open `src/tests/fuzz/replay.ts`. Find `replayBaseline`:

```bash
grep -n "replayBaseline\|baseline-seed" src/tests/fuzz/replay.ts
```

Update the path resolution to prefer the latest `baseline-seed<N>-v2bM.json` over bare `baseline-seed<N>.json`. Minimal change: scan `docs/fuzz-baseline/` for files matching `baseline-seed*-v2b*.json`, sort desc by version, return the newest.

```ts
export async function replayBaseline(): Promise<Action[]> {
  const {readdirSync, readFileSync} = await import('fs');
  const dir = 'docs/fuzz-baseline';
  const candidates = readdirSync(dir).filter((f) => /^baseline-seed\d+(-v2b\d+)?\.json$/.test(f));
  if(!candidates.length) throw new Error('[replay] no baseline found in ' + dir);
  // Prefer v2bN over unversioned; within v2bN prefer higher N.
  const score = (name: string): number => {
    const m = name.match(/-v2b(\d+)\.json$/);
    return m ? 1000 + Number(m[1]) : 0;
  };
  candidates.sort((a, b) => score(b) - score(a));
  const path = `${dir}/${candidates[0]}`;
  const raw = JSON.parse(readFileSync(path, 'utf-8'));
  if(raw.fuzzerVersion && raw.fuzzerVersion !== 'phase2b1') {
    console.warn(`[replay] baseline fuzzerVersion=${raw.fuzzerVersion} != phase2b1 — action registry may drift; consider re-emit`);
  }
  return raw.commands as Action[];
}
```

- [ ] **Step 3: Delete the old v2a baseline**

```bash
git rm docs/fuzz-baseline/baseline-seed42.json
```

- [ ] **Step 4: Generate v2b1 baseline**

Ensure dev server is running. Then:

```bash
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --duration=10m --max-commands=50 --seed=42 --emit-baseline 2>&1 | tail -20
```
Expected: multiple clean iterations and final output line `[fuzz] baseline emitted → docs/fuzz-baseline/baseline-seed42.json`.

Since `--emit-baseline` currently writes `baseline-seed<N>.json` (no version suffix), rename the output:

```bash
mv docs/fuzz-baseline/baseline-seed42.json docs/fuzz-baseline/baseline-seed42-v2b1.json
```

Verify content:

```bash
jq '.fuzzerVersion, (.commands | length)' docs/fuzz-baseline/baseline-seed42-v2b1.json
```
Expected: `"phase2b1"` and an integer ≥ 40.

Confirm the mix includes reaction actions:

```bash
jq '[.commands[].name] | group_by(.) | map({k: .[0], n: length})' docs/fuzz-baseline/baseline-seed42-v2b1.json
```
Expected: counts including `reactToRandomBubble` ≥ 3, `removeReaction` ≥ 1, `reactMultipleEmoji` ≥ 1. If not, re-roll with a longer duration.

- [ ] **Step 5: Verify replay**

```bash
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --replay-baseline 2>&1 | tail -10
```
Expected: `all steps passed` — no new finds.

- [ ] **Step 6: Commit**

```bash
git add docs/fuzz-baseline/baseline-seed42-v2b1.json \
        src/tests/fuzz/fuzz.ts src/tests/fuzz/replay.ts
git rm docs/fuzz-baseline/baseline-seed42.json
git commit -m "feat(fuzz): v2b1 baseline (seed=42, 50 actions including reactions mix)"
```

---

## Task 22: VERIFICATION_2B1.md — 2-device manual checklist

**Files:**
- Create: `docs/VERIFICATION_2B1.md`

- [ ] **Step 1: Create the file**

```markdown
# Phase 2b.1 — 2-Device Manual Verification

Complete all steps on 2 real devices (Device A, Device B) with distinct identities, connected to the same set of relays (default config or a shared test relay). Run in production build (`pnpm build && pnpm serve` or deployed ipfs.nostra.chat), NOT dev mode — dev-only Vite gotchas can mask real bugs.

## Setup

- [ ] Device A: onboard new identity (name: "Alice-2B1").
- [ ] Device B: onboard new identity (name: "Bob-2B1").
- [ ] Each device adds the other as a contact via QR exchange or Add Contact.
- [ ] Exchange 3 test messages to warm the chat cache (so reactions attach to real messages, not synthetic fixtures).

## Reactions RX

- [ ] **1. A reacts 👍 on a message from B.** Within 3 s, B's DOM shows 👍 on that bubble.
- [ ] **2. A adds ❤️ on the same bubble.** B's DOM shows both 👍 + ❤️ within 3 s.
- [ ] **3. A removes 👍 (tap the reaction to toggle off).** B's DOM shows only ❤️ within 3 s.
- [ ] **4. B reacts 🔥 on a message from A.** Within 3 s, A's DOM shows 🔥 on that bubble.
- [ ] **5. Both A and B react 👍 on the same message from A.** Both DOMs show 👍 count=2.

## Regression — 5 FINDs closed

- [ ] **6.** Send many rapid text messages trailing a whitespace (`"hi "`). Bubble appears immediately on sender. (FIND-9df3527d, f7b0117c)
- [ ] **7.** Scroll chat history up and down repeatedly. No `"cleanups created outside a createRoot"` warning in console. (FIND-2f61ff8b)
- [ ] **8.** Send a message then immediately delete it. No `center_icon` console error. (FIND-2fda8762)
- [ ] **9.** React to a bubble then scroll. No `wrapSticker 'sticker'` console error. (FIND-7fd7bc72)

## Result

- [ ] Every box above is checked.
- [ ] No console errors (non-allowlisted) observed throughout.

Report on the PR: `PASS 2B.1 manual` or specific checkbox that failed + logs.
```

- [ ] **Step 2: Commit**

```bash
git add docs/VERIFICATION_2B1.md
git commit -m "docs(fuzz): VERIFICATION_2B1.md — 2-device manual checklist"
```

---

## Task 23: CLAUDE.md — Phase 2b.1 notes

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add a 2b.1 subsection**

Open `CLAUDE.md`. Find the "Bug Fuzzer (stateful property-based)" section (search `pnpm fuzz` or `Phase 2a closed`). Below the existing "Phase 2a closed three P2P blockers…" paragraph, add:

```markdown
**Phase 2b.1 closed** the NIP-25 reactions RX bilateral path plus 5 open FINDs from Phase 2a overnight (2 tweb `reaction.ts` crashes on `center_icon`/`sticker`, 1 Solid `createRoot` leak, 2 trailing-space stale). New modules: `src/lib/nostra/nostra-reactions-{store,publish,receive}.ts`. Relay subscription extended to `{kinds: [1059, 7, 5]}`. Baseline bumped to `baseline-seed42-v2b1.json` — replay in 30s via `pnpm fuzz --replay-baseline`. Spec: `docs/superpowers/specs/2026-04-19-bug-fuzzer-phase-2b-design.md` §5.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): note Phase 2b.1 reactions RX + baseline bump"
```

---

## Task 24: Tech gate — full automated sweep

**Files:**
- No code changes. Deliverable: all commands pass.

Context: Final automated gate before the PR goes for 2-device manual. If anything here fails, fix the underlying issue before proceeding.

- [ ] **Step 1: Unit + fuzz test suite**

```bash
pnpm test:nostra:quick
```
Expected: all PASS (≥ 396 tests + the new reactions tests ≈ 25 more).

- [ ] **Step 2: Fuzz directory tests**

```bash
npx vitest run src/tests/fuzz/ 2>&1 | tail -10
```
Expected: all PASS.

- [ ] **Step 3: Lint**

```bash
pnpm lint
```
Expected: 0 errors.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
```
Expected: ≤ 30 (vendor baseline).

- [ ] **Step 5: 30-min fuzz run**

Ensure dev server is running. In another terminal:

```bash
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --duration=30m --max-commands=50 --seed=42 2>&1 | tee /tmp/fuzz-2b1-gate.log | tail -30
```
Expected: `[fuzz] done. iterations=X findings=0`. If findings > 0 but all are `dup` of closed FINDs: acceptable (document in gate report). If findings include NEW ones: fix before PR.

- [ ] **Step 6: Baseline replay**

```bash
FUZZ_APP_URL=http://localhost:8080 pnpm fuzz --replay-baseline 2>&1 | tail -10
```
Expected: `all steps passed`.

- [ ] **Step 7: E2E suite**

```bash
pnpm test:e2e:all 2>&1 | tail -20
```
Expected: all PASS.

- [ ] **Step 8: Write tech gate report**

Create `docs/fuzz-reports/PHASE_2B1_TECH_GATE.md`:

```markdown
# Phase 2b.1 Tech Gate — Run results

Date: <YYYY-MM-DD>

## Automated acceptance

- `pnpm test:nostra:quick` — PASS (<N> tests)
- `npx vitest run src/tests/fuzz/` — PASS (<N> tests)
- `pnpm lint` — 0 errors
- `npx tsc --noEmit` — <N> errors (vendor baseline)
- `pnpm fuzz --duration=30m --max-commands=50 --seed=42` — 0 NEW findings across <N> iterations
- `pnpm fuzz --replay-baseline` — PASS
- `pnpm test:e2e:all` — PASS

## Tech gate status

Spec §5.6 (automated) — **PASS**.

Ready for 2-device manual (§5.6 per `docs/VERIFICATION_2B1.md`) and baseline artifact audit.
```

- [ ] **Step 9: Commit gate report**

```bash
git add docs/fuzz-reports/PHASE_2B1_TECH_GATE.md
git commit -m "docs(fuzz): Phase 2b.1 tech gate PASS (0 NEW finds + baseline replay OK)"
```

---

## Task 25: Open PR

**Files:**
- No code changes.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin HEAD
```

- [ ] **Step 2: Open PR with `gh`**

```bash
gh pr create --title "feat(fuzz): phase 2b.1 — reactions NIP-25 RX + close 5 Phase 2a FINDs" --body "$(cat <<'EOF'
## Summary

- NIP-25 reactions RX bilaterale (publish + receive + remove + multi-emoji + aggregation).
- Chiusi 5 open FINDs da Phase 2a overnight (2 tweb `reaction.ts` guard crashes, 1 Solid `createRoot` leak, 2 trailing-space stale già fixed in 2a).
- Nuovi moduli: `nostra-reactions-{store,publish,receive}.ts`. Relay subscription extended a `{kinds: [1059, 7, 5]}`.
- Baseline v2b1 committed — `pnpm fuzz --replay-baseline` in 30s.
- Spec: `docs/superpowers/specs/2026-04-19-bug-fuzzer-phase-2b-design.md` §5.

## Test plan
- [ ] Tech gate: `pnpm test:nostra:quick` PASS
- [ ] Tech gate: `npx vitest run src/tests/fuzz/` PASS
- [ ] Tech gate: `pnpm lint` 0 errors
- [ ] Tech gate: `pnpm fuzz --duration=30m --seed=42` 0 NEW finds
- [ ] Tech gate: `pnpm fuzz --replay-baseline` PASS
- [ ] 2-device manual: `docs/VERIFICATION_2B1.md` — all 9 checks PASS
- [ ] 0 open FIND in FUZZ-FINDINGS.md
- [ ] 0 mute invariants

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Record PR URL**

Save the PR URL output from Step 2 for reference. Ping the maintainer for 2-device manual run + merge approval.

---

## Execution notes (post-completion)

Task 21 baseline emit: BLOCKED during execution. The architectural identity triple fix (see `docs/fuzz-reports/FIND-e49755c1/README.md`) closed the mid/IDB drift that originally triggered during baseline runs. A subsequent fuzz run (seed=42, duration=6m, --emit-baseline) completed 5 clean iterations before seed=48 iter 6 surfaced a NEW `INV-bubble-chronological` failure (FIND-c0046153). Different seeds surfaced further pre-existing bugs. All 3 logged as open for 2b.2.

Decision: ship 2b.1 reactions RX + architectural fix; defer baseline emit + 3 new open FINDs to 2b.2.

Task 24 tech gate adapted: unit tests + lint + tsc pass. Fuzz run deferred to 2b.2.
Task 25 PR opened with carry-forward documentation.

Completed commits on `fuzz-phase-2b1`: 26 (reactions infrastructure + architectural fix + docs + fuzz emit prep). Baseline file NOT emitted to main.

---

## Self-Review Notes

Before claiming the plan done, verify:

1. **Spec coverage**:
   - Spec §5.1 (FIND re-triage) → Task 1, Task 19
   - Spec §5.2 (reactions architecture) → Tasks 2-10, 12
   - Spec §5.2 (tweb crash fix) → Task 11
   - Spec §5.3 (actions) → Tasks 13, 14, 15
   - Spec §5.4 (invariants + postconditions) → Tasks 16, 17, 18
   - Spec §5.5 (baseline) → Task 21
   - Spec §5.6 (acceptance) → Tasks 22, 23, 24
2. **No placeholders**: all code blocks contain real code. Only `<YYYY-MM-DD>` and `<N>` placeholders left — those are timestamps/counts the engineer fills at gate time.
3. **Type consistency**:
   - `ReactionRow` shape (targetEventId, targetMid, targetPeerId, fromPubkey, emoji, reactionEventId, createdAt) is used consistently across Tasks 2, 3, 4, 8, 16, 18.
   - `nostraReactionsPublish.publish(args: PublishArgs)` — PublishArgs shape is defined in Task 3 and consumed identically in Task 6 (VMT handler), Task 8 (local shim), Task 14 (unpublish by reactionEventId only, no PublishArgs).
4. **No undefined references**: `isP2PPeer` (Task 11 fallback) is already exported from `@lib/nostra/nostra-bridge` per the codebase. `ctx.relay.getAllEvents()` already exists (`src/tests/e2e/helpers/local-relay.ts:179`). `nostraReactionsStore` getter `getAll()` is defined in Task 2.

Plan complete.
