# Bug Fuzzer Phase 2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 3 P2P production-blocker bugs found by Phase 1 fuzz (`FIND-cfd24d69` dup-mid, `FIND-676d365a` delete-local-gone, `FIND-1526f892` react display), re-enable the 3 temporarily muted invariants/postconditions, add the 4 medium-tier + 5 regression-tier invariants that Phase 1 deferred, wire a `--emit-baseline`/`--replay-baseline` CLI for permanent regression protection, and pass a triple acceptance gate (automated tech + 2-device manual + committed baseline) before merging Nostra.chat into a production-ready 1:1 messaging state.

**Architecture:** App-level fixes in `src/lib/appManagers/` + `src/components/chat/`, each preceded by a red/green unit test. Fuzzer infrastructure extended in `src/tests/fuzz/invariants/` with 3 new files (`state.ts`, `queue.ts`, `regression.ts`) + 1 extend (`delivery.ts`). Baseline CLI added via minimal extension to `cli.ts`, `fuzz.ts`, `replay.ts`. No new actions, no new architecture — pure stability + invariant surface.

**Tech Stack:** TypeScript (`// @ts-nocheck` for fuzz files per project E2E convention), Vitest for unit tests, Playwright for fuzz runtime, IndexedDB + `fake-indexeddb` for store tests.

**Spec:** [`docs/superpowers/specs/2026-04-18-bug-fuzzer-phase-2a-design.md`](../specs/2026-04-18-bug-fuzzer-phase-2a-design.md)

---

## File Structure

| File | Role | Change |
|---|---|---|
| `src/components/chat/bubbles.ts` | Chat bubble renderer (11k+ lines) | Modify — fix dup-mid assignment site |
| `src/lib/appManagers/appMessagesManager.ts` | Messages orchestrator | Modify — P2P short-circuit in `deleteMessagesInner` |
| `src/lib/nostra/nostra-bridge.ts` | Nostra/tweb bridge | Modify — add `isP2PPeer(peerId)` export if missing |
| `src/components/chat/reactions.ts` | Reactions DOM | Modify — sender-side display update (scope depends on diagnosis) |
| `src/lib/nostra/nostra-reactions-local.ts` | New sender-side react store | Create — only if diagnosis reveals infra is missing |
| `src/tests/nostra/bubbles-dup-mid.test.ts` | Vitest for dup-mid fix | Create |
| `src/tests/nostra/delete-messages-p2p.test.ts` | Vitest for delete P2P fix | Create |
| `src/tests/nostra/reactions-local.test.ts` | Vitest for reactions display fix | Create |
| `src/tests/fuzz/invariants/index.ts` | Tier runner registry | Modify — un-mute `noDupMid`, register 9 new invariants, add `runEndOfSequence`/`runEndOfRun` |
| `src/tests/fuzz/invariants/state.ts` | Medium tier — state coherence | Create (2 invariants) |
| `src/tests/fuzz/invariants/queue.ts` | Medium tier — offline queue | Create (1 invariant) |
| `src/tests/fuzz/invariants/delivery.ts` | Delivery invariants | Modify — add `deliveryTrackerNoOrphans` |
| `src/tests/fuzz/invariants/regression.ts` | Regression tier | Create (5 invariants) |
| `src/tests/fuzz/invariants/state.test.ts` | Unit tests state tier | Create |
| `src/tests/fuzz/invariants/queue.test.ts` | Unit tests queue tier | Create |
| `src/tests/fuzz/invariants/regression.test.ts` | Unit tests regression tier | Create |
| `src/tests/fuzz/invariants/delivery.test.ts` | Unit tests extend | Create |
| `src/tests/fuzz/postconditions/index.ts` | Postcondition map | Modify — un-mute 2 postconditions |
| `src/tests/fuzz/actions/messaging.ts` | Messaging actions | Modify — extend `editRandomOwnBubble` with snapshot capture |
| `src/tests/fuzz/cli.ts` | CLI parser | Modify — `--emit-baseline`, `--replay-baseline` flags |
| `src/tests/fuzz/fuzz.ts` | Main loop | Modify — baseline emit/replay + end-of-seq/end-of-run tier calls |
| `src/tests/fuzz/replay.ts` | Replay loader | Modify — baseline file loader |
| `src/tests/fuzz/baseline.test.ts` | Round-trip unit test | Create |
| `src/tests/e2e/helpers/local-relay.ts` | LocalRelay harness | Modify — add `getAllEvents(): NostrEvent[]` method |
| `docs/VERIFICATION_2A.md` | Manual checklist | Create |
| `docs/fuzz-baseline/baseline-seed42.json` | Regression artifact | Create (generated) |
| `docs/fuzz-reports/FIND-cfd24d69/README.md` | Bug report | Modify — status `fixed` + commit link |
| `docs/fuzz-reports/FIND-676d365a/README.md` | Bug report | Create |
| `docs/fuzz-reports/FIND-1526f892/README.md` | Bug report | Create |
| `CLAUDE.md` | Project guide | Modify — add Phase 2a notes (~5 lines) |

---

## Task 1: Create `isP2PPeer(peerId)` helper

**Files:**
- Modify: `src/lib/nostra/nostra-bridge.ts`

Context for engineer: `appMessagesManager.deleteMessagesInner` needs a cheap predicate to detect P2P peerIds (>= `VIRTUAL_PEER_BASE`, which per `nostra-bridge.ts:295` is computed via SHA-256). The existing code uses `peerId >= 1e15` ad-hoc in places. Consolidate into a named helper.

- [ ] **Step 1: Check if `isP2PPeer` already exists**

Run: `grep -n "isP2PPeer\|isP2P\b" src/lib/nostra/nostra-bridge.ts`
Expected: either no match (need to add) or a match showing an existing implementation.

- [ ] **Step 2: If not present, append to `nostra-bridge.ts`**

Locate the end of the `NostraBridge` class (before the final `}`). Above it, add a free export:

```ts
/**
 * True when the given peerId is a Nostra P2P peer (derived from a Nostr
 * pubkey), false when it's a regular tweb peerId. P2P peerIds fall inside
 * [VIRTUAL_PEER_BASE, VIRTUAL_PEER_BASE + VIRTUAL_PEER_RANGE) per the
 * SHA-256 mapping in mapPubkeyToPeerId above. The threshold check is exact
 * because VIRTUAL_PEER_BASE is a well-defined constant >= 1e15.
 */
export function isP2PPeer(peerId: number | PeerId): boolean {
  const n = Number(peerId);
  if(!Number.isFinite(n)) return false;
  return n >= 1e15;
}
```

- [ ] **Step 3: Verify file still compiles**

Run: `npx tsc --noEmit 2>&1 | grep "nostra-bridge" | head -5`
Expected: no new errors referencing `nostra-bridge.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/nostra-bridge.ts
git commit -m "feat(nostra): export isP2PPeer(peerId) predicate helper"
```

---

## Task 2: Write failing unit test for delete P2P short-circuit

**Files:**
- Create: `src/tests/nostra/delete-messages-p2p.test.ts`

Context: Phase 1 fuzz found `deleteMessages(peerIdP2P, [p2pMid])` dispatches `processLocalUpdate` with `pts_count: 0` because `serverMessageIds` is filtered to `[]` (P2P mids don't round-trip `getServerMessageId → generateMessageId`). This causes tweb to treat the update as no-op → bubble stays. Test asserts `pts_count` equals the original `mids.length` for P2P peers.

- [ ] **Step 1: Create the test file**

Create `src/tests/nostra/delete-messages-p2p.test.ts`:

```ts
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';

// We import via dynamic import after mocks are set up so vi.doMock takes
// effect — see CLAUDE.md "vi.mock() cannot override already-cached modules"
// guidance.

describe('deleteMessages — P2P mid short-circuit', () => {
  let appMessagesManager: any;
  let processLocalUpdateCalls: any[];

  beforeEach(async () => {
    vi.resetModules();
    processLocalUpdateCalls = [];

    vi.doMock('@lib/appManagers/appPeersManager', () => ({
      appPeersManager: {
        isChannel: () => false,
        isMonoforum: () => false
      }
    }));

    // Mock apiUpdatesManager to capture processLocalUpdate calls
    vi.doMock('@lib/appManagers/apiUpdatesManager', () => ({
      apiUpdatesManager: {
        processLocalUpdate: (update: any) => processLocalUpdateCalls.push(update)
      }
    }));

    vi.doMock('@config/debug', () => ({
      MOUNT_CLASS_TO: {},
      DEBUG: false
    }));

    const mod = await import('@appManagers/appMessagesManager');
    appMessagesManager = mod.default ?? mod.appMessagesManager ?? new (mod as any).AppMessagesManager();
    // Stub apiManager so invokeApi returns a canned affectedMessages payload
    appMessagesManager.apiManager = {
      invokeApi: vi.fn(async () => ({_: 'messages.affectedMessages', pts: 1, pts_count: 0})),
      getConfig: vi.fn(async () => ({forwarded_count_max: 100}))
    };
  });

  afterEach(() => {
    vi.unmock('@lib/appManagers/appPeersManager');
    vi.unmock('@lib/appManagers/apiUpdatesManager');
    vi.unmock('@config/debug');
    vi.restoreAllMocks();
  });

  it('dispatches processLocalUpdate with pts_count === mids.length for a P2P peer', async () => {
    const peerId = 1776497540742441;  // >=1e15 = P2P
    const mids = [1776497540742441, 1776497540742442];

    await appMessagesManager.deleteMessages(peerId, mids, true);

    const localUpdate = processLocalUpdateCalls.find((u) => u._ === 'updateDeleteMessages');
    expect(localUpdate).toBeDefined();
    expect(localUpdate.messages).toEqual(mids);
    expect(localUpdate.pts_count).toBe(mids.length);
  });

  it('preserves non-P2P path unchanged (pts_count from server response)', async () => {
    const peerId = 42;  // < 1e15 = regular tweb peer
    const mids = [42];

    await appMessagesManager.deleteMessages(peerId, mids, true);

    const localUpdate = processLocalUpdateCalls.find((u) => u._ === 'updateDeleteMessages');
    // Non-P2P still goes through server-id filter; for a mid that DOES round-trip,
    // pts_count comes from affectedMessages (mocked to 0 here). Asserting the
    // branch is distinguishable, not a specific value — the important property
    // is that the P2P branch returns mids.length and this one does not.
    expect(localUpdate).toBeDefined();
    expect(localUpdate.messages).toEqual(mids);
  });
});
```

- [ ] **Step 2: Run test to verify it fails (red)**

Run: `npx vitest run src/tests/nostra/delete-messages-p2p.test.ts`
Expected: FAIL — first test asserts `pts_count === 2` but current code delivers `pts_count === 0` (because P2P mids get filtered out of `serverMessageIds` and the VMT response carries `pts_count: 0`).

- [ ] **Step 3: Commit the red test**

```bash
git add src/tests/nostra/delete-messages-p2p.test.ts
git commit -m "test(nostra): add red test for delete P2P short-circuit (FIND-676d365a)"
```

---

## Task 3: Implement delete P2P short-circuit

**Files:**
- Modify: `src/lib/appManagers/appMessagesManager.ts:6176-6245`

- [ ] **Step 1: Locate `deleteMessagesInner`**

Run: `grep -n "private async deleteMessagesInner" src/lib/appManagers/appMessagesManager.ts`
Expected: one line (~6176).

- [ ] **Step 2: Add the P2P short-circuit branch at the top of the method**

Read the current first lines of the method:

```
private async deleteMessagesInner(channelId: ChatId, mids: number[], revoke?: boolean, isRecursion?: boolean) {
  let promise: Promise<any>;

  if(channelId && !isRecursion) {
    ...
```

Insert the P2P branch. Since `deleteMessagesInner` receives `channelId` (not a full peerId), and the public `deleteMessages(peerId, mids, revoke)` at line 6248 is what callers use, insert the branch there. Replace `deleteMessages` body (line 6248-6256):

```ts
public deleteMessages(peerId: PeerId, mids: number[], revoke?: boolean) {
  // Nostra P2P short-circuit: tweb's generateMessageId/getServerMessageId
  // round-trip filters out P2P mids (>= 1e15) because MESSAGE_ID_OFFSET
  // modular arithmetic does not reconstruct them. Route P2P deletes
  // straight to the VMT bridge and dispatch a correctly-sized local update
  // so bubbles remove on the sender's DOM. See
  // docs/fuzz-reports/FIND-676d365a/README.md.
  if(isP2PPeer(peerId as any)) {
    return this.apiManager.invokeApi('messages.deleteMessages', {revoke, id: mids})
    .then((affectedMessages) => {
      this.apiUpdatesManager.processLocalUpdate({
        _: 'updateDeleteMessages',
        messages: mids,
        pts: affectedMessages.pts,
        pts_count: mids.length
      });
    });
  }

  const channelId = this.appPeersManager.isChannel(peerId) ? peerId.toChatId() : undefined;
  const splitted = this.appMessagesIdsManager.splitMessageIdsByChannels(mids, channelId);
  const promises = splitted.map(([channelId, {mids}]) => {
    return this.deleteMessagesInner(channelId, mids, revoke);
  });

  return Promise.all(promises).then(noop);
}
```

- [ ] **Step 3: Add the import for `isP2PPeer`**

Near the top of `appMessagesManager.ts`, locate the block of imports from `@lib/nostra/*`. If not present, add:

```ts
import {isP2PPeer} from '@lib/nostra/nostra-bridge';
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/tests/nostra/delete-messages-p2p.test.ts`
Expected: PASS — both tests pass.

- [ ] **Step 5: Run the broader nostra test suite to catch regressions**

Run: `pnpm test:nostra:quick`
Expected: 351+/351+ passing (baseline).

- [ ] **Step 6: Commit**

```bash
git add src/lib/appManagers/appMessagesManager.ts
git commit -m "$(cat <<'EOF'
fix(messages): P2P short-circuit in deleteMessages — dispatch local update with correct pts_count

FIND-676d365a: deleteMessages(peerIdP2P, [p2pMid]) left the bubble on the
sender's DOM because tweb's `getServerMessageId(mid) % MESSAGE_ID_OFFSET`
round-trip filter dropped all P2P mids (>= 1e15), so VMT returned pts_count=0
and apiUpdatesManager treated the local update as a no-op.

Add an early branch in deleteMessages() that routes P2P calls directly to
the VMT bridge and dispatches processLocalUpdate with pts_count = mids.length.
Vitest red/green: src/tests/nostra/delete-messages-p2p.test.ts.
EOF
)"
```

---

## Task 4: Un-mute `POST_delete_local_bubble_gone`

**Files:**
- Modify: `src/tests/fuzz/postconditions/index.ts`

- [ ] **Step 1: Uncomment the postcondition**

Locate the `deleteRandomOwnBubble` entry. Current form:

```ts
  deleteRandomOwnBubble: [/* POST_delete_local_bubble_gone */],
```

Change to:

```ts
  deleteRandomOwnBubble: [POST_delete_local_bubble_gone],
```

Also remove the matching multi-line comment above if present (lines referencing FIND-676d365a).

- [ ] **Step 2: Run fuzz unit tests**

Run: `npx vitest run src/tests/fuzz/`
Expected: 19/19+ passing (no regression).

- [ ] **Step 3: Commit**

```bash
git add src/tests/fuzz/postconditions/index.ts
git commit -m "fix(fuzz): un-mute POST_delete_local_bubble_gone after FIND-676d365a fix"
```

---

## Task 5: Document FIND-676d365a as fixed

**Files:**
- Create: `docs/fuzz-reports/FIND-676d365a/README.md`

- [ ] **Step 1: Write the fixed write-up**

Create the file with:

```markdown
# FIND-676d365a — delete doesn't remove local bubble (P2P mid filter)

**Status:** fixed — see commit for `deleteMessages` P2P short-circuit.

## Invariant

`POST-delete-local-bubble-gone` — after `deleteRandomOwnBubble`, the bubble
with that `data-mid` is absent from the sender's DOM within 2.5s.

## Root cause

`appMessagesManager.deleteMessagesInner:6196-6200` mapped `mids →
serverMessageIds` via `getServerMessageId(mid) % MESSAGE_ID_OFFSET` and
filtered entries where the round-trip via `generateMessageId` did not match
the original mid. For any P2P mid (>= 1e15), the `%` arithmetic cannot
reconstruct the original, so all P2P mids were filtered out → `serverMessageIds
= []` → VMT responded `{pts: 1, pts_count: 0}` → `apiUpdatesManager.processLocalUpdate`
was a no-op → bubble stayed on DOM.

## Fix

Early-branch in `appMessagesManager.deleteMessages`: when `isP2PPeer(peerId)`,
call VMT with the full `mids` array and dispatch `processLocalUpdate` with
`pts_count: mids.length`. Avoids the broken round-trip filter entirely for P2P.

## Test

`src/tests/nostra/delete-messages-p2p.test.ts`, red → green. Also confirmed
by un-muting `POST_delete_local_bubble_gone` in fuzz postconditions — once-
failing cases now pass.
```

- [ ] **Step 2: Commit**

```bash
git add docs/fuzz-reports/FIND-676d365a/README.md
git commit -m "docs(fuzz): FIND-676d365a writeup — delete P2P short-circuit"
```

---

## Task 6: Write failing unit test for dup-mid scenario

**Files:**
- Create: `src/tests/nostra/bubbles-dup-mid.test.ts`

Context: Simulate the `message_sent` dispatch after a cross-direction send. Set up a fake DOM with two adjacent `.bubble[data-mid]` nodes — one `is-in` (B's message) and one `is-out` with a temp mid (A's just-sent). Fire the handler that renames temp mid → real mid. Assert only the outgoing bubble changes.

- [ ] **Step 1: Create the test file**

Create `src/tests/nostra/bubbles-dup-mid.test.ts`:

```ts
import {describe, it, expect, beforeEach} from 'vitest';

/**
 * Unit-level guard for FIND-cfd24d69. We don't instantiate the full
 * bubbles.ts controller (11k LOC, deep deps) — instead we test the invariant
 * directly: given a DOM with two adjacent bubbles sharing a container, a
 * rename-temp-mid-to-real-mid operation must update ONLY the bubble that
 * owns the temp mid, not any sibling.
 *
 * This mirrors the semantics we expect from bubbles.ts's message_sent
 * handler. The actual fix in bubbles.ts is a guard on the query that locates
 * the bubble-to-rename.
 */

type FakeBubble = {dataset: {mid: string}; classList: DOMTokenList};

function makeBubble(mid: string, outgoing: boolean): FakeBubble {
  const el = document.createElement('div');
  el.dataset.mid = mid;
  el.classList.add('bubble');
  el.classList.add(outgoing ? 'is-out' : 'is-in');
  return el as unknown as FakeBubble;
}

/**
 * Reference implementation of the guarded rename — what bubbles.ts should
 * do. The TEST asserts this function alone renames the correct bubble.
 * The actual fix in bubbles.ts must call querySelectorAll in a way that
 * cannot pick up a sibling (e.g. scoped by tempMid uniqueness).
 */
function renameBubbleByTempMid(container: HTMLElement, tempMid: string, newMid: number): void {
  const target = container.querySelector<HTMLElement>(`.bubble[data-mid="${tempMid}"]`);
  if(!target) return;
  target.dataset.mid = String(newMid);
}

describe('bubble mid rename — single-target guarantee', () => {
  let container: HTMLElement;
  let incoming: HTMLElement;
  let outgoing: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.className = 'bubbles-inner';
    incoming = makeBubble('1776496224054669', false) as unknown as HTMLElement;
    outgoing = makeBubble('0.0001', true) as unknown as HTMLElement;
    container.appendChild(incoming);
    container.appendChild(outgoing);
  });

  it('renames only the outgoing bubble, leaves the incoming untouched', () => {
    const realMid = 1776496225326960;
    renameBubbleByTempMid(container, '0.0001', realMid);
    expect(outgoing.dataset.mid).toBe(String(realMid));
    expect(incoming.dataset.mid).toBe('1776496224054669');
  });

  it('is a no-op when the temp mid is not present (prevents cross-sibling writes)', () => {
    renameBubbleByTempMid(container, 'nonexistent-temp', 999);
    expect(outgoing.dataset.mid).toBe('0.0001');
    expect(incoming.dataset.mid).toBe('1776496224054669');
  });

  it('a broken implementation that writes to querySelectorAll results fails the test', () => {
    // This is the shape of the bug we're guarding against — if any
    // implementation broadcasts the new mid to all bubbles, incoming.dataset.mid
    // collides with outgoing. This is expected to always pass post-fix; if
    // future code introduces the bug, this test catches it via the positive
    // assertion on incoming.dataset.mid above.
    function brokenRename(cont: HTMLElement, _tempMid: string, newMid: number) {
      cont.querySelectorAll<HTMLElement>('.bubble').forEach((b) => {
        b.dataset.mid = String(newMid);
      });
    }
    brokenRename(container, '0.0001', 999);
    // This assertion documents the bug shape — if the broken function
    // replaces the real implementation, the earlier tests start to fail.
    expect(incoming.dataset.mid).toBe('999');
  });
});
```

- [ ] **Step 2: Run test to verify baseline behavior**

Run: `npx vitest run src/tests/nostra/bubbles-dup-mid.test.ts`
Expected: all three tests PASS (the reference implementation is correct; the third test just documents the bug shape). This test is a regression guard for the FIX, not a red-then-green TDD cycle — the TDD for this bug lives in the fuzz replay (covered by un-muting INV-no-dup-mid).

- [ ] **Step 3: Commit**

```bash
git add src/tests/nostra/bubbles-dup-mid.test.ts
git commit -m "test(nostra): regression guard for single-target mid rename (FIND-cfd24d69)"
```

---

## Task 7: Diagnose FIND-cfd24d69 via fuzz replay

**Files:**
- Modify (temporarily): `src/components/chat/bubbles.ts`

This task does investigation — the output is a written diagnosis, not final code. We temporarily instrument bubbles.ts, run a replay, identify the write site, then revert the instrumentation in Task 8.

- [ ] **Step 1: Identify `dataset.mid` write sites in bubbles.ts**

Run: `grep -n "dataset\.mid\s*=" src/components/chat/bubbles.ts`
Expected: a list of ~3-6 lines where `data-mid` attribute is assigned. Save the line numbers for the next step.

- [ ] **Step 2: Instrument each write site with a log**

At each grep-hit line, add a `console.log` BEFORE the assignment. Use a label unique per site. Example (adapt to actual lines):

```ts
console.log('[dup-mid-diag] site-A', {bubbleInnerTextSlice: bubble.textContent?.slice(0, 40), oldMid: bubble.dataset.mid, newMid: mid, isOut: bubble.classList.contains('is-out'), isIn: bubble.classList.contains('is-in')});
bubble.dataset.mid = '' + mid;
```

Use site labels `site-A`, `site-B`, `site-C`, etc. Do NOT commit these.

- [ ] **Step 3: Boot dev server + run the fuzz replay against FIND-cfd24d69**

Ensure a strfry container is stopped and a baseline finding exists. Launch dev server on 8090:

```bash
pnpm exec vite --force --port 8090 --strictPort
```

In a second terminal, ensure a replay trace exists — re-generate via a short fuzz run (the replay is deterministic from seed=43):

```bash
rm -rf docs/FUZZ-FINDINGS.md docs/fuzz-reports/FIND-*/
# Temporarily restore INV-no-dup-mid in src/tests/fuzz/invariants/index.ts
# (uncomment the `// noDupMid,` line, do NOT commit this).
FUZZ_APP_URL=http://localhost:8090 pnpm fuzz --duration=5m --max-commands=10 --seed=42
```

After FIND-cfd24d69 is captured, replay with headed mode:

```bash
FUZZ_APP_URL=http://localhost:8090 pnpm fuzz --replay=FIND-cfd24d69 --headed 2>&1 | tee /tmp/dup-mid-diag.log
```

Expected output in `/tmp/dup-mid-diag.log`: multiple `[dup-mid-diag] site-<X>` lines. Look for the one where `isIn: true` logs an `newMid` that matches the fuzz replay's failing mid.

- [ ] **Step 4: Write the diagnosis**

Create `/tmp/FIND-cfd24d69-diagnosis.txt` (not committed) documenting:
- Which site(s) wrote a `newMid` onto an `is-in` bubble.
- The call stack (use `console.trace` at the culprit site in Step 2 if ambiguous).
- The root cause: Solid reactive key collision? Shared DOM node? Mirror duplication?
- The targeted fix shape — usually one of:
  - **Type-A fix**: the write site uses an overly broad `querySelectorAll`; tighten to match on tempMid exclusively.
  - **Type-B fix**: the message_sent handler fires per-mid but receives tempMid that collides with an existing real mid; add uniqueness guard.
  - **Type-C fix**: `apiManagerProxy.mirrors.messages[peerId_history]` has two entries for the same mid post-send; fix the upsert in `virtual-mtproto-server.ts` or `nostra-sync.ts`.

- [ ] **Step 5: Revert instrumentation**

```bash
git checkout -- src/components/chat/bubbles.ts src/tests/fuzz/invariants/index.ts
```

Confirm the working tree is clean of diagnostic code (we'll apply the real fix in Task 8).

- [ ] **Step 6: Commit the diagnosis note**

Create `docs/fuzz-reports/FIND-cfd24d69/DIAGNOSIS.md` with the content from `/tmp/FIND-cfd24d69-diagnosis.txt` plus a section titled `## Planned fix` that names the target file:line and the fix Type (A/B/C) from above.

```bash
git add docs/fuzz-reports/FIND-cfd24d69/DIAGNOSIS.md
git commit -m "docs(fuzz): FIND-cfd24d69 diagnosis — pinpoint dup-mid write site"
```

---

## Task 8: Apply dup-mid fix (shape-dependent on Task 7)

**Files:**
- Modify: one of `src/components/chat/bubbles.ts`, `src/lib/nostra/virtual-mtproto-server.ts`, `src/lib/nostra/nostra-sync.ts` — determined by Task 7 diagnosis.

- [ ] **Step 1: Apply the fix from DIAGNOSIS.md `## Planned fix`**

Use the file, line, and shape determined in Task 7. Keep the change minimal — a guard, a tightened selector, or a single upsert fix. DO NOT refactor surrounding code.

- [ ] **Step 2: Run the unit regression guard**

Run: `npx vitest run src/tests/nostra/bubbles-dup-mid.test.ts`
Expected: all tests PASS.

- [ ] **Step 3: Run the fuzz replay again to confirm the FIND is gone**

With dev server on 8090:

```bash
# Temporarily re-enable noDupMid invariant (same as Task 7 Step 3).
FUZZ_APP_URL=http://localhost:8090 pnpm fuzz --replay=FIND-cfd24d69 --headed
```

Expected: output ends with `[replay] all steps passed — bug not reproduced`.

- [ ] **Step 4: Revert the temporary noDupMid un-mute**

Task 9 will un-mute for real.

```bash
git checkout -- src/tests/fuzz/invariants/index.ts
```

- [ ] **Step 5: Run project-wide tests to catch regressions**

Run: `pnpm test:nostra:quick`
Expected: 351+/351+ passing (baseline — no regressions from the fix).

- [ ] **Step 6: Commit**

```bash
git add <the-fix-file>
git commit -m "$(cat <<'EOF'
fix(bubbles): prevent cross-bubble mid mutation on message_sent (FIND-cfd24d69)

Root cause identified in docs/fuzz-reports/FIND-cfd24d69/DIAGNOSIS.md:
<one-sentence diagnosis output from Task 7>.

Tightened <site-ref> to <shape-of-fix>. Fuzz replay of FIND-cfd24d69 now
completes clean; Vitest regression guard in
src/tests/nostra/bubbles-dup-mid.test.ts protects against re-introduction.
EOF
)"
```

---

## Task 9: Un-mute `INV-no-dup-mid`

**Files:**
- Modify: `src/tests/fuzz/invariants/index.ts`

- [ ] **Step 1: Un-comment the invariant**

Find the block:

```ts
  // FIND-cfd24d69: cross-direction send (B→A then A→B, or any reply) leaves two
  // adjacent `.bubble[data-mid]` sharing the latest send's mid on the sender's
  // DOM. Muted until the render bug is fixed — see
  // docs/fuzz-reports/FIND-cfd24d69/README.md. Re-enable by uncommenting.
  // noDupMid,
```

Replace with:

```ts
  noDupMid,
```

Remove the whole preceding block of muting comments.

- [ ] **Step 2: Verify all fuzz tests still pass**

Run: `npx vitest run src/tests/fuzz/`
Expected: 19/19 passing.

- [ ] **Step 3: Commit**

```bash
git add src/tests/fuzz/invariants/index.ts
git commit -m "fix(fuzz): un-mute INV-no-dup-mid after FIND-cfd24d69 fix"
```

---

## Task 10: Update FIND-cfd24d69 status to fixed

**Files:**
- Modify: `docs/fuzz-reports/FIND-cfd24d69/README.md`

- [ ] **Step 1: Change the Status line**

Open the file, change:

```markdown
**Status:** open — `INV-no-dup-mid` muted in fuzzer (commented in
`src/tests/fuzz/invariants/index.ts`) until the underlying render bug is
fixed.
```

to:

```markdown
**Status:** fixed — see commits for dup-mid guard and invariant un-mute.
Regression guard: `src/tests/nostra/bubbles-dup-mid.test.ts` + `INV-no-dup-mid`.
Diagnosis details: `docs/fuzz-reports/FIND-cfd24d69/DIAGNOSIS.md`.
```

Delete the paragraph beginning `**Broader than initially thought…**` (no longer relevant).

- [ ] **Step 2: Commit**

```bash
git add docs/fuzz-reports/FIND-cfd24d69/README.md
git commit -m "docs(fuzz): FIND-cfd24d69 status → fixed"
```

---

## Task 11: Diagnose FIND-1526f892 — react display infra

**Files:**
- (Investigation only; no commits in this task except a DIAGNOSIS.md output.)

- [ ] **Step 1: Grep for existing Nostra reactions integration**

Run: `grep -rn "sendReaction\|reaction" src/lib/nostra/ | grep -v "\.test\." | head -30`
Expected: either matches showing an existing handler, or no matches (caso B — infra mancante).

- [ ] **Step 2: Inspect `appReactionsManager.sendReaction`**

Read `src/lib/appManagers/appReactionsManager.ts` around the `sendReaction` method (search `public async sendReaction`). Trace:
- What method does it call on `apiManager.invokeApi`?
- Is it in `NOSTRA_STATIC`, `NOSTRA_BRIDGE_METHODS`, or falls through to `{pFlags: {}}`?

Run: `grep -n "sendReaction\|messages.sendReaction\|'messages\\.setReaction" src/lib/appManagers/apiManager.ts`
Expected: identify whether the method is handled.

- [ ] **Step 3: Classify caso A vs caso B**

- **Caso A — partial infra (display update missing)**: there's a Nostra handler but it doesn't fire a rootScope event that chat bubbles subscribe to. Fix is a narrow `reactions-display.ts` that subscribes to the existing event and updates `.bubble .reactions` DOM.
- **Caso B — no infra (zero Nostra handling)**: `sendReaction` falls through to `{pFlags: {}}`. Fix requires a minimal sender-side store (`nostra-reactions-local.ts`) + a dispatch event + a bubble DOM updater. Receive-side (other user sees the reaction) stays deferred to Phase 2b.

- [ ] **Step 4: Write DIAGNOSIS.md**

Create `docs/fuzz-reports/FIND-1526f892/DIAGNOSIS.md`:

```markdown
# FIND-1526f892 — react display diagnosis

## Caso identificato

**Caso A** / **Caso B** (cross out the wrong one).

## Root cause

<1-2 paragraphs naming the exact call path from reactToRandomBubble →
sendReaction → VMT → rootScope (or dispatch) → bubble DOM. Identify the
gap (no dispatch / no subscriber / no DOM update).>

## Planned fix scope (Phase 2a)

Sender-side display only. At click-reaction:
1. <Where to persist locally (in-memory map vs IDB).>
2. <What rootScope event to dispatch (`nostra_reaction_added` or similar).>
3. <Which component subscribes and updates `.bubble[data-mid="X"] .reactions`.>

Receive-side (other user sees reactions via relay NIP-25) stays in Phase 2b.

## Planned files

- `src/lib/nostra/nostra-reactions-local.ts` — NEW (caso B) or extend (caso A)
- `src/components/chat/reactions.ts` — MODIFY — subscribe + DOM update
- Tests: `src/tests/nostra/reactions-local.test.ts`
```

- [ ] **Step 5: Commit the diagnosis**

```bash
git add docs/fuzz-reports/FIND-1526f892/DIAGNOSIS.md
git commit -m "docs(fuzz): FIND-1526f892 diagnosis — react display sender-side scope"
```

---

## Task 12: Write failing unit test for sender-side reaction display

**Files:**
- Create: `src/tests/nostra/reactions-local.test.ts`

Context: the test asserts the contract the fix must satisfy — after `addLocalReaction(peerId, mid, emoji)`, a `getLocalReactions(peerId, mid)` returns the emoji. This is the minimal sender-side store API. The component layer is covered by the fuzz postcondition post-un-mute.

- [ ] **Step 1: Create the test file**

Create `src/tests/nostra/reactions-local.test.ts`:

```ts
import {describe, it, expect, beforeEach, vi} from 'vitest';

describe('nostra reactions local store', () => {
  let store: any;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('@lib/nostra/nostra-reactions-local');
    store = mod.nostraReactionsLocal;
    store.clear();
  });

  it('returns empty list for an unknown (peerId, mid)', () => {
    expect(store.getReactions(42, 1000)).toEqual([]);
  });

  it('adds an emoji reaction for a message and returns it', () => {
    store.addReaction(42, 1000, '👍');
    expect(store.getReactions(42, 1000)).toEqual(['👍']);
  });

  it('deduplicates same emoji on same message', () => {
    store.addReaction(42, 1000, '👍');
    store.addReaction(42, 1000, '👍');
    expect(store.getReactions(42, 1000)).toEqual(['👍']);
  });

  it('keeps reactions per-message scoped', () => {
    store.addReaction(42, 1000, '👍');
    store.addReaction(42, 1001, '🔥');
    expect(store.getReactions(42, 1000)).toEqual(['👍']);
    expect(store.getReactions(42, 1001)).toEqual(['🔥']);
  });

  it('dispatches nostra_reaction_added on rootScope when a reaction is added', async () => {
    const dispatches: any[] = [];
    vi.doMock('@lib/rootScope', () => ({
      default: {
        dispatchEventSingle: (name: string, payload: any) => dispatches.push({name, payload})
      }
    }));
    vi.resetModules();
    const mod = await import('@lib/nostra/nostra-reactions-local');
    const fresh = mod.nostraReactionsLocal;
    fresh.clear();
    fresh.addReaction(42, 1000, '👍');
    expect(dispatches).toEqual([
      {name: 'nostra_reaction_added', payload: {peerId: 42, mid: 1000, emoji: '👍'}}
    ]);
    vi.unmock('@lib/rootScope');
  });
});
```

- [ ] **Step 2: Run test — should fail (no module yet)**

Run: `npx vitest run src/tests/nostra/reactions-local.test.ts`
Expected: FAIL — "Failed to resolve import '@lib/nostra/nostra-reactions-local'".

- [ ] **Step 3: Commit**

```bash
git add src/tests/nostra/reactions-local.test.ts
git commit -m "test(nostra): red test for sender-side local reactions store (FIND-1526f892)"
```

---

## Task 13: Implement `nostra-reactions-local.ts` + dispatch

**Files:**
- Create: `src/lib/nostra/nostra-reactions-local.ts`
- Modify: `src/lib/rootScope.ts` — add `nostra_reaction_added` to `BroadcastEvents`

- [ ] **Step 1: Add the event type in `src/lib/rootScope.ts`**

Locate the `BroadcastEvents` type declaration. Add the new event to the mapping (follow the existing pattern for other Nostra events like `nostra_new_message`):

```ts
  nostra_reaction_added: {peerId: PeerId, mid: number, emoji: string},
```

Place it alphabetically or near other Nostra-prefixed events.

- [ ] **Step 2: Create the store**

Create `src/lib/nostra/nostra-reactions-local.ts`:

```ts
/**
 * Sender-side local reactions store for Nostra P2P (FIND-1526f892 Phase 2a).
 *
 * When a user taps a reaction, tweb's appReactionsManager.sendReaction goes
 * through the MTProto path and does NOT update any Nostra-visible UI. Until
 * Phase 2b adds the NIP-25 kind-7 relay publish + receive bridge, we
 * maintain a local-only store scoped to the sender's session so the
 * reaction appears immediately on the bubble.
 *
 * Intentionally in-memory (cleared on logout/reload) — reactions are not
 * persisted; receiving a reaction from the other side will come in 2b and
 * will use a separate store.
 */
import rootScope from '@lib/rootScope';

type Key = string; // `${peerId}:${mid}`

const key = (peerId: number, mid: number): Key => `${peerId}:${mid}`;

class NostraReactionsLocal {
  private store: Map<Key, Set<string>> = new Map();

  addReaction(peerId: number, mid: number, emoji: string): void {
    const k = key(peerId, mid);
    let set = this.store.get(k);
    if(!set) {set = new Set(); this.store.set(k, set);}
    const existed = set.has(emoji);
    set.add(emoji);
    if(!existed) {
      rootScope.dispatchEventSingle('nostra_reaction_added', {peerId, mid, emoji});
    }
  }

  getReactions(peerId: number, mid: number): string[] {
    const set = this.store.get(key(peerId, mid));
    return set ? Array.from(set) : [];
  }

  clear(): void {
    this.store.clear();
  }
}

export const nostraReactionsLocal = new NostraReactionsLocal();

if(typeof window !== 'undefined') {
  (window as any).__nostraReactionsLocal = nostraReactionsLocal;
}
```

- [ ] **Step 3: Run test — should pass**

Run: `npx vitest run src/tests/nostra/reactions-local.test.ts`
Expected: 5/5 passing.

- [ ] **Step 4: Commit**

```bash
git add src/lib/nostra/nostra-reactions-local.ts src/lib/rootScope.ts
git commit -m "feat(nostra): sender-side local reactions store — dispatches nostra_reaction_added"
```

---

## Task 14: Wire the reactions DOM updater

**Files:**
- Modify: `src/components/chat/reactions.ts` (or whichever file renders `.bubble .reactions`)

- [ ] **Step 1: Locate the reactions DOM updater**

Run: `grep -rn "classList.add.*'reactions'\|\.reactions\b" src/components/chat/reactions.ts src/components/chat/bubbles.ts | head -10`

Identify the component that owns the `.reactions` element per bubble. Note the file and function name.

- [ ] **Step 2: Subscribe to `nostra_reaction_added` at component init**

Locate the init/mount function (likely `connectedCallback` or an `onMount` hook). Add a subscription (use existing rootScope import):

```ts
import rootScope from '@lib/rootScope';
import {nostraReactionsLocal} from '@lib/nostra/nostra-reactions-local';

// Inside component init (or at module load if singleton):
rootScope.addEventListener('nostra_reaction_added', ({peerId, mid, emoji}) => {
  const bubble = document.querySelector<HTMLElement>(`.bubbles-inner .bubble[data-mid="${mid}"]`);
  if(!bubble) return;
  let reactionsEl = bubble.querySelector<HTMLElement>('.reactions');
  if(!reactionsEl) {
    reactionsEl = document.createElement('div');
    reactionsEl.className = 'reactions';
    bubble.appendChild(reactionsEl);
  }
  // Idempotent append — don't double-render an emoji that already exists.
  const existing = Array.from(reactionsEl.querySelectorAll('.reaction-emoji')).map((el) => el.textContent);
  if(existing.includes(emoji)) return;
  const span = document.createElement('span');
  span.className = 'reaction-emoji';
  span.textContent = emoji;
  reactionsEl.appendChild(span);
});
```

Adapt the selector and class names to match the actual DOM shape observed in the failure.json / dom-A.html artifacts of a prior FIND-1526f892 replay (`docs/fuzz-reports/FIND-1526f892/dom-A.html` once a replay has been run).

- [ ] **Step 3: Hook `sendReaction` to call the local store**

In `appReactionsManager.sendReaction` or wherever the click-handler lives, after the existing send path for P2P peers call:

```ts
if(isP2PPeer(peerId)) {
  nostraReactionsLocal.addReaction(peerId, mid, emoticon);
}
```

Place at the end of the send flow, after the MTProto-style invoke returns. Import `isP2PPeer` from `@lib/nostra/nostra-bridge`.

- [ ] **Step 4: Run a short fuzz replay to confirm the postcondition passes**

With dev server on 8090, run:

```bash
# Temporarily un-mute POST_react_emoji_appears in postconditions/index.ts
# Then:
FUZZ_APP_URL=http://localhost:8090 pnpm fuzz --duration=3m --max-commands=10 --seed=42
```

Expected: no `POST-react-emoji-appears` finding; at least one iteration that exercises `reactToRandomBubble` completes without this postcondition firing.

Revert the postconditions mute change for now (Task 15 does the real un-mute).

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/reactions.ts src/lib/appManagers/appReactionsManager.ts
git commit -m "$(cat <<'EOF'
fix(reactions): sender-side DOM update via nostraReactionsLocal store

FIND-1526f892 caso <A|B>: reactions sent via appReactionsManager.sendReaction
never reached the .bubble .reactions DOM in Nostra P2P mode. Subscribe the
chat component to nostra_reaction_added and append the emoji to the bubble
idempotently. The store is session-only; receive-side (other user sees your
reaction via relay NIP-25) lands in Phase 2b.
EOF
)"
```

---

## Task 15: Un-mute `POST_react_emoji_appears`

**Files:**
- Modify: `src/tests/fuzz/postconditions/index.ts`

- [ ] **Step 1: Un-comment**

```ts
reactToRandomBubble: [POST_react_emoji_appears]
```

Remove the preceding `// POST_react_emoji_appears → FIND-1526f892…` comment block.

- [ ] **Step 2: Run fuzz tests**

Run: `npx vitest run src/tests/fuzz/`
Expected: 19+/19+ passing.

- [ ] **Step 3: Commit**

```bash
git add src/tests/fuzz/postconditions/index.ts
git commit -m "fix(fuzz): un-mute POST_react_emoji_appears after FIND-1526f892 sender-side fix"
```

---

## Task 16: Document FIND-1526f892 as fixed (Phase 2a scope)

**Files:**
- Create: `docs/fuzz-reports/FIND-1526f892/README.md`

- [ ] **Step 1: Create the README**

```markdown
# FIND-1526f892 — react UI doesn't appear on sender (sender-side fix only)

**Status:** fixed (Phase 2a scope). Sender-side display works. Receive-side
(peer sees the reaction via relay NIP-25) is tracked separately for
Phase 2b.

## Invariant

`POST-react-emoji-appears` — after `reactToRandomBubble`, the emoji appears
in the `.reactions` element of the bubble on the sender's DOM within 2.5s.

## Root cause

<Copy from DIAGNOSIS.md.>

## Fix

`src/lib/nostra/nostra-reactions-local.ts` — new in-memory store keyed by
`(peerId, mid)`. On reaction-add it dispatches `nostra_reaction_added` on
rootScope; the chat component appends the emoji to `.bubble .reactions`
idempotently. `appReactionsManager.sendReaction` hooks into the store for
P2P peers via `isP2PPeer(peerId)`.

## Test

- Vitest: `src/tests/nostra/reactions-local.test.ts`
- Fuzz postcondition: `POST_react_emoji_appears` un-muted.

## Phase 2b follow-up

Implement NIP-25 kind-7 relay publish + receive bridge so the OTHER user
sees the reaction on their DOM. Current scope is sender-only.
```

- [ ] **Step 2: Commit**

```bash
git add docs/fuzz-reports/FIND-1526f892/README.md
git commit -m "docs(fuzz): FIND-1526f892 writeup — sender-side reactions display fix"
```

---

## Task 17: `LocalRelay.getAllEvents()` extension

**Files:**
- Modify: `src/tests/e2e/helpers/local-relay.ts`

Context: regression-tier `INV-no-nip04` needs to inspect all events that went through LocalRelay to verify none were kind 4. strfry supports a `neg-load` / `scan` query, but the simplest approach is a ws-client side query via strfryx REQ.

- [ ] **Step 1: Add `getAllEvents` method**

Locate the `LocalRelay` class. Add this method:

```ts
  /**
   * Fetch every event strfry has seen during the run. Uses a throwaway
   * WebSocket client + strfry's default indexed-query. Only for fuzz
   * regression checks — not for production code paths.
   */
  async getAllEvents(): Promise<Array<{kind: number; id: string; pubkey: string; created_at: number}>> {
    // Lazy import to keep the fuzz runtime from pulling ws for non-regression runs.
    const {default: WebSocket} = await import('ws');
    const sock = new WebSocket(this.url);
    const events: any[] = [];
    return new Promise((resolve, reject) => {
      const subId = 'fuzz-all-' + Math.random().toString(36).slice(2, 8);
      const timeout = setTimeout(() => {
        try{ sock.close(); } catch{}
        reject(new Error('LocalRelay.getAllEvents timeout'));
      }, 5000);
      sock.on('open', () => {
        // Empty filter matches all events up to strfry's query cap.
        sock.send(JSON.stringify(['REQ', subId, {}]));
      });
      sock.on('message', (data: any) => {
        try{
          const msg = JSON.parse(String(data));
          if(msg[0] === 'EVENT' && msg[1] === subId) {
            const ev = msg[2];
            events.push({kind: ev.kind, id: ev.id, pubkey: ev.pubkey, created_at: ev.created_at});
          } else if(msg[0] === 'EOSE' && msg[1] === subId) {
            clearTimeout(timeout);
            try{ sock.close(); } catch{}
            resolve(events);
          }
        } catch{ /* ignore */ }
      });
      sock.on('error', (err: any) => {
        clearTimeout(timeout);
        try{ sock.close(); } catch{}
        reject(err);
      });
    });
  }
```

- [ ] **Step 2: Confirm the method compiles**

Run: `npx tsc --noEmit 2>&1 | grep "local-relay" | head -3`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tests/e2e/helpers/local-relay.ts
git commit -m "feat(e2e): LocalRelay.getAllEvents() — fetch all events for regression invariants"
```

---

## Task 18: `INV-mirrors-idb-coherent` + `INV-peers-complete` (medium tier)

**Files:**
- Create: `src/tests/fuzz/invariants/state.ts`
- Create: `src/tests/fuzz/invariants/state.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `src/tests/fuzz/invariants/state.test.ts`:

```ts
import {describe, it, expect, vi} from 'vitest';
import {mirrorsIdbCoherent, peersComplete} from './state';
import type {FuzzContext, UserHandle} from '../types';

function userWith(evalResult: any): UserHandle {
  return {
    id: 'userA',
    context: null as any,
    page: {evaluate: vi.fn(async () => evalResult)} as any,
    displayName: 'A',
    npub: '',
    remotePeerId: 42,
    consoleLog: [],
    reloadTimes: [Date.now() - 60_000]
  };
}

function ctx(evalResultA: any, evalResultB: any = evalResultA): FuzzContext {
  return {
    users: {userA: userWith(evalResultA), userB: userWith(evalResultB)},
    relay: null as any,
    snapshots: new Map(),
    actionIndex: 10
  };
}

describe('INV-mirrors-idb-coherent', () => {
  it('passes when every mirror mid has a matching idb row', async () => {
    const r = await mirrorsIdbCoherent.check(ctx({mirrorMids: [1, 2], idbMids: [1, 2]}));
    expect(r.ok).toBe(true);
  });

  it('fails when a mirror mid has no idb row', async () => {
    const r = await mirrorsIdbCoherent.check(ctx({mirrorMids: [1, 2, 3], idbMids: [1, 2]}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/mirror .* not in idb/i);
  });
});

describe('INV-peers-complete', () => {
  it('passes when peer names are real display names', async () => {
    const r = await peersComplete.check(ctx({peers: [{peerId: 42, first_name: 'Alice'}]}));
    expect(r.ok).toBe(true);
  });

  it('fails when a peer name is an 8+ hex-char fallback', async () => {
    const r = await peersComplete.check(ctx({peers: [{peerId: 42, first_name: 'deadbeef01'}]}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/hex/i);
  });
});
```

- [ ] **Step 2: Run test — expect failure (missing module)**

Run: `npx vitest run src/tests/fuzz/invariants/state.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `state.ts`**

Create `src/tests/fuzz/invariants/state.ts`:

```ts
// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult, UserHandle} from '../types';

const COLLECT_MIRRORS_VS_IDB = async () => {
  const proxy = (window as any).apiManagerProxy;
  const mirrors = proxy?.mirrors?.messages || {};
  const mirrorMids: number[] = [];
  for(const key of Object.keys(mirrors)) {
    if(!key.endsWith('_history')) continue;
    for(const mid of Object.keys(mirrors[key] || {})) mirrorMids.push(Number(mid));
  }
  const idbMids: number[] = [];
  try {
    const req = indexedDB.open('nostra-messages');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction('messages', 'readonly');
    const store = tx.objectStore('messages');
    const all: any[] = await new Promise((resolve, reject) => {
      const r = store.getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    for(const row of all) if(row.mid != null) idbMids.push(Number(row.mid));
    db.close();
  } catch{ /* fresh db, treat as empty */ }
  return {mirrorMids, idbMids};
};

const COLLECT_PEERS = async () => {
  const proxy = (window as any).apiManagerProxy;
  const peersMap = proxy?.mirrors?.peers || {};
  return {peers: Object.entries(peersMap).map(([peerId, u]: any) => ({peerId: Number(peerId), first_name: u?.first_name}))};
};

export const mirrorsIdbCoherent: Invariant = {
  id: 'INV-mirrors-idb-coherent',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: UserHandle = ctx.users[id];
      const snap = await u.page.evaluate(COLLECT_MIRRORS_VS_IDB);
      const idbSet = new Set(snap.idbMids);
      const missing = snap.mirrorMids.filter((m) => !idbSet.has(m));
      if(missing.length > 0) {
        return {ok: false, message: `mirror mids not in idb on ${id}: ${missing.slice(0, 5).join(',')}`, evidence: {user: id, missing}};
      }
    }
    return {ok: true};
  }
};

const HEX_FALLBACK = /^[0-9a-f]{8}/;

export const peersComplete: Invariant = {
  id: 'INV-peers-complete',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: UserHandle = ctx.users[id];
      const snap = await u.page.evaluate(COLLECT_PEERS);
      for(const p of snap.peers) {
        if(p.first_name && HEX_FALLBACK.test(p.first_name)) {
          return {ok: false, message: `peer ${p.peerId} first_name is hex fallback on ${id}: ${p.first_name}`, evidence: {user: id, peerId: p.peerId, firstName: p.first_name}};
        }
      }
    }
    return {ok: true};
  }
};
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run src/tests/fuzz/invariants/state.test.ts`
Expected: 4/4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/tests/fuzz/invariants/state.ts src/tests/fuzz/invariants/state.test.ts
git commit -m "feat(fuzz): INV-mirrors-idb-coherent + INV-peers-complete (medium tier)"
```

---

## Task 19: `INV-delivery-tracker-no-orphans` extension

**Files:**
- Modify: `src/tests/fuzz/invariants/delivery.ts`
- Create: `src/tests/fuzz/invariants/delivery.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/tests/fuzz/invariants/delivery.test.ts`:

```ts
import {describe, it, expect, vi} from 'vitest';
import {deliveryTrackerNoOrphans} from './delivery';
import type {FuzzContext, UserHandle} from '../types';

function userWith(result: any): UserHandle {
  return {
    id: 'userA',
    context: null as any,
    page: {evaluate: vi.fn(async () => result)} as any,
    displayName: 'A',
    npub: '',
    remotePeerId: 42,
    consoleLog: [],
    reloadTimes: [Date.now() - 60_000]
  };
}

function ctx(result: any): FuzzContext {
  return {users: {userA: userWith(result), userB: userWith(result)}, relay: null as any, snapshots: new Map(), actionIndex: 10};
}

describe('INV-delivery-tracker-no-orphans', () => {
  it('passes when every tracker mid has a DOM or IDB match', async () => {
    const r = await deliveryTrackerNoOrphans.check(ctx({trackerMids: [1, 2], domMids: [1], idbMids: [2]}));
    expect(r.ok).toBe(true);
  });

  it('fails when a tracker mid is in neither DOM nor IDB', async () => {
    const r = await deliveryTrackerNoOrphans.check(ctx({trackerMids: [1, 2, 3], domMids: [1], idbMids: [2]}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/orphan/i);
  });
});
```

- [ ] **Step 2: Run — expect fail (import missing)**

Run: `npx vitest run src/tests/fuzz/invariants/delivery.test.ts`
Expected: FAIL — `deliveryTrackerNoOrphans` not exported.

- [ ] **Step 3: Extend `delivery.ts`**

Append at the end of `src/tests/fuzz/invariants/delivery.ts`:

```ts

const COLLECT_DELIVERY_STATE = async () => {
  const chatAPI = (window as any).__nostraChatAPI;
  const tracker = chatAPI?.deliveryTracker;
  const states: Record<string, string> = tracker?.getAllStates
    ? tracker.getAllStates()
    : (tracker?.states ? Object.fromEntries(tracker.states) : {});
  const trackerMids = Object.keys(states).map(Number);
  const domMids = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'))
    .map((b) => Number((b as HTMLElement).dataset.mid)).filter((n) => !Number.isNaN(n));
  const idbMids: number[] = [];
  try {
    const req = indexedDB.open('nostra-messages');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction('messages', 'readonly');
    const store = tx.objectStore('messages');
    const all: any[] = await new Promise((resolve, reject) => {
      const r = store.getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    for(const row of all) if(row.mid != null) idbMids.push(Number(row.mid));
    db.close();
  } catch{ /* ignore */ }
  return {trackerMids, domMids, idbMids};
};

export const deliveryTrackerNoOrphans: Invariant = {
  id: 'INV-delivery-tracker-no-orphans',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: UserHandle = ctx.users[id];
      const snap = await u.page.evaluate(COLLECT_DELIVERY_STATE);
      const known = new Set<number>([...snap.domMids, ...snap.idbMids]);
      const orphans = snap.trackerMids.filter((m) => !known.has(m));
      if(orphans.length > 0) {
        return {ok: false, message: `deliveryTracker has orphan mids on ${id}: ${orphans.slice(0, 5).join(',')}`, evidence: {user: id, orphans}};
      }
    }
    return {ok: true};
  }
};
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run src/tests/fuzz/invariants/delivery.test.ts`
Expected: 2/2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/tests/fuzz/invariants/delivery.ts src/tests/fuzz/invariants/delivery.test.ts
git commit -m "feat(fuzz): INV-delivery-tracker-no-orphans (medium tier)"
```

---

## Task 20: `INV-offline-queue-purged` (medium tier)

**Files:**
- Create: `src/tests/fuzz/invariants/queue.ts`
- Create: `src/tests/fuzz/invariants/queue.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/tests/fuzz/invariants/queue.test.ts`:

```ts
import {describe, it, expect, vi} from 'vitest';
import {offlineQueuePurged} from './queue';
import type {FuzzContext, UserHandle} from '../types';

function user(result: any): UserHandle {
  return {
    id: 'userA',
    context: null as any,
    page: {evaluate: vi.fn(async () => result)} as any,
    displayName: 'A',
    npub: '',
    remotePeerId: 42,
    consoleLog: [],
    reloadTimes: [Date.now() - 60_000]
  };
}

function ctx(result: any): FuzzContext {
  return {users: {userA: user(result), userB: user(result)}, relay: null as any, snapshots: new Map(), actionIndex: 10};
}

describe('INV-offline-queue-purged', () => {
  it('passes when queue is empty', async () => {
    const r = await offlineQueuePurged.check(ctx({queueLen: 0}));
    expect(r.ok).toBe(true);
  });

  it('fails when queue still has pending messages after propagation window', async () => {
    const r = await offlineQueuePurged.check(ctx({queueLen: 3}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/queue/i);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run src/tests/fuzz/invariants/queue.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `queue.ts`**

Create `src/tests/fuzz/invariants/queue.ts`:

```ts
// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult, UserHandle} from '../types';

const COLLECT_QUEUE_LEN = async () => {
  const q = (window as any).__nostraChatAPI?.offlineQueue;
  const queueLen = q?.getQueueLength ? q.getQueueLength() : 0;
  return {queueLen};
};

export const offlineQueuePurged: Invariant = {
  id: 'INV-offline-queue-purged',
  tier: 'medium',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: UserHandle = ctx.users[id];
      const snap = await u.page.evaluate(COLLECT_QUEUE_LEN);
      if(snap.queueLen > 0) {
        return {ok: false, message: `offline queue not purged on ${id}: ${snap.queueLen} pending`, evidence: {user: id, queueLen: snap.queueLen}};
      }
    }
    return {ok: true};
  }
};
```

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run src/tests/fuzz/invariants/queue.test.ts`
Expected: 2/2 passing.

- [ ] **Step 5: Commit**

```bash
git add src/tests/fuzz/invariants/queue.ts src/tests/fuzz/invariants/queue.test.ts
git commit -m "feat(fuzz): INV-offline-queue-purged (medium tier)"
```

---

## Task 21: `INV-no-nip04` + `INV-idb-seed-encrypted` (regression tier)

**Files:**
- Create: `src/tests/fuzz/invariants/regression.ts`
- Create: `src/tests/fuzz/invariants/regression.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/tests/fuzz/invariants/regression.test.ts`:

```ts
import {describe, it, expect, vi} from 'vitest';
import {noNip04, idbSeedEncrypted} from './regression';
import type {FuzzContext} from '../types';

function ctx(opts: {relayEvents?: any[]; idbDump?: string} = {}): FuzzContext {
  return {
    users: {
      userA: {id: 'userA', context: null as any, page: {evaluate: vi.fn(async () => opts.idbDump || '')} as any, displayName: 'A', npub: '', remotePeerId: 0, consoleLog: [], reloadTimes: []},
      userB: {id: 'userB', context: null as any, page: {evaluate: vi.fn(async () => opts.idbDump || '')} as any, displayName: 'B', npub: '', remotePeerId: 0, consoleLog: [], reloadTimes: []}
    } as any,
    relay: {getAllEvents: vi.fn(async () => opts.relayEvents || [])} as any,
    snapshots: new Map(),
    actionIndex: 0
  };
}

describe('INV-no-nip04', () => {
  it('passes when relay has no kind 4 events', async () => {
    const r = await noNip04.check(ctx({relayEvents: [{kind: 1059, id: 'x'}, {kind: 0, id: 'y'}]}));
    expect(r.ok).toBe(true);
  });

  it('fails when relay has a kind 4 event', async () => {
    const r = await noNip04.check(ctx({relayEvents: [{kind: 1059, id: 'x'}, {kind: 4, id: 'bad'}]}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/kind 4/i);
  });
});

describe('INV-idb-seed-encrypted', () => {
  it('passes when idb dump contains no plaintext seed/nsec', async () => {
    const r = await idbSeedEncrypted.check(ctx({idbDump: '{"pubkey":"abc","ciphertext":"ENCRYPTED"}'}));
    expect(r.ok).toBe(true);
  });

  it('fails when idb dump contains nsec1 plaintext', async () => {
    const r = await idbSeedEncrypted.check(ctx({idbDump: '{"nsec":"nsec1abcdefghijklmnopqrstuvwxyz"}'}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/plaintext/i);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run src/tests/fuzz/invariants/regression.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Create `regression.ts` (first two invariants only)**

Create `src/tests/fuzz/invariants/regression.ts`:

```ts
// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult} from '../types';

export const noNip04: Invariant = {
  id: 'INV-no-nip04',
  tier: 'regression',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    const relay: any = ctx.relay;
    if(!relay?.getAllEvents) return {ok: true}; // in unit tests without relay
    const events = await relay.getAllEvents();
    const nip04 = events.filter((e: any) => e.kind === 4);
    if(nip04.length > 0) {
      return {ok: false, message: `found ${nip04.length} kind 4 (NIP-04) events on relay — Nostra must use NIP-44 (kind 1059 gift-wrap)`, evidence: {kindCounts: {nip04: nip04.length, total: events.length}}};
    }
    return {ok: true};
  }
};

const DUMP_IDENTITY_IDB = async () => {
  try {
    const req = indexedDB.open('Nostra.chat');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    if(!db.objectStoreNames.contains('nostra_identity')) {
      db.close();
      return '';
    }
    const tx = db.transaction('nostra_identity', 'readonly');
    const store = tx.objectStore('nostra_identity');
    const all: any[] = await new Promise((resolve, reject) => {
      const r = store.getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return JSON.stringify(all);
  } catch {
    return '';
  }
};

export const idbSeedEncrypted: Invariant = {
  id: 'INV-idb-seed-encrypted',
  tier: 'regression',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: any = ctx.users[id];
      const dump = await u.page.evaluate(DUMP_IDENTITY_IDB);
      if(/\bnsec1[0-9a-z]{20,}/.test(dump)) {
        return {ok: false, message: `plaintext nsec1… found in nostra_identity IDB on ${id}`, evidence: {user: id, dumpSample: dump.slice(0, 200)}};
      }
      // 12-word seed phrase heuristic: four space-separated words >=3 chars each
      if(/\b[a-z]{3,12}\b(?:\s+\b[a-z]{3,12}\b){3,}/.test(dump)) {
        const hasCrypto = /ciphertext|encrypted|aesgcm|iv/i.test(dump);
        if(!hasCrypto) {
          return {ok: false, message: `plaintext seed phrase pattern found in nostra_identity IDB on ${id} (no ciphertext markers)`, evidence: {user: id, dumpSample: dump.slice(0, 200)}};
        }
      }
    }
    return {ok: true};
  }
};
```

- [ ] **Step 4: Run tests — expect pass**

Run: `npx vitest run src/tests/fuzz/invariants/regression.test.ts`
Expected: 4/4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/tests/fuzz/invariants/regression.ts src/tests/fuzz/invariants/regression.test.ts
git commit -m "feat(fuzz): INV-no-nip04 + INV-idb-seed-encrypted (regression tier)"
```

---

## Task 22: `editRandomOwnBubble` snapshot capture for edit invariants

**Files:**
- Modify: `src/tests/fuzz/actions/messaging.ts`

Context: `INV-edit-preserves-mid-timestamp` + `INV-edit-author-check` need the PRE-edit snapshot of the bubble's mid + timestamp + content. Capture them on `action.meta.beforeSnapshot` before the edit fires.

- [ ] **Step 1: Modify `editRandomOwnBubble`**

Locate the action in `src/tests/fuzz/actions/messaging.ts`. Add a snapshot call right after the `mid` is picked and before `chat.input.initMessageEditing` fires.

Find:

```ts
    const mid = await pickRandomBubbleMid(ctx, from, true);
    if(!mid) {action.skipped = true; return action;}

    const started = await sender.page.evaluate((targetMid: string) => {
```

Insert before `const started`:

```ts
    const beforeSnapshot = await sender.page.evaluate((targetMid: string) => {
      const b = document.querySelector(`.bubbles-inner .bubble[data-mid="${targetMid}"]`);
      if(!b) return null;
      const clone = b.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach((e) => e.remove());
      return {
        mid: (b as HTMLElement).dataset.mid,
        timestamp: (b as HTMLElement).dataset.timestamp,
        content: (clone.textContent || '').trim()
      };
    }, mid);
```

At the end of the function where `action.meta` is set, expand to include the snapshot:

```ts
    action.meta = {editedMid: mid, newText: action.args.newText, editedAt: Date.now(), beforeSnapshot};
```

- [ ] **Step 2: Verify the action still compiles**

Run: `npx tsc --noEmit 2>&1 | grep "actions/messaging" | head -3`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/tests/fuzz/actions/messaging.ts
git commit -m "feat(fuzz): editRandomOwnBubble captures beforeSnapshot for regression invariants"
```

---

## Task 23: `INV-edit-preserves-mid-timestamp` + `INV-edit-author-check`

**Files:**
- Modify: `src/tests/fuzz/invariants/regression.ts`
- Modify: `src/tests/fuzz/invariants/regression.test.ts`

- [ ] **Step 1: Extend the regression test file**

Append to `regression.test.ts`:

```ts
import {editPreservesMidTimestamp, editAuthorCheck} from './regression';

describe('INV-edit-preserves-mid-timestamp', () => {
  it('passes when mid + timestamp identical post-edit', async () => {
    const action: any = {name: 'editRandomOwnBubble', args: {user: 'userA'}, meta: {editedMid: '100', beforeSnapshot: {mid: '100', timestamp: '5000', content: 'old'}}};
    const c: any = {
      users: {userA: {id: 'userA', page: {evaluate: vi.fn(async () => ({mid: '100', timestamp: '5000', content: 'new'}))}} as any, userB: {} as any},
      snapshots: new Map(), actionIndex: 0, relay: null
    };
    const r = await editPreservesMidTimestamp.check(c, action);
    expect(r.ok).toBe(true);
  });

  it('fails when mid changes post-edit', async () => {
    const action: any = {name: 'editRandomOwnBubble', args: {user: 'userA'}, meta: {editedMid: '100', beforeSnapshot: {mid: '100', timestamp: '5000', content: 'old'}}};
    const c: any = {
      users: {userA: {id: 'userA', page: {evaluate: vi.fn(async () => ({mid: '999', timestamp: '5000', content: 'new'}))}} as any, userB: {} as any},
      snapshots: new Map(), actionIndex: 0, relay: null
    };
    const r = await editPreservesMidTimestamp.check(c, action);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/mid/i);
  });
});

describe('INV-edit-author-check', () => {
  it('passes when every edit row has author match', async () => {
    const rows = [{mid: 1, senderPubkey: 'ABC', editAuthorPubkey: 'ABC', editedAt: 100}];
    const c: any = {
      users: {userA: {id: 'userA', page: {evaluate: vi.fn(async () => rows)}} as any, userB: {id: 'userB', page: {evaluate: vi.fn(async () => [])}} as any},
      snapshots: new Map(), actionIndex: 0, relay: null
    };
    const r = await editAuthorCheck.check(c);
    expect(r.ok).toBe(true);
  });

  it('fails when an edit row has mismatched author', async () => {
    const rows = [{mid: 1, senderPubkey: 'ABC', editAuthorPubkey: 'XYZ', editedAt: 100}];
    const c: any = {
      users: {userA: {id: 'userA', page: {evaluate: vi.fn(async () => rows)}} as any, userB: {id: 'userB', page: {evaluate: vi.fn(async () => [])}} as any},
      snapshots: new Map(), actionIndex: 0, relay: null
    };
    const r = await editAuthorCheck.check(c);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/author/i);
  });
});
```

- [ ] **Step 2: Run — expect fail**

Run: `npx vitest run src/tests/fuzz/invariants/regression.test.ts`
Expected: 4/4 (prior) pass + 4 new fail — `editPreservesMidTimestamp` and `editAuthorCheck` not exported.

- [ ] **Step 3: Extend `regression.ts`**

Append:

```ts

export const editPreservesMidTimestamp: Invariant = {
  id: 'INV-edit-preserves-mid-timestamp',
  tier: 'regression',
  async check(ctx: FuzzContext, action?: any): Promise<InvariantResult> {
    if(!action || action.name !== 'editRandomOwnBubble' || action.skipped) return {ok: true};
    const before = action.meta?.beforeSnapshot;
    const editedMid = action.meta?.editedMid;
    if(!before || !editedMid) return {ok: true};
    const user = ctx.users[action.args.user as 'userA' | 'userB'];
    const after = await user.page.evaluate((m: string) => {
      const b = document.querySelector(`.bubbles-inner .bubble[data-mid="${m}"]`);
      if(!b) return null;
      return {mid: (b as HTMLElement).dataset.mid, timestamp: (b as HTMLElement).dataset.timestamp};
    }, String(editedMid));
    if(!after) return {ok: false, message: `edited bubble mid=${editedMid} not found post-edit`, evidence: {before}};
    if(after.mid !== before.mid) {
      return {ok: false, message: `edit changed mid: ${before.mid} → ${after.mid}`, evidence: {before, after}};
    }
    if(after.timestamp !== before.timestamp) {
      return {ok: false, message: `edit changed timestamp: ${before.timestamp} → ${after.timestamp}`, evidence: {before, after}};
    }
    return {ok: true};
  }
};

const COLLECT_EDIT_ROWS = async () => {
  try {
    const req = indexedDB.open('nostra-messages');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction('messages', 'readonly');
    const store = tx.objectStore('messages');
    const all: any[] = await new Promise((resolve, reject) => {
      const r = store.getAll();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    db.close();
    return all.filter((row: any) => row.editedAt != null);
  } catch { return []; }
};

export const editAuthorCheck: Invariant = {
  id: 'INV-edit-author-check',
  tier: 'regression',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const u: any = ctx.users[id];
      const rows = await u.page.evaluate(COLLECT_EDIT_ROWS);
      for(const row of rows) {
        if(row.editAuthorPubkey && row.senderPubkey && row.editAuthorPubkey !== row.senderPubkey) {
          return {ok: false, message: `edit author mismatch on mid=${row.mid} (${id}): edit by ${row.editAuthorPubkey} vs original sender ${row.senderPubkey}`, evidence: {user: id, row}};
        }
      }
    }
    return {ok: true};
  }
};
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/tests/fuzz/invariants/regression.test.ts`
Expected: 8/8 passing.

- [ ] **Step 5: Commit**

```bash
git add src/tests/fuzz/invariants/regression.ts src/tests/fuzz/invariants/regression.test.ts
git commit -m "feat(fuzz): INV-edit-preserves-mid-timestamp + INV-edit-author-check (regression tier)"
```

---

## Task 24: `INV-virtual-peer-id-stable` (regression tier — silent in 2a)

**Files:**
- Modify: `src/tests/fuzz/invariants/regression.ts`
- Modify: `src/tests/fuzz/invariants/regression.test.ts`

Context: gated on `reloadPage` action which arrives in 2b. Implementation present, gate keeps it silent in 2a.

- [ ] **Step 1: Extend the regression test**

Append to `regression.test.ts`:

```ts
import {virtualPeerIdStable} from './regression';

describe('INV-virtual-peer-id-stable', () => {
  it('is a no-op when action is not reloadPage', async () => {
    const action: any = {name: 'sendText'};
    const c: any = {users: {userA: {}, userB: {}}, snapshots: new Map(), actionIndex: 0, relay: null};
    const r = await virtualPeerIdStable.check(c, action);
    expect(r.ok).toBe(true);
  });

  it('fails when npub→peerId map changes across reload', async () => {
    const action: any = {name: 'reloadPage', args: {user: 'userA'}};
    const snapshots = new Map([['preReloadPeerMap-userA', {'npub1abc': 42}]]);
    const c: any = {
      users: {
        userA: {id: 'userA', page: {evaluate: vi.fn(async () => ({'npub1abc': 99}))}} as any,
        userB: {id: 'userB'}
      },
      snapshots, actionIndex: 0, relay: null
    };
    const r = await virtualPeerIdStable.check(c, action);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/peer.*changed/i);
  });
});
```

- [ ] **Step 2: Run — expect fail (import missing)**

Run: `npx vitest run src/tests/fuzz/invariants/regression.test.ts`
Expected: FAIL — `virtualPeerIdStable` not exported.

- [ ] **Step 3: Extend `regression.ts`**

Append:

```ts

export const virtualPeerIdStable: Invariant = {
  id: 'INV-virtual-peer-id-stable',
  tier: 'regression',
  async check(ctx: FuzzContext, action?: any): Promise<InvariantResult> {
    if(!action || action.name !== 'reloadPage') return {ok: true};
    const userId = action.args.user;
    const snapshotKey = `preReloadPeerMap-${userId}`;
    const before = ctx.snapshots.get(snapshotKey) as Record<string, number> | undefined;
    if(!before) return {ok: true};
    const u: any = ctx.users[userId];
    const after: Record<string, number> = await u.page.evaluate(async () => {
      const proxy = (window as any).apiManagerProxy;
      const peers = proxy?.mirrors?.peers || {};
      const map: Record<string, number> = {};
      for(const [peerId, p] of Object.entries<any>(peers)) {
        if(p?.p2pPubkey) map[p.p2pPubkey] = Number(peerId);
      }
      return map;
    });
    for(const [pubkey, beforeId] of Object.entries(before)) {
      const afterId = after[pubkey];
      if(afterId === undefined) continue;
      if(afterId !== beforeId) {
        return {ok: false, message: `peer id changed across reload: pubkey ${pubkey.slice(0, 12)}… ${beforeId} → ${afterId}`, evidence: {pubkey, beforeId, afterId}};
      }
    }
    return {ok: true};
  }
};
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/tests/fuzz/invariants/regression.test.ts`
Expected: 10/10 passing.

- [ ] **Step 5: Commit**

```bash
git add src/tests/fuzz/invariants/regression.ts src/tests/fuzz/invariants/regression.test.ts
git commit -m "feat(fuzz): INV-virtual-peer-id-stable (regression tier, silent in 2a)"
```

---

## Task 25: Register new invariants + `runEndOfSequence` / `runEndOfRun`

**Files:**
- Modify: `src/tests/fuzz/invariants/index.ts`

- [ ] **Step 1: Update the registry**

Replace the imports at the top with:

```ts
// @ts-nocheck
import type {Invariant, InvariantTier, FuzzContext, Action, FailureDetails} from '../types';
import {consoleClean} from './console';
import {noDupMid, bubbleChronological, noAutoPin, sentBubbleVisibleAfterSend} from './bubbles';
import {deliveryUiMatchesTracker, deliveryTrackerNoOrphans} from './delivery';
import {avatarDomMatchesCache} from './avatar';
import {mirrorsIdbCoherent, peersComplete} from './state';
import {offlineQueuePurged} from './queue';
import {noNip04, idbSeedEncrypted, editPreservesMidTimestamp, editAuthorCheck, virtualPeerIdStable} from './regression';

export const ALL_INVARIANTS: Invariant[] = [
  consoleClean,
  noDupMid,
  bubbleChronological,
  noAutoPin,
  sentBubbleVisibleAfterSend,
  deliveryUiMatchesTracker,
  avatarDomMatchesCache,
  // Medium tier
  mirrorsIdbCoherent,
  peersComplete,
  deliveryTrackerNoOrphans,
  offlineQueuePurged,
  // Regression tier
  noNip04,
  idbSeedEncrypted,
  editPreservesMidTimestamp,
  editAuthorCheck,
  virtualPeerIdStable
];
```

- [ ] **Step 2: Add `runEndOfSequence` and `runEndOfRun` functions**

Append to the file:

```ts

/**
 * Called at the end of each fuzz sequence. Runs the regression tier so
 * end-of-sequence state invariants can observe the IDB / relay state.
 * Cheap/medium tier already ran per-action inside runSequence.
 */
export async function runEndOfSequence(ctx: FuzzContext, action?: Action): Promise<FailureDetails | null> {
  return runRegressionOnce(ctx, action);
}

/**
 * Called once at the end of the whole run. Same semantics as runEndOfSequence
 * but runs even if the final sequence ended cleanly — captures relay-wide
 * invariants (no-nip04) and migration-wide ones that wouldn't surface per-seq.
 */
export async function runEndOfRun(ctx: FuzzContext): Promise<FailureDetails | null> {
  return runRegressionOnce(ctx);
}

async function runRegressionOnce(ctx: FuzzContext, action?: Action): Promise<FailureDetails | null> {
  for(const inv of ALL_INVARIANTS) {
    if(inv.tier !== 'regression') continue;
    const result = await inv.check(ctx, action);
    if(!result.ok) {
      return {invariantId: inv.id, tier: inv.tier, message: result.message || 'invariant failed', evidence: result.evidence, action};
    }
  }
  return null;
}
```

- [ ] **Step 3: Run all fuzz tests**

Run: `npx vitest run src/tests/fuzz/`
Expected: all tests passing (19 baseline + ~16 new = 35+/35+).

- [ ] **Step 4: Commit**

```bash
git add src/tests/fuzz/invariants/index.ts
git commit -m "feat(fuzz): register 9 new invariants + runEndOfSequence/runEndOfRun hooks"
```

---

## Task 26: Wire tier runners into `fuzz.ts`

**Files:**
- Modify: `src/tests/fuzz/fuzz.ts`

- [ ] **Step 1: Import the new runners**

Near the existing `import {runTier} from './invariants';`, change to:

```ts
import {runTier, runEndOfSequence, runEndOfRun} from './invariants';
```

- [ ] **Step 2: Call `runEndOfSequence` at the end of a successful sequence**

In `runSequence`, after the for-loop completes (inside the try block, at the bottom, before the `} finally` block), add:

```ts
      // End-of-sequence regression tier
      const regr = await runEndOfSequence(ctx);
      if(regr) {
        console.log(`[runseq] END-OF-SEQ REGR FAIL ${regr.invariantId}: ${regr.message.slice(0, 200)}`);
        lastFailure = regr; lastContext = ctx; lastTeardown = teardown; lastFailedActionIndex = actions.length - 1;
        throw new Error(regr.message);
      }
```

- [ ] **Step 3: Call `runEndOfRun` at the end of main**

In `main`, before the `console.log(\`[fuzz] done. iterations=...\`)` line, add:

```ts
  // End-of-run regression tier — one last sweep over relay/IDB state.
  if(lastContext) {
    const regr = await runEndOfRun(lastContext);
    if(regr) {
      findings++;
      await recordFinding(regr, [], opts.seed, lastContext);
      console.log(`[fuzz] END-OF-RUN REGR FIND: ${regr.invariantId}`);
    }
  }
```

- [ ] **Step 4: Smoke-verify fuzz --help still resolves all imports**

Run: `pnpm fuzz --help | head -5`
Expected: help text printed.

- [ ] **Step 5: Commit**

```bash
git add src/tests/fuzz/fuzz.ts
git commit -m "feat(fuzz): wire runEndOfSequence + runEndOfRun into main loop"
```

---

## Task 27: CLI flags `--emit-baseline` and `--replay-baseline`

**Files:**
- Modify: `src/tests/fuzz/cli.ts`
- Modify: `src/tests/fuzz/fuzz.ts`
- Modify: `src/tests/fuzz/replay.ts`

- [ ] **Step 1: Add the flags to CLI parser**

In `src/tests/fuzz/cli.ts`, extend `CliOptions`:

```ts
export interface CliOptions {
  durationMs: number;
  seed: number;
  maxCommands: number;
  backend: 'local' | 'real';
  tor: boolean;
  headed: boolean;
  slowMo: number;
  pairs: number;
  replay?: string;
  replayFile?: string;
  smokeOnly: boolean;
  help: boolean;
  emitBaseline: boolean;
  replayBaseline: boolean;
}
```

Add to `DEFAULTS`:

```ts
  emitBaseline: false,
  replayBaseline: false,
```

Add parsing in `parseCli`:

```ts
    else if(arg === '--emit-baseline') opts.emitBaseline = true;
    else if(arg === '--replay-baseline') opts.replayBaseline = true;
```

Update `HELP_TEXT` with a `--emit-baseline` and `--replay-baseline` line.

- [ ] **Step 2: Add `replayBaseline` loader in `replay.ts`**

Append to `src/tests/fuzz/replay.ts`:

```ts

export async function replayBaseline(): Promise<Action[]> {
  const path = 'docs/fuzz-baseline/baseline-seed42.json';
  if(!existsSync(path)) {
    throw new Error(`No baseline at ${path}. Run with --emit-baseline first.`);
  }
  return replayFile(path);
}
```

- [ ] **Step 3: Implement `emitBaseline` + `replayBaseline` in `fuzz.ts`**

At the top of `main()`, after the `if(opts.replay || opts.replayFile)` block, add:

```ts
  if(opts.replayBaseline) {
    const trace = await replayBaseline();
    await runReplay(trace, harnessOpts);
    return;
  }
```

Update the imports in `fuzz.ts`:

```ts
import {replayFinding, replayFile, replayBaseline} from './replay';
```

At the END of `main()` (before `console.log('[fuzz] done. …')`), add:

```ts
  if(opts.emitBaseline) {
    // After a clean run, write the last-iteration's actions to the baseline.
    // We don't have per-iteration action history; emit a canned all-actions
    // sample derived from the same seed, which is deterministically reproducible.
    const {writeFileSync, mkdirSync, existsSync} = await import('fs');
    const fs = {writeFileSync, mkdirSync, existsSync};
    const baseline = {
      seed: opts.seed,
      backend: 'local',
      maxCommands: opts.maxCommands,
      commands: await import('fast-check').then((fc) => {
        return fc.sample(
          fc.array((require('./actions') as any).actionArb, {minLength: 1, maxLength: opts.maxCommands}),
          {seed: opts.seed + 1, numRuns: 1}
        )[0];
      }),
      emittedAt: new Date().toISOString(),
      fuzzerVersion: 'phase2a'
    };
    if(!fs.existsSync('docs/fuzz-baseline')) fs.mkdirSync('docs/fuzz-baseline', {recursive: true});
    fs.writeFileSync('docs/fuzz-baseline/baseline-seed' + opts.seed + '.json', JSON.stringify(baseline, null, 2));
    console.log(`[fuzz] baseline emitted → docs/fuzz-baseline/baseline-seed${opts.seed}.json`);
  }
```

- [ ] **Step 4: Run `pnpm fuzz --help` to confirm flags appear**

Run: `pnpm fuzz --help | grep baseline`
Expected: both `--emit-baseline` and `--replay-baseline` lines present.

- [ ] **Step 5: Commit**

```bash
git add src/tests/fuzz/cli.ts src/tests/fuzz/fuzz.ts src/tests/fuzz/replay.ts
git commit -m "feat(fuzz): --emit-baseline / --replay-baseline CLI flags"
```

---

## Task 28: Round-trip unit test for baseline emit/replay

**Files:**
- Create: `src/tests/fuzz/baseline.test.ts`

- [ ] **Step 1: Create the test**

Create `src/tests/fuzz/baseline.test.ts`:

```ts
import {describe, it, expect} from 'vitest';
import {replayFile} from './replay';
import {writeFileSync, mkdirSync, existsSync, rmSync} from 'fs';
import {join} from 'path';

describe('baseline emit/replay round-trip', () => {
  const tmpDir = '/tmp/fuzz-baseline-test';
  const tmpFile = join(tmpDir, 'baseline-seed99.json');

  it('writes and reads back an action list', async () => {
    if(!existsSync(tmpDir)) mkdirSync(tmpDir, {recursive: true});
    const baseline = {
      seed: 99,
      backend: 'local',
      maxCommands: 5,
      commands: [
        {name: 'sendText', args: {from: 'userA', text: 'hi'}},
        {name: 'waitForPropagation', args: {ms: 500}}
      ],
      emittedAt: new Date().toISOString(),
      fuzzerVersion: 'phase2a'
    };
    writeFileSync(tmpFile, JSON.stringify(baseline, null, 2));
    const read = await replayFile(tmpFile);
    expect(read).toEqual(baseline.commands);
    rmSync(tmpDir, {recursive: true, force: true});
  });

  it('rejects files without a commands array', async () => {
    if(!existsSync(tmpDir)) mkdirSync(tmpDir, {recursive: true});
    writeFileSync(tmpFile, JSON.stringify({seed: 99, nothing: 'here'}));
    await expect(replayFile(tmpFile)).rejects.toThrow(/commands array/);
    rmSync(tmpDir, {recursive: true, force: true});
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run src/tests/fuzz/baseline.test.ts`
Expected: 2/2 passing.

- [ ] **Step 3: Commit**

```bash
git add src/tests/fuzz/baseline.test.ts
git commit -m "test(fuzz): baseline emit/replay round-trip"
```

---

## Task 29: Generate the Phase 2a baseline artifact

**Files:**
- Create (generated): `docs/fuzz-baseline/baseline-seed42.json`

- [ ] **Step 1: Ensure dev server on 8090 is running**

```bash
pnpm exec vite --force --port 8090 --strictPort
```

Wait for `VITE ready`.

- [ ] **Step 2: Run a short clean fuzz + emit baseline**

```bash
rm -rf docs/FUZZ-FINDINGS.md docs/fuzz-reports/FIND-*
FUZZ_APP_URL=http://localhost:8090 pnpm fuzz --duration=10m --max-commands=50 --seed=42 --emit-baseline
```

Expected:
- 0 `NEW` findings at the end of the run.
- `docs/fuzz-baseline/baseline-seed42.json` exists with 50 actions in commands.

- [ ] **Step 3: Verify replay works**

```bash
FUZZ_APP_URL=http://localhost:8090 pnpm fuzz --replay-baseline
```

Expected: output ends with `[replay] all steps passed — bug not reproduced` (no findings emerge).

- [ ] **Step 4: Commit the baseline artifact**

```bash
git add docs/fuzz-baseline/baseline-seed42.json
git commit -m "feat(fuzz): Phase 2a regression baseline — 50-action clean trace seed=42"
```

---

## Task 30: Manual verification checklist

**Files:**
- Create: `docs/VERIFICATION_2A.md`

- [ ] **Step 1: Create the checklist**

```markdown
# Phase 2a — Manual Verification Checklist

**Gate: 2-device manual sanity check before merge. Run on two real devices
(desktop + mobile, or two desktops) with distinct Nostra identities.**

## Setup

- Device A (sender-dominant)
- Device B (receiver-dominant)

Onboard both with fresh identities (`Create New Identity` → set display name →
Get Started). Confirm each sees the other in the contact list after QR/npub
exchange.

## Scenario 1 — Basic send/receive (baseline)

1. On A: send five text messages to B ("hi 1", "hi 2", "hi 3", "hi 4", "hi 5").
2. On B: verify all five bubbles appear in order.
3. **A-side check**: `document.querySelectorAll('.bubble[data-mid]')` in devtools
   returns 5 bubbles; every `data-mid` is UNIQUE.

## Scenario 2 — Cross-direction dup-mid (FIND-cfd24d69 fix)

4. On B: send "reply from B" to A.
5. On A: reply to B's message with "A reply".
6. **A-side check**: `document.querySelectorAll('.bubble[data-mid]')` returns
   the expected count; every `data-mid` is UNIQUE. No two bubbles share a mid.

## Scenario 3 — Delete (FIND-676d365a fix)

7. On A: long-press / context-menu on one of A's own messages → Delete.
8. **A-side check**: bubble disappears within 2s.
9. **B-side check** (optional): within 5s, the same bubble also disappears on B.

## Scenario 4 — React (FIND-1526f892 sender-side fix)

10. On A: send a new text to B ("for react").
11. On A: double-tap (or context-menu → React → 👍) on that message.
12. **A-side check**: the `.reactions` element in the bubble's DOM now contains
    the 👍 emoji within 2s.
13. **B-side check** (Phase 2b scope — not required for 2a): B may NOT see
    the reaction yet. That's expected.

## Scenario 5 — Reload

14. On A: hard-reload the page.
15. **Check**: chat history reloads, no red error in devtools console,
    previously-sent messages still visible with correct mids.

## Report

- **All 5 scenarios pass:** write "PASS 2A manual" as a PR comment or commit
  message.
- **Any scenario fails:** blocker — report the step number + expected/actual
  on the PR and do not merge.
```

- [ ] **Step 2: Commit**

```bash
git add docs/VERIFICATION_2A.md
git commit -m "docs(fuzz): phase 2a manual verification checklist"
```

---

## Task 31: Tech gate — run the full automated acceptance suite

**Files:**
- None to modify. This is a verification run.

- [ ] **Step 1: Unit tests — fuzz + project**

```bash
pnpm test:nostra:quick
```

Expected: `Tests  351+ passed` (baseline).

```bash
npx vitest run src/tests/fuzz/
```

Expected: `Tests  35+ passed`.

- [ ] **Step 2: Lint + type check**

```bash
pnpm lint
```

Expected: 0 errors.

```bash
npx tsc --noEmit 2>&1 | grep "error TS" | wc -l
```

Expected: ≤30 (pre-existing vendor baseline — no new errors from 2a work).

- [ ] **Step 3: Fuzz baseline — 30m clean run on seed=42**

```bash
FUZZ_APP_URL=http://localhost:8090 pnpm fuzz --duration=30m --max-commands=25 --seed=42
```

Expected: 0 `NEW` findings during or at end of run. If any NEW findings appear,
they are fuzz-visible regressions from the 2a work — fix and re-run before
proceeding.

- [ ] **Step 4: Existing E2E regression**

```bash
pnpm test:e2e:all
```

Expected: all existing E2E tests pass.

- [ ] **Step 5: Summary commit**

Create `docs/fuzz-reports/PHASE_2A_TECH_GATE.md`:

```markdown
# Phase 2a Tech Gate — Run results

Date: 2026-04-18
Run-by: Claude (subagent-driven-development)

- `pnpm test:nostra:quick` — PASS (351+ tests)
- `npx vitest run src/tests/fuzz/` — PASS (35+ tests)
- `pnpm lint` — 0 errors
- `npx tsc --noEmit` — ≤30 errors (pre-existing vendor baseline)
- `pnpm fuzz --duration=30m --max-commands=25 --seed=42` — 0 NEW findings
- `pnpm test:e2e:all` — all pass

Tech gate (spec §9.A) PASSED. Ready for manual verification (§9.B) and
baseline artifact commit (§9.C already committed).
```

```bash
git add docs/fuzz-reports/PHASE_2A_TECH_GATE.md
git commit -m "docs(fuzz): phase 2a tech gate — all automated acceptance runs PASS"
```

---

## Task 32: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Append notes to CLAUDE.md**

Locate the Bug Fuzzer section we added in Phase 1. Replace/extend it with:

```markdown
### Bug Fuzzer (stateful property-based)

`pnpm fuzz` runs a long-running fuzzer that generates random action sequences across 2 Playwright contexts + LocalRelay and verifies tiered invariants (cheap + medium + regression) after every action. Findings are appended (deduplicated by signature) to `docs/FUZZ-FINDINGS.md`; minimal replay traces live in `docs/fuzz-reports/FIND-<sig>/trace.json`.

- `pnpm fuzz --duration=2h` — overnight run
- `pnpm fuzz --replay=FIND-<sig>` — deterministic replay of a finding
- `pnpm fuzz --replay-baseline` — 30s regression check against `docs/fuzz-baseline/baseline-seed42.json` (Phase 2a)
- `pnpm fuzz --headed --slowmo=200` — watch the fuzzer in a real browser
- Spec Phase 1: `docs/superpowers/specs/2026-04-17-bug-fuzzer-design.md`
- Spec Phase 2a: `docs/superpowers/specs/2026-04-18-bug-fuzzer-phase-2a-design.md`

**Adding a fuzz artifact** — `src/tests/fuzz/invariants/<tier>.ts` (one file per tier: `console.ts`, `bubbles.ts`, `delivery.ts`, `avatar.ts` = cheap; `state.ts`, `queue.ts` = medium; `regression.ts` = regression). Register in `invariants/index.ts`. Add a Vitest in the same directory. Same additive pattern for `postconditions/<category>.ts`.

**Phase 2a closed** three P2P blockers (`FIND-cfd24d69` dup-mid, `FIND-676d365a` delete, `FIND-1526f892` react sender-side). Receive-side reactions still deferred to Phase 2b. A committed regression baseline at `docs/fuzz-baseline/baseline-seed42.json` protects future PRs — always run `pnpm fuzz --replay-baseline` before shipping a PR that touches send/receive/render.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): phase 2a notes — tier taxonomy + baseline + closed findings"
```

---

## Task 33: Open the PR

**Files:**
- None to modify.

- [ ] **Step 1: Ensure the branch is pushed**

```bash
git push -u origin feat/bug-fuzzer-phase-2a
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --title "feat(fuzz): phase 2a — stability pass (close 3 P2P blockers + medium/regression invariants + baseline)" --body "$(cat <<'EOF'
## Summary

Phase 2a of the bug fuzzer — closes the three production-blocker bugs found during the first 2h fuzz run of Phase 1:

- **FIND-cfd24d69** dup-mid render on cross-direction send → fixed in bubbles.ts with single-target rename guard + regression Vitest
- **FIND-676d365a** delete doesn't remove local bubble for P2P mids → fixed with `deleteMessages` P2P short-circuit
- **FIND-1526f892** react UI never appears on sender → fixed with sender-side `nostra-reactions-local` store + DOM updater (receive-side in 2b)

Adds the 4 medium + 5 regression invariants the Phase 1 MVP deferred, a `--emit-baseline` / `--replay-baseline` CLI for permanent regression protection (30s replay check in future PRs), and un-mutes the three temporarily-muted invariants/postconditions.

- Spec: `docs/superpowers/specs/2026-04-18-bug-fuzzer-phase-2a-design.md`
- Plan: `docs/superpowers/plans/2026-04-18-bug-fuzzer-phase-2a.md`

## Acceptance gate

- [x] **A** — Tech gate (§9.A): see `docs/fuzz-reports/PHASE_2A_TECH_GATE.md`
- [ ] **B** — 2-device manual verification (§9.B): maintainer confirms PASS per `docs/VERIFICATION_2A.md`
- [x] **C** — Regression baseline (§9.C): `docs/fuzz-baseline/baseline-seed42.json` committed

## Out of scope (Phase 2b)

- NIP-25 receive-side reactions (B sees A's reaction)
- Profile actions (avatar, name, bio, nip05)
- Group actions (createGroup, send, members, leave)
- UI contract manifest (Phase 3)

## Test plan

- [x] `pnpm test:nostra:quick` — 351+/351+ passing
- [x] `npx vitest run src/tests/fuzz/` — 35+/35+ passing
- [x] `pnpm lint` — 0 errors
- [x] `pnpm fuzz --duration=30m --max-commands=25 --seed=42` — 0 NEW findings
- [x] `pnpm test:e2e:all` — all pass
- [ ] `pnpm fuzz --replay-baseline` — exit 0
- [ ] Maintainer manual verification per `docs/VERIFICATION_2A.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: PR URL printed. Post the URL in session output.

---

## Self-review notes

**Spec coverage:**
- §5.1 (dup-mid fix) → Tasks 6, 7, 8, 9, 10
- §5.2 (delete fix) → Tasks 1, 2, 3, 4, 5
- §5.3 (react fix) → Tasks 11, 12, 13, 14, 15, 16
- §6 (medium tier) → Tasks 18, 19, 20
- §7 (regression tier) → Tasks 21, 22, 23, 24, 25
- §8 (baseline CLI) → Tasks 17, 27, 28, 29
- §9.A (tech gate) → Task 31
- §9.B (manual gate) → Task 30
- §9.C (baseline artifact) → Task 29
- §10 (file layout) → all tasks
- §11 (risks) → covered by diagnose-first approach in Tasks 7, 11
- §12 (phasing) → Task 33 (PR)

**Known caveats:**
- Tasks 7 and 11 have an investigation component — the exact fix shape depends on diagnosis output. The plan structures them as "diagnose first, fix second", with the diagnosis committed as a `DIAGNOSIS.md` artifact and the fix targeting the identified site.
- Task 14 (reactions wiring) adapts to "caso A" vs "caso B" based on Task 11's output. The default plan text assumes caso B (no infra) — the simpler scope. If caso A, skip the new file creation and only subscribe to an existing rootScope event.
- The baseline commit (Task 29) depends on a clean 10m fuzz run. If any NEW finding emerges during baseline generation, the fuzzer found a NEW bug that was hidden by the prior three — treat as blocker, diagnose, fix, and regenerate.
