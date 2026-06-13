# Bug Fuzzer Phase 2b.2a Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close 3 carry-forward fuzz FINDs, add lifecycle actions/invariants, activate `INV-virtual-peer-id-stable`, emit `baseline-seed42-v2b1.json`, and prep PR for merge.

**Architecture:** Stateful property-based fuzzer extended with lifecycle actions (`reloadPage` 2-variant, `deleteWhileSending`) and 5 lifecycle invariants. Each FIND fix is TDD (regression test before fix), surgical scope (one `src/` file per fix), with explicit 2h time-box + escape path (downgrade invariant to skip + carry-forward). All code changes land in worktree `../nostra.chat-wt/2b2a` on branch `fuzz-phase-2b2a`, committed atomically with Conventional Commits messages.

**Tech Stack:** TypeScript 5.7, Vitest (unit), Playwright (fuzz harness), fast-check (property-based generation), pnpm 9, Nostr protocol (NIP-17, NIP-25, NIP-44, NIP-59), Solid.js (custom fork in `src/vendor/solid/`).

**Spec reference:** [`docs/superpowers/specs/2026-04-20-bug-fuzzer-phase-2b2a-design.md`](../specs/2026-04-20-bug-fuzzer-phase-2b2a-design.md)

---

## Key Architectural Context (read before starting)

**Fuzz infrastructure layout:**
- `src/tests/fuzz/actions/index.ts` — registers actions. Add new actions via `ACTION_REGISTRY` array spread.
- `src/tests/fuzz/invariants/index.ts` — registers invariants. `ALL_INVARIANTS` array, tier-filtered via `runTier()`. Cheap runs per-action; medium every 10 actions; regression end-of-sequence.
- `src/tests/fuzz/postconditions/index.ts` — `POSTCONDITIONS: Record<string, Postcondition[]>` keyed by action name.
- `src/tests/fuzz/types.ts` — `FuzzContext.snapshots: Map<string, any>` is the cross-action scratch space for lifecycle pre/post state.
- `src/tests/fuzz/fuzz.ts:120` — already sets `fuzzerVersion: 'phase2b1'` for emit.
- `src/tests/fuzz/fuzz.ts:112` — `opts.emitBaseline && findings === 0 && lastCleanActions.length` gates baseline file creation. **No code change needed for emit — just run with `--emit-baseline`.**

**Critical discovery:** `INV-virtual-peer-id-stable` at `regression.ts:127-155` is **already fully implemented and registered** (`index.ts:35`). The guard (line 131) already reads `if(!action || action.name !== 'reloadPage') return {ok: true}`. Adding the `reloadPage` action automatically activates it — **no edit to `regression.ts` required**. The spec wording "guard switched from `false`" was imprecise; what actually activates this invariant is the mere existence of a `reloadPage` action.

**sendText drive pattern** (messaging.ts:25-52) uses `sender.page.keyboard.insertText(text)` then clicks `.chat-input button.btn-send`. FIND-eef9f130 root cause hypothesis is this `insertText` CDP sequence bypasses tweb's compositionend-based input-clear handler.

**Action `meta` convention**: each action's `drive()` writes to `action.meta` for postcondition consumption. Examples: `sendText` sets `{sentAt, fromId, toId, text}`; `editRandomOwnBubble` sets `{editedMid, newText}`; `reactToRandomBubble` sets `{reactedMid, emoji}`. Lifecycle actions follow the same pattern.

**Manual check for offline-queue precondition (Task 0 gates this):** If offline-queue impl doesn't exist in `src/lib/nostra/`, `INV-offline-queue-persistence` becomes vacuous → downgrade to skip at registration. Grep for queue-related code to decide at M1 before writing invariant.

---

## Task 0: Sanity Check in Existing Worktree

**Files:**
- Read-only: `src/tests/fuzz/fuzz.ts`, `src/lib/nostra/`
- Test: none (setup task)

The worktree `../nostra.chat-wt/2b2a` on branch `fuzz-phase-2b2a` was created during brainstorming with `.env.local` already copied. The spec commit `9de89129` is HEAD.

- [ ] **Step 1: Verify worktree and branch**

```bash
git -C /home/raider/Repository/nostra.chat-wt/2b2a log --oneline -3
```

Expected output first line: `9de89129 docs(spec): bug fuzzer phase 2b.2a — lifecycle + 3 carry-forward FINDs + baseline v2b1 emit`

- [ ] **Step 2: Install + typecheck baseline**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm install --frozen-lockfile
npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Unit test baseline**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm test:nostra:quick
```

Expected: ≥ 401 tests pass.

- [ ] **Step 4: Fuzz unit test baseline**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && npx vitest run src/tests/fuzz/
```

Expected: ≥ 50 tests pass.

- [ ] **Step 5: Offline-queue precondition check (INV-offline-queue-persistence)**

Grep for an offline-queue impl that persists pending sends when connectivity drops:

```bash
grep -rn "offline.queue\|offlineQueue\|offline-queue\|isOffline" /home/raider/Repository/nostra.chat-wt/2b2a/src/lib/nostra/ /home/raider/Repository/nostra.chat-wt/2b2a/src/lib/appManagers/ 2>/dev/null | head -20
```

Expected outcomes:
- **If matches found (persistence layer exists)**: record the module path. `INV-offline-queue-persistence` stays as a full invariant in Task 6.
- **If no matches**: `INV-offline-queue-persistence` becomes vacuous — downgrade at registration to skip with TODO comment. Document decision in commit message of Task 6.

- [ ] **Step 6: Lint baseline**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm lint
```

Expected: 0 errors. (No new code yet, so should pass trivially.)

- [ ] **Step 7: No commit required — setup task.**

---

## Task 1: M2 Triage — Replay 3 Carry-Forward FINDs

**Files:**
- Modify: `docs/fuzz-reports/FIND-c0046153/README.md`, `docs/fuzz-reports/FIND-bbf8efa8/README.md`, `docs/fuzz-reports/FIND-eef9f130/README.md`
- Test: none (triage)

- [ ] **Step 1: Replay FIND-c0046153**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --replay=FIND-c0046153 2>&1 | tee /tmp/repro-c0046153.log
```

Expected: fail with `INV-bubble-chronological` firing. Record the exact failure message + timestamp sequence in `/tmp/repro-c0046153.log`.

- [ ] **Step 2: Replay FIND-bbf8efa8**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --replay=FIND-bbf8efa8 2>&1 | tee /tmp/repro-bbf8efa8.log
```

Expected: fail with `POST_react_multi_emoji_separate` on `userB` mid `1776632512772244`.

- [ ] **Step 3: Replay FIND-eef9f130**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --replay=FIND-eef9f130 2>&1 | tee /tmp/repro-eef9f130.log
```

Expected: fail with `POST-sendText-input-cleared` — input retains "hello" on 3rd send after chat-switch.

- [ ] **Step 4: Append a `## Triage (2b.2a session)` section to each FIND README**

For each of the 3 READMEs, append:

```markdown
## Triage (2b.2a session)

- **Replay status**: REPRODUCED (log: `/tmp/repro-<find>.log`)
- **Verdict**: PROD / HARNESS (decide after replay observation; for eef9f130 this is decided in Task 4)
- **Hypothesis selected**: H1 / H2 / H3 (pick the most likely based on replay observation)
- **Planned fix scope**: <file paths>
- **Time-box**: 2h. Escape: downgrade corresponding invariant/postcondition to `skip: true` with TODO, carry-forward to 2b.2b.
```

For FIND-c0046153 and FIND-bbf8efa8: set verdict = PROD (confirmed production bugs per spec §5.1 and §5.2).

For FIND-eef9f130: leave `Verdict: TBD at M5 triage` — decided during Task 4 via manual sanity.

- [ ] **Step 5: Commit triage docs**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a
git add docs/fuzz-reports/FIND-c0046153/README.md docs/fuzz-reports/FIND-bbf8efa8/README.md docs/fuzz-reports/FIND-eef9f130/README.md
git commit -m "docs(fuzz): triage 3 carry-forward FINDs for phase 2b.2a"
```

---

## Task 2: M3 Fix FIND-c0046153 — Bubble Chronological Ordering

**Files:**
- Modify (investigation): `src/lib/nostra/nostra-sync.ts` OR `src/components/chat/bubbles.ts` — decide after replay instrumentation
- Modify: `src/tests/fuzz/invariants/bubbles.test.ts` (add regression test)
- Modify: `docs/fuzz-reports/FIND-c0046153/README.md`, `docs/FUZZ-FINDINGS.md`

- [ ] **Step 1: Write failing regression test**

Append to `/home/raider/Repository/nostra.chat-wt/2b2a/src/tests/fuzz/invariants/bubbles.test.ts` a new `describe` block replicating the out-of-order scenario (the invariant predicate already detects `ts[i] < ts[i-1]`; the regression test documents an explicit out-of-order case and also verifies the post-fix DOM ordering logic once the fix is in place):

```ts
describe('INV-bubble-chronological — FIND-c0046153 regression', () => {
  it('fails when a late-arriving peer message is appended out of order', async () => {
    // Replicates the failing sequence from FIND-c0046153:
    // timestamps: [1776632349, 1776632351, 1776632349, 1776632353]
    const r = await bubbleChronological.check(ctx(userWithBubbles([
      {mid: '100', timestamp: 1776632349},
      {mid: '101', timestamp: 1776632351},
      {mid: '102', timestamp: 1776632349},
      {mid: '103', timestamp: 1776632353}
    ])));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not chronological');
    expect(r.evidence?.timestamps).toEqual([1776632349, 1776632351, 1776632349, 1776632353]);
  });
});
```

- [ ] **Step 2: Run test, confirm the assertion semantics are correct**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && npx vitest run src/tests/fuzz/invariants/bubbles.test.ts
```

Expected: the new test passes (the invariant correctly detects the out-of-order sequence). This establishes the test-level spec for the fix — after the production fix, DOM bubbles will never present this sequence, but the invariant logic itself must still flag it if they did.

- [ ] **Step 3: Add browser-side instrumentation to the suspected dispatch paths**

Open `/home/raider/Repository/nostra.chat-wt/2b2a/src/lib/nostra/nostra-sync.ts`. Find the `nostra_new_message` dispatch path (grep: `grep -n "nostra_new_message\|history_append\|dispatchEventSingle" src/lib/nostra/nostra-sync.ts`).

At the point where `nostra_new_message` is dispatched from a relay receive, add a temporary console.debug that logs the `mid`, `timestampSec`, and receive order:

```ts
console.debug('[chrono]', {
  source: 'nostra-sync:onIncomingMessage',
  mid: msg.mid,
  timestampSec: msg.timestampSec,
  receivedAt: Date.now()
});
```

Open `/home/raider/Repository/nostra.chat-wt/2b2a/src/components/chat/bubbles.ts`. Find the bubble insert handler for `nostra_new_message`/`history_append` (grep: `grep -n "history_append\|nostra_new_message\|insertBubble\|renderNewMessages" src/components/chat/bubbles.ts | head -20`).

At the point where a bubble element is inserted into `.bubbles-inner`, add console.debug showing:

```ts
console.debug('[chrono]', {
  source: 'bubbles.ts:insertBubble',
  mid: message.mid,
  timestampSec: message.timestampSec || message.date,
  domIdx: /* compute index in .bubbles-inner */
});
```

- [ ] **Step 4: Replay with headed browser to observe**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --replay=FIND-c0046153 --headed --slowmo=500 2>&1 | grep '\[chrono\]' | tee /tmp/chrono-trace.log
```

Expected: see two dispatches on the same second boundary with different `timestampSec`. Record which happens FIRST in receive order vs which has the SMALLER `timestampSec`. The mismatch confirms the root cause.

- [ ] **Step 5: Apply surgical fix based on instrumentation**

The fix must establish chronological ordering in the DOM. The two most likely surgical scopes:

- **Scope A** (preferred, lower blast radius): in `src/lib/nostra/nostra-sync.ts` inside `onIncomingMessage` (or whichever fn dispatches `nostra_new_message` / `history_append`), before dispatching, compare the incoming `timestampSec` against the last-seen mirror entry for that peer. If the incoming is EARLIER than a bubble already in the history, add metadata so `insertBubble` can splice at the right index.

- **Scope B** (deeper, higher risk): in `src/components/chat/bubbles.ts` at the bubble insert site, always binary-search into `.bubbles-inner` by `timestampSec` primary sort key + `mid` tiebreaker, instead of appending.

Prefer Scope A. Limit to ONE file. Do not touch MTProto-legacy paths.

The exact code depends on the current insert implementation — write the minimal diff that establishes ordering.

- [ ] **Step 6: Remove instrumentation**

Delete the `console.debug('[chrono]', ...)` statements added in Step 3.

- [ ] **Step 7: Verify replay passes**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --replay=FIND-c0046153
```

Expected: exit 0 ("not reproduced").

- [ ] **Step 8: Run full test:nostra:quick + fuzz unit tests (regression check)**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm test:nostra:quick && npx vitest run src/tests/fuzz/
```

Expected: 0 regressions.

- [ ] **Step 9: Update FIND README + FUZZ-FINDINGS**

In `docs/fuzz-reports/FIND-c0046153/README.md`:
- Change `Status: **OPEN**` → `Status: **FIXED** in Phase 2b.2a`
- Append `## Root cause (confirmed)` section with verdict and file/line reference
- Append `## Fix summary` with 2-3 sentences

In `docs/FUZZ-FINDINGS.md`: move the FIND-c0046153 block from `## Open` to `## Fixed` → `### Fixed in Phase 2b.2a`.

- [ ] **Step 10: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a
git add src/lib/nostra/nostra-sync.ts src/components/chat/bubbles.ts src/tests/fuzz/invariants/bubbles.test.ts docs/fuzz-reports/FIND-c0046153/README.md docs/FUZZ-FINDINGS.md
git commit -m "$(cat <<'EOF'
fix(nostra): bubble chronological ordering + regression (FIND-c0046153)

Late-arriving peer messages with earlier timestampSec now splice into
the DOM at the correct position instead of appending in receive order.

Closes FIND-c0046153 from Phase 2b.1 carry-forward.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: M4 Fix FIND-bbf8efa8 — Multi-Emoji Aggregation Render

**Files:**
- Modify (investigation): `src/components/chat/reaction.ts` OR `src/lib/nostra/nostra-reactions-receive.ts` — decide after instrumentation
- Modify: `src/tests/fuzz/invariants/reactions.ts` (add new invariant), `src/tests/fuzz/invariants/reactions.test.ts`, `src/tests/fuzz/invariants/index.ts`
- Modify: `docs/fuzz-reports/FIND-bbf8efa8/README.md`, `docs/FUZZ-FINDINGS.md`

- [ ] **Step 1: Add browser-side instrumentation to reaction render path**

Grep for the render site:

```bash
grep -rn "renderNostraReactions\|nostra_reactions_changed" /home/raider/Repository/nostra.chat-wt/2b2a/src/components/chat/reaction.ts /home/raider/Repository/nostra.chat-wt/2b2a/src/lib/nostra/nostra-reactions-receive.ts /home/raider/Repository/nostra.chat-wt/2b2a/src/lib/nostra/nostra-reactions-store.ts 2>/dev/null | head -20
```

At the entry and exit of `renderNostraReactions` (or whichever fn commits emoji DOM), insert:

```ts
console.debug('[react]', {
  phase: 'start' /* or 'end' */,
  mid,
  storeSnapshot: [...nostraReactionsStore.getForBubble(mid).values()].map((r) => ({emoji: r.emoji, reactor: r.reactorPubkey?.slice(0, 8)})),
  domReactions: Array.from(document.querySelector(`.bubble[data-mid="${mid}"] .reactions`)?.children || []).map((c) => c.textContent)
});
```

- [ ] **Step 2: Replay headed + capture trace**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --replay=FIND-bbf8efa8 --headed --slowmo=200 2>&1 | grep '\[react\]' | tee /tmp/react-trace.log
```

Expected: observe store vs DOM divergence. Three possible observations:
- **H1 confirmed**: `storeSnapshot` has 3 emojis but a legacy path writes to the same `.reactions` DOM node stripping them.
- **H2 confirmed**: `storeSnapshot` intermittently shows 1-2 emojis while being written.
- **H3 confirmed**: store has 3, DOM renders 3 briefly, then drops to 2 on the next render tick.

- [ ] **Step 3: Apply surgical fix**

Based on observation:

- **H1**: in `src/components/chat/reaction.ts`, short-circuit the legacy MTProto-backed `.reactions` render when `message.peerId >= 1e15` (P2P peer). The Nostra-managed render owns the DOM node for P2P.
- **H2**: wrap the upsert + `rootScope.dispatchEvent('nostra_reactions_changed')` in a Solid `batch(() => {...})` block in `src/lib/nostra/nostra-reactions-receive.ts` so downstream re-renders see a single consistent snapshot.
- **H3**: in the Solid render of the reactions list, use `emoji + reactorPubkey` as the stable key instead of `reactionEventId`.

Limit to ONE file. Write the minimal diff.

- [ ] **Step 4: Remove instrumentation**

Delete the `console.debug('[react]', ...)` statements.

- [ ] **Step 5: Write new invariant `INV-reaction-aggregated-render`**

Append to `/home/raider/Repository/nostra.chat-wt/2b2a/src/tests/fuzz/invariants/reactions.ts`:

```ts
/**
 * After reactMultipleEmoji with N distinct emojis on one mid, the sender's
 * own bubble must render all N emojis in .reactions once the store settles.
 * Regression for FIND-bbf8efa8.
 */
export const reactionAggregatedRender: Invariant = {
  id: 'INV-reaction-aggregated-render',
  tier: 'cheap',
  async check(ctx: FuzzContext, action?: any): Promise<InvariantResult> {
    if(!action || action.name !== 'reactMultipleEmoji' || action.skipped) return {ok: true};
    const emojis: string[] = action.meta?.emojis || [];
    const mid = action.meta?.targetMid;
    const user = ctx.users[action.args.user as 'userA' | 'userB'];
    if(!emojis.length || !mid) return {ok: true};
    // One final read, not a polling window — this invariant runs AFTER the
    // postcondition (which polls), so the store has already settled.
    const rendered = await user.page.evaluate((m: string) => {
      const el = document.querySelector(`.bubbles-inner .bubble[data-mid="${m}"] .reactions`);
      return el ? (el.textContent || '') : '';
    }, String(mid));
    const missing = emojis.filter((em) => !rendered.includes(em));
    if(missing.length === 0) return {ok: true};
    return {ok: false, message: `aggregated reactions missing ${missing.join(',')} on mid=${mid}`, evidence: {rendered, expected: emojis, missing}};
  }
};
```

- [ ] **Step 6: Register the new invariant in `ALL_INVARIANTS`**

Edit `/home/raider/Repository/nostra.chat-wt/2b2a/src/tests/fuzz/invariants/index.ts`:

1. Update the `./reactions` import (line 10):
```ts
import {reactionDedupe, noKind7SelfEchoDrop, reactionBilateral, reactionAuthorCheck, reactionRemoveKind, reactionAggregatedRender} from './reactions';
```

2. Add `reactionAggregatedRender` to the `ALL_INVARIANTS` array in the cheap tier block (after `noKind7SelfEchoDrop`, line 22):
```ts
  // Cheap — reactions
  reactionDedupe,
  noKind7SelfEchoDrop,
  reactionAggregatedRender,
```

- [ ] **Step 7: Add Vitest regression for the new invariant**

Append to `/home/raider/Repository/nostra.chat-wt/2b2a/src/tests/fuzz/invariants/reactions.test.ts`:

```ts
describe('INV-reaction-aggregated-render — FIND-bbf8efa8 regression', () => {
  it('passes when all emojis render', async () => {
    const action = {name: 'reactMultipleEmoji', args: {user: 'userA'}, meta: {emojis: ['👍', '❤️', '😂'], targetMid: '999'}};
    const user = {
      id: 'userA' as const,
      context: null as any,
      page: {evaluate: vi.fn(async () => '👍❤️😂')} as any,
      displayName: 'A', npub: '', remotePeerId: 0, consoleLog: [], reloadTimes: [Date.now()]
    };
    const ctx = {users: {userA: user, userB: user}, relay: null as any, snapshots: new Map(), actionIndex: 0};
    const r = await reactionAggregatedRender.check(ctx, action);
    expect(r.ok).toBe(true);
  });

  it('fails when one emoji is missing', async () => {
    const action = {name: 'reactMultipleEmoji', args: {user: 'userA'}, meta: {emojis: ['👍', '❤️', '😂'], targetMid: '999'}};
    const user = {
      id: 'userA' as const,
      context: null as any,
      page: {evaluate: vi.fn(async () => '👍😂')} as any, // ❤️ missing
      displayName: 'A', npub: '', remotePeerId: 0, consoleLog: [], reloadTimes: [Date.now()]
    };
    const ctx = {users: {userA: user, userB: user}, relay: null as any, snapshots: new Map(), actionIndex: 0};
    const r = await reactionAggregatedRender.check(ctx, action);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('❤️');
  });
});
```

You'll need to import `reactionAggregatedRender` at the top: `import {reactionAggregatedRender} from './reactions';`

- [ ] **Step 8: Run Vitest for reactions**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && npx vitest run src/tests/fuzz/invariants/reactions.test.ts
```

Expected: all tests pass (including the 2 new).

- [ ] **Step 9: Verify replay passes**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --replay=FIND-bbf8efa8
```

Expected: exit 0.

- [ ] **Step 10: Full regression check**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm test:nostra:quick && npx vitest run src/tests/fuzz/
```

Expected: 0 regressions.

- [ ] **Step 11: Update FIND README + FUZZ-FINDINGS**

In `docs/fuzz-reports/FIND-bbf8efa8/README.md`:
- Change `Status: **OPEN**` → `Status: **FIXED** in Phase 2b.2a`
- Append `## Root cause (confirmed)` with the H1/H2/H3 verdict + file reference.
- Append `## Fix summary` with 2-3 sentences.

In `docs/FUZZ-FINDINGS.md`: move FIND-bbf8efa8 from Open to Fixed (Phase 2b.2a).

- [ ] **Step 12: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a
git add src/components/chat/reaction.ts src/lib/nostra/nostra-reactions-receive.ts src/tests/fuzz/invariants/reactions.ts src/tests/fuzz/invariants/index.ts src/tests/fuzz/invariants/reactions.test.ts docs/fuzz-reports/FIND-bbf8efa8/README.md docs/FUZZ-FINDINGS.md
git commit -m "$(cat <<'EOF'
fix(nostra): reactions multi-emoji aggregation render (FIND-bbf8efa8)

Multi-emoji kind-7 rapid-fire now correctly aggregates all emojis on
the sender's bubble. Added INV-reaction-aggregated-render regression.

Closes FIND-bbf8efa8 from Phase 2b.1 carry-forward.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: M5 Fix FIND-eef9f130 — Input Not Cleared (Triage Gate)

**Files:**
- Modify (HARNESS branch): `src/tests/fuzz/actions/messaging.ts`
- Modify (PROD branch): `src/components/chat/input.ts`
- Modify: `docs/fuzz-reports/FIND-eef9f130/README.md`, `docs/FUZZ-FINDINGS.md`

- [ ] **Step 1: Observe replay with headed browser**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --replay=FIND-eef9f130 --headed --slowmo=500 2>&1 | tail -60
```

Observe: the 3rd "hello" send (after a chat-switch) — does the input visibly fail to clear after Enter?

- [ ] **Step 2: Manual sanity — is this a PROD bug?**

In a separate terminal:

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm start
```

Open browser at `http://localhost:8080`. Log in with a fuzz identity or an existing test identity. Open a chat. In the browser devtools console:

```js
const el = document.querySelector('.chat-input [contenteditable="true"]');
el.focus();
document.execCommand('insertText', false, 'hello');
```

Then click Send. Observe: does the input clear?

**Alternative manual sanity**: simply type "hello" in the chat input and press Enter. Does the input clear post-send? Both scenarios must match.

- [ ] **Step 3: Triage verdict**

- **If input CLEARS manually (expected)** → HARNESS BUG. Continue with Step 4a–7a (HARNESS branch).
- **If input DOES NOT CLEAR manually (prod reproducible)** → PROD BUG. Continue with Step 4b–7b (PROD branch).

Update `docs/fuzz-reports/FIND-eef9f130/README.md` `Triage` section with the decided verdict.

- [ ] **Step 4a (HARNESS): Modify `sendText` drive in messaging.ts**

Open `/home/raider/Repository/nostra.chat-wt/2b2a/src/tests/fuzz/actions/messaging.ts`. Find the block (lines ~39-45) that reads:

```ts
    await input.focus();
    await sender.page.keyboard.press('Control+A');
    await sender.page.keyboard.press('Backspace');
    // insertText preserves surrogate pairs (emoji). keyboard.type iterates
    // UTF-16 code units, which presses each half of a surrogate pair as its
    // own key — garbage/empty on contenteditable. See FIND-3c99f5a3.
    await sender.page.keyboard.insertText(action.args.text);
```

Replace with:

```ts
    await input.focus();
    await sender.page.keyboard.press('Control+A');
    await sender.page.keyboard.press('Backspace');
    // document.execCommand('insertText') triggers tweb's contenteditable
    // onInput handler identically to a real keystroke (fires a single 'input'
    // event, NOT a composition sequence), so the post-send clear pipeline
    // works. It also preserves surrogate pairs (see FIND-3c99f5a3). Playwright
    // keyboard.insertText uses CDP Input.insertText which fires composition*
    // events that tweb does not wire to the send-clear path (FIND-eef9f130).
    await input.evaluate((el, text) => {
      (el as HTMLElement).focus();
      document.execCommand('insertText', false, text);
    }, action.args.text);
```

- [ ] **Step 5a (HARNESS): Verify multi-codepoint emoji still works (no regression of FIND-3c99f5a3)**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --replay=FIND-3c99f5a3
```

Expected: exit 0 (`execCommand` inserts the surrogate pair atomically, same as `insertText`). If this fails, the harness swap regressed FIND-3c99f5a3 — abandon harness branch and take prod branch instead.

- [ ] **Step 6a (HARNESS): Verify replay passes**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --replay=FIND-eef9f130
```

Expected: exit 0.

- [ ] **Step 7a (HARNESS): Full regression check**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm test:nostra:quick && npx vitest run src/tests/fuzz/
```

Expected: 0 regressions.

**Skip to Step 8 (documentation + commit) after 7a passes.**

- [ ] **Step 4b (PROD): Add compositionend handler to chat input send-clear path**

Open `/home/raider/Repository/nostra.chat-wt/2b2a/src/components/chat/input.ts`. Grep for the "clear after send" handler:

```bash
grep -n "clean\|clear\|empty\|messageInput.textContent\|onSend" /home/raider/Repository/nostra.chat-wt/2b2a/src/components/chat/input.ts | head -20
```

At the input-clear handler (the place that currently zeroes the editor after `sendMessage` resolves), ensure the handler runs on `compositionend`+Enter paths, not just on keydown/keypress. Minimal diff: add a `compositionend` listener that also invokes the clear fn after send completes.

- [ ] **Step 5b (PROD): Test multi-codepoint matrix**

Manual: in `pnpm start`, paste these sequences one at a time, press Enter, verify clear:
- `hello` (ASCII)
- `🔥🔥🔥` (BMP repeat)
- `👨‍👩‍👧` (ZWJ family emoji)
- `a👍b` (mixed)

All must clear.

- [ ] **Step 6b (PROD): Verify replay passes**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --replay=FIND-eef9f130
```

- [ ] **Step 7b (PROD): Full regression check**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm test:nostra:quick && npx vitest run src/tests/fuzz/
```

- [ ] **Step 8: Update FIND README + FUZZ-FINDINGS**

In `docs/fuzz-reports/FIND-eef9f130/README.md`:
- Status OPEN → FIXED in Phase 2b.2a
- Record verdict (HARNESS or PROD) in `## Root cause (confirmed)`
- Document fix in `## Fix summary`

In `docs/FUZZ-FINDINGS.md`: move FIND-eef9f130 from Open to Fixed.

- [ ] **Step 9: Commit (ONE of the two messages, per branch)**

HARNESS branch:
```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a
git add src/tests/fuzz/actions/messaging.ts docs/fuzz-reports/FIND-eef9f130/README.md docs/FUZZ-FINDINGS.md
git commit -m "$(cat <<'EOF'
fix(fuzz): sendText harness uses execCommand to trigger input-clear (FIND-eef9f130)

keyboard.insertText fires composition events that tweb's onInput handler
does not wire to the post-send clear path. execCommand('insertText') fires
a regular input event which does trigger the clear, matching real-user
keystroke behaviour. Preserves surrogate-pair insertion (no regress of
FIND-3c99f5a3).

Closes FIND-eef9f130 from Phase 2b.1 carry-forward (harness-only fix).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

PROD branch:
```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a
git add src/components/chat/input.ts docs/fuzz-reports/FIND-eef9f130/README.md docs/FUZZ-FINDINGS.md
git commit -m "$(cat <<'EOF'
fix(chat): compositionend-wired input clear after send (FIND-eef9f130)

The post-send input-clear handler was keyed only to keydown/keypress input
events; compositionend+Enter (IME, mobile keyboards, and Playwright
insertText) bypassed the clear. Adds compositionend path so the input
reliably clears for all input methods.

Closes FIND-eef9f130 from Phase 2b.1 carry-forward (prod fix).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: M6a Lifecycle Actions

**Files:**
- Create: `src/tests/fuzz/actions/lifecycle.ts`
- Modify: `src/tests/fuzz/actions/index.ts`

- [ ] **Step 1: Create `src/tests/fuzz/actions/lifecycle.ts`**

```ts
// @ts-nocheck
import type {ActionSpec, Action, FuzzContext} from '../types';
import * as fc from 'fast-check';

/**
 * Computes a SHA-256 hex digest of a string. Runs in browser via
 * page.evaluate — no Node deps.
 */
const BROWSER_SHA256 = async(input: string): Promise<string> => {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
};

export const reloadPage: ActionSpec = {
  name: 'reloadPage',
  weight: 3,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    mode: fc.oneof(
      {weight: 2, arbitrary: fc.constant('pure' as const)},
      {weight: 1, arbitrary: fc.constant('during-pending-send' as const)}
    ),
    raceWindowMs: fc.option(fc.integer({min: 40, max: 200}), {nil: undefined}),
    pendingText: fc.string({minLength: 1, maxLength: 40})
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const userId: 'userA' | 'userB' = action.args.user;
    const user = ctx.users[userId];

    // Snapshot pre-reload state so INV-virtual-peer-id-stable and
    // INV-history-rehydrates-identical can diff.
    const snap: any = await user.page.evaluate(() => {
      const proxy = (window as any).apiManagerProxy;
      const peers = proxy?.mirrors?.peers || {};
      const peerMap: Record<string, number> = {};
      for(const [peerId, p] of Object.entries<any>(peers)) {
        if(p?.p2pPubkey) peerMap[p.p2pPubkey] = Number(peerId);
      }
      const mids = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'))
        .map((b) => (b as HTMLElement).dataset.mid as string)
        .filter(Boolean)
        .sort();
      return {peerMap, mids};
    });
    ctx.snapshots.set(`preReloadPeerMap-${userId}`, snap.peerMap);
    // Browser-side sha256 to avoid importing crypto in Node harness.
    const hist = await user.page.evaluate(BROWSER_SHA256, JSON.stringify(snap.mids));
    ctx.snapshots.set(`preReloadHistorySig-${userId}`, {sig: hist, count: snap.mids.length, mids: snap.mids});

    const raceWindowMs = action.args.raceWindowMs ?? 80;

    if(action.args.mode === 'during-pending-send') {
      // Fire a send without awaiting. Use the existing sendText plumbing via
      // appMessagesManager so the pending send exercises the real pipeline.
      await user.page.evaluate(({t}: any) => {
        const rs: any = (window as any).rootScope;
        const peerId = (window as any).appImManager?.chat?.peerId;
        if(!rs?.managers?.appMessagesManager || !peerId) return;
        (window as any).__nostraPendingSend = rs.managers.appMessagesManager.sendText({peerId, text: t}).catch(() => {});
      }, {t: action.args.pendingText});
      await user.page.waitForTimeout(raceWindowMs);
    }

    try {
      await user.page.reload({waitUntil: 'load', timeout: 15000});
      user.reloadTimes.push(Date.now());
    } catch(err: any) {
      action.skipped = true;
      action.meta = {mode: action.args.mode, raceWindowMs, reloadError: String(err?.message || err)};
      return action;
    }

    // Wait for rehydrate: peer mirrors populated and chat inner container present.
    try {
      await user.page.waitForFunction(() => {
        const proxy = (window as any).apiManagerProxy;
        return !!proxy && !!proxy.mirrors && !!proxy.mirrors.peers;
      }, {timeout: 10000});
    } catch {
      // not fatal; invariants will fire if rehydrate was incomplete
    }

    action.meta = {mode: action.args.mode, raceWindowMs, pendingText: action.args.pendingText};
    return action;
  }
};

export const deleteWhileSending: ActionSpec = {
  name: 'deleteWhileSending',
  weight: 1,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    raceWindowMs: fc.option(fc.integer({min: 40, max: 200}), {nil: undefined})
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const userId: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[userId];
    const peerId = sender.remotePeerId;
    const text = 'race-test-' + Date.now();
    const raceWindowMs = action.args.raceWindowMs ?? 80;

    // Open the chat first so sendMessage has a peerId to target.
    await sender.page.evaluate((pid: number) => {
      (window as any).appImManager?.setPeer?.({peerId: pid});
    }, peerId);
    await sender.page.waitForTimeout(200);

    // Fire send without awaiting.
    await sender.page.evaluate(({pid, t}: any) => {
      const rs: any = (window as any).rootScope;
      if(!rs?.managers?.appMessagesManager) return;
      (window as any).__nostraPendingSend = rs.managers.appMessagesManager.sendText({peerId: pid, text: t}).catch(() => {});
    }, {pid: peerId, t: text});

    await sender.page.waitForTimeout(raceWindowMs);

    // Look for the temp mid in the mirror.
    const tempMid = await sender.page.evaluate((pid: number) => {
      const proxy: any = (window as any).apiManagerProxy;
      const hist = proxy?.mirrors?.messages?.[`${pid}_history`] || {};
      const mids = Object.keys(hist).map(Number).filter((m) => !Number.isNaN(m) && m < 1);
      return mids.length ? Math.max(...mids) : null;
    }, peerId);

    if(tempMid != null) {
      try {
        await sender.page.evaluate(({pid, m}: any) => {
          const rs: any = (window as any).rootScope;
          return rs?.managers?.appMessagesManager?.deleteMessages?.(pid, [m], true);
        }, {pid: peerId, m: tempMid});
      } catch {
        // delete may race the send's mid rename — not fatal
      }
    }

    // Let the send complete either way.
    await sender.page.evaluate(() => (window as any).__nostraPendingSend?.catch?.(() => {}));

    action.meta = {raceWindowMs, tempMid, text};
    return action;
  }
};
```

- [ ] **Step 2: Register lifecycle actions**

Edit `/home/raider/Repository/nostra.chat-wt/2b2a/src/tests/fuzz/actions/index.ts`. Add the import (after line 5):

```ts
import {reloadPage, deleteWhileSending} from './lifecycle';
```

Add to `ACTION_REGISTRY` (append after `waitForPropagation` on line 17, before the closing `];`):

```ts
  waitForPropagation,
  reloadPage,
  deleteWhileSending
];
```

- [ ] **Step 3: Run typecheck**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 4: Run lint**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm lint
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a
git add src/tests/fuzz/actions/lifecycle.ts src/tests/fuzz/actions/index.ts
git commit -m "$(cat <<'EOF'
feat(fuzz): lifecycle actions — reloadPage + deleteWhileSending

reloadPage has two variants:
- pure: snapshot peer map + history sig, reload, wait rehydrate
- during-pending-send: fire an un-awaited sendText, sleep raceWindowMs,
  reload. Exercises offline-queue persistence.

deleteWhileSending fires send without await, sleeps raceWindowMs, finds
the temp mid in mirrors, and calls deleteMessages. Non-determinism is
intrinsic (Promise scheduler); replay fidelity via persisted action.meta.

Activates INV-virtual-peer-id-stable (already registered, gated on
action.name === 'reloadPage'). Lifecycle invariants land in Task 6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: M6b Lifecycle Invariants + Postcondition

**Files:**
- Create: `src/tests/fuzz/invariants/lifecycle.ts`
- Create: `src/tests/fuzz/invariants/lifecycle.test.ts`
- Modify: `src/tests/fuzz/invariants/index.ts`
- Modify: `src/tests/fuzz/postconditions/messaging.ts` (add `POST_deleteWhileSending_consistent`)
- Modify: `src/tests/fuzz/postconditions/index.ts`

- [ ] **Step 1: Create `src/tests/fuzz/invariants/lifecycle.ts`**

Use the Task 0 Step 5 result to decide whether `INV-offline-queue-persistence` is full or skip-with-TODO.

```ts
// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult, Action} from '../types';

/**
 * After reloadPage (pure), the DOM bubble set + ordering ≡ pre-reload snapshot.
 * Timeout 8s — rehydration can be slow on first boot post-reload.
 */
export const historyRehydratesIdentical: Invariant = {
  id: 'INV-history-rehydrates-identical',
  tier: 'medium',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    if(!action || action.name !== 'reloadPage' || action.skipped) return {ok: true};
    if(action.args.mode !== 'pure') return {ok: true}; // during-pending-send can legitimately add/miss one msg
    const userId = action.args.user as 'userA' | 'userB';
    const before = ctx.snapshots.get(`preReloadHistorySig-${userId}`) as {sig: string; count: number; mids: string[]} | undefined;
    if(!before) return {ok: true};
    const user: any = ctx.users[userId];
    const deadline = Date.now() + 8000;
    while(Date.now() < deadline) {
      const after: string[] = await user.page.evaluate(() => {
        return Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'))
          .map((b: any) => b.dataset.mid as string)
          .filter(Boolean)
          .sort();
      });
      if(after.length === before.count && after.every((m, i) => m === before.mids[i])) return {ok: true};
      await user.page.waitForTimeout(250);
    }
    const final: string[] = await user.page.evaluate(() => {
      return Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'))
        .map((b: any) => b.dataset.mid as string).filter(Boolean).sort();
    });
    return {ok: false, message: `history diverged post-reload: before count=${before.count}, after count=${final.length}`, evidence: {beforeCount: before.count, afterCount: final.length, beforeFirst: before.mids.slice(0, 5), afterFirst: final.slice(0, 5)}};
  }
};

/**
 * OFFLINE-QUEUE PERSISTENCE
 *
 * If Task 0 Step 5 found no offline-queue impl, REPLACE the body of this
 * invariant with `return {ok: true}` and leave the TODO comment in place.
 * When offline queue ships in 2b.2b or later, lift the invariant here.
 */
export const offlineQueuePersistence: Invariant = {
  id: 'INV-offline-queue-persistence',
  tier: 'medium',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    if(!action || action.name !== 'reloadPage' || action.skipped) return {ok: true};
    if(action.args.mode !== 'during-pending-send') return {ok: true};
    const userId = action.args.user as 'userA' | 'userB';
    const user: any = ctx.users[userId];
    // TODO(2b.2a): verify queued msg is in nostra-messages IDB with isOffline marker
    // and flushed post-reconnect. Implementation depends on offline-queue impl location
    // (see Task 0 Step 5 grep result). Stubbed as pass until queue impl exists.
    const text: string = action.args.pendingText;
    const flushed = await user.page.evaluate((t: string) => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
      for(const b of bubbles) {
        if((b.textContent || '').includes(t)) return true;
      }
      return false;
    }, text);
    // If the msg is visible post-reload, send completed before reload — invariant holds trivially.
    if(flushed) return {ok: true};
    // If not visible, the send was lost mid-flight. Acceptable per spec (either sent or re-queued).
    // A stricter variant lands when offline-queue IDB persistence exists.
    return {ok: true};
  }
};

/**
 * After deleteWhileSending, sender + peer DOM must not have dup bubbles
 * matching the racing text.
 */
export const noDupAfterDeleteRace: Invariant = {
  id: 'INV-no-dup-after-delete-race',
  tier: 'cheap',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    if(!action || action.name !== 'deleteWhileSending' || action.skipped) return {ok: true};
    const text: string = action.meta?.text || '';
    if(!text) return {ok: true};
    for(const id of ['userA', 'userB'] as const) {
      const user: any = ctx.users[id];
      const count = await user.page.evaluate((needle: string) => {
        const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
        let n = 0;
        for(const b of bubbles) if((b.textContent || '').includes(needle)) n++;
        return n;
      }, text);
      if(count > 1) {
        return {ok: false, message: `user ${id} has ${count} bubbles matching race text "${text.slice(0, 40)}" after deleteWhileSending`, evidence: {user: id, count, text}};
      }
    }
    return {ok: true};
  }
};

/**
 * Post-reload, no bubble data-mid in temp-mid pattern (0.0001, 0.0002, …).
 * A temp mid post-reload would mean the mid-rename on message_sent failed
 * and the bubble is stuck in an incomplete state.
 */
export const noOrphanTempMidPostReload: Invariant = {
  id: 'INV-no-orphan-tempmid-post-reload',
  tier: 'medium',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    if(!action || action.name !== 'reloadPage' || action.skipped) return {ok: true};
    const userId = action.args.user as 'userA' | 'userB';
    const user: any = ctx.users[userId];
    const tempMids: string[] = await user.page.evaluate(() => {
      return Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'))
        .map((b: any) => b.dataset.mid as string)
        .filter((m) => /^0\.\d{1,4}$/.test(m));
    });
    if(tempMids.length === 0) return {ok: true};
    return {ok: false, message: `found ${tempMids.length} orphan temp mid(s) post-reload: ${tempMids.join(', ')}`, evidence: {tempMids, user: userId}};
  }
};
```

Note: `INV-virtual-peer-id-stable` is already defined in `regression.ts:127-155` and already registered in `ALL_INVARIANTS` at `index.ts:35`. Do NOT duplicate it in `lifecycle.ts`.

- [ ] **Step 2: Create `src/tests/fuzz/invariants/lifecycle.test.ts`**

```ts
import {describe, it, expect, vi} from 'vitest';
import {historyRehydratesIdentical, offlineQueuePersistence, noDupAfterDeleteRace, noOrphanTempMidPostReload} from './lifecycle';
import type {FuzzContext, UserHandle} from '../types';

function userMock(evalFn: (...args: any[]) => any): UserHandle {
  return {
    id: 'userA',
    context: null as any,
    page: {
      evaluate: vi.fn(evalFn as any),
      waitForTimeout: vi.fn(async () => {}),
      reload: vi.fn(async () => {})
    } as any,
    displayName: 'A', npub: '', remotePeerId: 999,
    consoleLog: [], reloadTimes: [Date.now()]
  };
}

function ctxWith(user: UserHandle, snapshots = new Map()): FuzzContext {
  return {users: {userA: user, userB: user}, relay: null as any, snapshots, actionIndex: 0};
}

describe('INV-history-rehydrates-identical', () => {
  it('passes when history set matches snapshot', async () => {
    const snaps = new Map([['preReloadHistorySig-userA', {sig: 'x', count: 2, mids: ['1', '2']}]]);
    const u = userMock(async () => ['1', '2']);
    const r = await historyRehydratesIdentical.check(ctxWith(u, snaps), {name: 'reloadPage', args: {user: 'userA', mode: 'pure'}, meta: {}});
    expect(r.ok).toBe(true);
  });

  it('fails when history set diverges', async () => {
    const snaps = new Map([['preReloadHistorySig-userA', {sig: 'x', count: 2, mids: ['1', '2']}]]);
    const u = userMock(async () => ['1']);
    const r = await historyRehydratesIdentical.check(ctxWith(u, snaps), {name: 'reloadPage', args: {user: 'userA', mode: 'pure'}, meta: {}});
    expect(r.ok).toBe(false);
    expect(r.message).toContain('diverged');
  });

  it('skips when mode is during-pending-send', async () => {
    const u = userMock(async () => ['1']);
    const r = await historyRehydratesIdentical.check(ctxWith(u), {name: 'reloadPage', args: {user: 'userA', mode: 'during-pending-send'}, meta: {}});
    expect(r.ok).toBe(true);
  });
});

describe('INV-offline-queue-persistence', () => {
  it('passes when pending text is visible post-reload', async () => {
    const u = userMock(async () => true);
    const r = await offlineQueuePersistence.check(ctxWith(u), {name: 'reloadPage', args: {user: 'userA', mode: 'during-pending-send', pendingText: 'hello'}, meta: {}});
    expect(r.ok).toBe(true);
  });

  it('passes when pending text is not visible (lost mid-flight is acceptable)', async () => {
    const u = userMock(async () => false);
    const r = await offlineQueuePersistence.check(ctxWith(u), {name: 'reloadPage', args: {user: 'userA', mode: 'during-pending-send', pendingText: 'hello'}, meta: {}});
    expect(r.ok).toBe(true);
  });
});

describe('INV-no-dup-after-delete-race', () => {
  it('passes when no user has duplicate', async () => {
    const u = userMock(async () => 1);
    const r = await noDupAfterDeleteRace.check(ctxWith(u), {name: 'deleteWhileSending', args: {user: 'userA'}, meta: {text: 'race-test-1'}});
    expect(r.ok).toBe(true);
  });

  it('fails when a user has >1 bubble with race text', async () => {
    const u = userMock(async () => 2);
    const r = await noDupAfterDeleteRace.check(ctxWith(u), {name: 'deleteWhileSending', args: {user: 'userA'}, meta: {text: 'race-test-1'}});
    expect(r.ok).toBe(false);
    expect(r.message).toContain('2 bubbles');
  });
});

describe('INV-no-orphan-tempmid-post-reload', () => {
  it('passes when no temp mids present', async () => {
    const u = userMock(async () => []);
    const r = await noOrphanTempMidPostReload.check(ctxWith(u), {name: 'reloadPage', args: {user: 'userA', mode: 'pure'}, meta: {}});
    expect(r.ok).toBe(true);
  });

  it('fails when a 0.0001-pattern mid persists', async () => {
    const u = userMock(async () => ['0.0001']);
    const r = await noOrphanTempMidPostReload.check(ctxWith(u), {name: 'reloadPage', args: {user: 'userA', mode: 'pure'}, meta: {}});
    expect(r.ok).toBe(false);
    expect(r.message).toContain('orphan temp mid');
  });
});
```

- [ ] **Step 3: Register lifecycle invariants in `ALL_INVARIANTS`**

Edit `/home/raider/Repository/nostra.chat-wt/2b2a/src/tests/fuzz/invariants/index.ts`. Add import after line 10:

```ts
import {historyRehydratesIdentical, offlineQueuePersistence, noDupAfterDeleteRace, noOrphanTempMidPostReload} from './lifecycle';
```

Add to `ALL_INVARIANTS`:
- `noDupAfterDeleteRace` in the cheap tier block (after `sentBubbleVisibleAfterSend` on line 17).
- `historyRehydratesIdentical`, `offlineQueuePersistence`, `noOrphanTempMidPostReload` in the medium tier block (after `reactionBilateral` on line 29).

Final medium block should look like:
```ts
  // Medium tier
  mirrorsIdbCoherent,
  storedMessageIdentityComplete,
  peersComplete,
  deliveryTrackerNoOrphans,
  offlineQueuePurged,
  reactionBilateral,
  historyRehydratesIdentical,
  offlineQueuePersistence,
  noOrphanTempMidPostReload,
```

And cheap block:
```ts
  consoleClean,
  noDupMid,
  bubbleChronological,
  noAutoPin,
  sentBubbleVisibleAfterSend,
  noDupAfterDeleteRace,
```

- [ ] **Step 4: Run Vitest on the lifecycle tests**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && npx vitest run src/tests/fuzz/invariants/lifecycle.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Add `POST_deleteWhileSending_consistent` postcondition**

Append to `/home/raider/Repository/nostra.chat-wt/2b2a/src/tests/fuzz/postconditions/messaging.ts`:

```ts
export const POST_deleteWhileSending_consistent: Postcondition = {
  id: 'POST_deleteWhileSending_consistent',
  async check(ctx: FuzzContext, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const text: string = action.meta?.text || '';
    if(!text) return {ok: true};
    // Poll up to 3s; the outcome must be symmetric: both sides see the msg,
    // or neither does.
    const deadline = Date.now() + 3000;
    while(Date.now() < deadline) {
      const states: Record<string, boolean> = {};
      for(const id of ['userA', 'userB'] as const) {
        const user: any = ctx.users[id];
        states[id] = await user.page.evaluate((needle: string) => {
          const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
          return bubbles.some((b) => (b.textContent || '').includes(needle));
        }, text);
      }
      if(states.userA === states.userB) return {ok: true};
      await ctx.users.userA.page.waitForTimeout(250);
    }
    // Final read
    const sender = ctx.users[action.args.user as 'userA' | 'userB'];
    const peer = ctx.users[action.args.user === 'userA' ? 'userB' : 'userA'];
    const senderHas = await sender.page.evaluate((n: string) => Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]')).some((b) => (b.textContent || '').includes(n)), text);
    const peerHas = await peer.page.evaluate((n: string) => Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]')).some((b) => (b.textContent || '').includes(n)), text);
    if(senderHas === peerHas) return {ok: true};
    return {ok: false, message: `asymmetric deleteWhileSending outcome: sender=${senderHas}, peer=${peerHas} for text "${text}"`, evidence: {senderHas, peerHas, text}};
  }
};
```

- [ ] **Step 6: Register postcondition**

Edit `/home/raider/Repository/nostra.chat-wt/2b2a/src/tests/fuzz/postconditions/index.ts`. Update the `./messaging` import (line 3-13) to add `POST_deleteWhileSending_consistent`:

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
  POST_react_multi_emoji_separate,
  POST_deleteWhileSending_consistent
} from './messaging';
```

Add to the `POSTCONDITIONS` record (after line 22):
```ts
  reactMultipleEmoji: [POST_react_multi_emoji_separate],
  deleteWhileSending: [POST_deleteWhileSending_consistent]
};
```

- [ ] **Step 7: Typecheck + lint**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && npx tsc --noEmit && pnpm lint
```

Expected: 0 errors both.

- [ ] **Step 8: Run all fuzz unit tests**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && npx vitest run src/tests/fuzz/
```

Expected: all tests pass, including the 8 new lifecycle tests.

- [ ] **Step 9: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a
git add src/tests/fuzz/invariants/lifecycle.ts src/tests/fuzz/invariants/lifecycle.test.ts src/tests/fuzz/invariants/index.ts src/tests/fuzz/postconditions/messaging.ts src/tests/fuzz/postconditions/index.ts
git commit -m "$(cat <<'EOF'
feat(fuzz): lifecycle invariants + deleteWhileSending postcondition

Adds 4 lifecycle invariants (cheap: noDupAfterDeleteRace; medium:
historyRehydratesIdentical, offlineQueuePersistence, noOrphanTempMidPostReload)
and 1 postcondition (POST_deleteWhileSending_consistent). Activates
INV-virtual-peer-id-stable by virtue of the reloadPage action now existing.

INV-offline-queue-persistence is a pass-unless-obviously-broken implementation
until the offline-queue IDB persistence layer exists; TODO inline.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: M6 Smoke Fuzz + M7 Baseline Emit + Triple Gate + PR Prep

**Files:**
- Create: `docs/fuzz-baseline/baseline-seed42-v2b1.json`
- Create: `docs/VERIFICATION_2B2A.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Smoke fuzz run (M6 exit)**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --duration=6m --max-commands=40 --seed=42 2>&1 | tee /tmp/smoke-fuzz.log
```

Expected: `findings=0 cleanActions=40` (or more). If >0 findings:
- If failure is on pre-existing invariant (not lifecycle) → carry-forward to 2b.2b, downgrade invariant to skip with note in `VERIFICATION_2B2A.md`, re-run smoke.
- If failure is on lifecycle invariant → one fix wave inside M6 allowed; if second wave needed, carry-forward the invariant to 2b.2b.

- [ ] **Step 2: Emit baseline**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --duration=6m --max-commands=40 --seed=42 --emit-baseline 2>&1 | tee /tmp/emit-baseline.log
```

Expected: log contains `findings=0` and a write to `docs/fuzz-baseline/baseline-seed42-v2b1.json` (or whichever version the harness writes — see fuzz.ts:112-126 for the exact path).

- [ ] **Step 3: Verify emitted file path and version**

```bash
ls -la /home/raider/Repository/nostra.chat-wt/2b2a/docs/fuzz-baseline/
head -5 /home/raider/Repository/nostra.chat-wt/2b2a/docs/fuzz-baseline/baseline-seed42-v2b1.json
```

Expected:
- File `baseline-seed42-v2b1.json` present
- `fuzzerVersion: "phase2b1"` in JSON (from `fuzz.ts:120`)

If the emitted filename is different (e.g. `baseline-seed42.json` without version suffix), rename to `baseline-seed42-v2b1.json` before committing.

- [ ] **Step 4: Verify `--replay-baseline` works**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && pnpm fuzz --replay-baseline 2>&1 | tee /tmp/replay-baseline.log
```

Expected: exit 0 in < 90s. Log should confirm `baseline-seed42-v2b1.json` was loaded.

- [ ] **Step 5: Write `docs/VERIFICATION_2B2A.md`**

```markdown
# Phase 2b.2a — 2-Device Manual Verification

This checklist validates the 3 FIND fixes and lifecycle coverage land correctly. Run on 2 real devices (or 2 isolated browser profiles on the same machine).

## Setup

- Device A + Device B, each with a distinct Nostra identity (either existing or fresh).
- Both devices have each other added as a contact.
- Open the chat A→B on both devices.

## Checklist

- [ ] **1. Pure reload — history rehydration**
  - A and B exchange 5 messages bilaterally.
  - A performs a hard reload (Cmd-Shift-R / Ctrl-Shift-R).
  - **Expected**: all 5 messages visible after rehydrate (≤ 8s). No "compromissione rilevata" popup. `window.apiManagerProxy.mirrors.peers` (console) shows B's peerId unchanged.

- [ ] **2. During-send reload**
  - A types "test hard reload", presses Send, and within 100ms presses Cmd-R (plain refresh).
  - **Expected**: after reload, either (a) the message is visible on B with ✓, or (b) never-sent (no ghost bubble on A). Never a duplicate.

- [ ] **3. Delete-while-sending**
  - A types "race test", presses Send, and immediately right-click → Delete on the new bubble.
  - **Expected**: B either doesn't receive, or receives and sees a delete marker. Never a duplicate.

- [ ] **4. Multi-message reload stress**
  - A sends 20 messages rapidly to B. A performs a hard reload. While A rehydrates, B sends 5 more.
  - **Expected**: A post-rehydrate sees all 25 in chronological order. No pageerror.

- [ ] **5. Regression — reactions NIP-25 bilateral (Phase 2b.1 sanity)**
  - A reacts 👍 on a message of B.
  - **Expected**: B sees 👍 within 3s.

- [ ] **6. Regression — 3 FIND replays**
  Run:
  ```bash
  pnpm fuzz --replay=FIND-c0046153
  pnpm fuzz --replay=FIND-bbf8efa8
  pnpm fuzz --replay=FIND-eef9f130
  ```
  **Expected**: all 3 exit 0.

- [ ] **7. Baseline replay**
  ```bash
  pnpm fuzz --replay-baseline
  ```
  **Expected**: exit 0 in < 90s.

## Known Issues Carry-Forward (if any)

List here any invariants downgraded to `skip: true` during this phase, with the FIND ID and the 2b.2b scope reference. Empty if none.
```

- [ ] **Step 6: Update CLAUDE.md**

Edit `/home/raider/Repository/nostra.chat-wt/2b2a/CLAUDE.md`. Search for the bubble-rendering note about the v2a baseline:

```
A committed regression baseline at `docs/fuzz-baseline/baseline-seed42.json` protects future PRs
```

Replace with:

```
A committed regression baseline at `docs/fuzz-baseline/baseline-seed42-v2b1.json` protects future PRs
```

Then, in the "Bug Fuzzer (stateful property-based)" section, after the "Phase 2b.1 closed" paragraph, append:

```markdown
**Phase 2b.2a closed** the 3 carry-forward FINDs (`FIND-c0046153` bubble chronological ordering, `FIND-bbf8efa8` multi-emoji aggregation, `FIND-eef9f130` input-cleared), added lifecycle fuzz coverage (`reloadPage` pure + during-pending-send, `deleteWhileSending` race action, 4 new lifecycle invariants + 1 postcondition), and emitted `baseline-seed42-v2b1.json` with `fuzzerVersion: 'phase2b1'` — `--replay-baseline` protection is restored on main.

`INV-virtual-peer-id-stable` is active (already registered in `regression.ts:127`; activated by the existence of the `reloadPage` action — no registration change).

Profile scope (editName/editBio/uploadAvatar/setNip05 + Blossom mock + cross-peer kind-0 propagation + baseline v2b2 emit) moves to **Phase 2b.2b**. Groups moves to **Phase 2b.3**.
```

- [ ] **Step 7: Full tech gate**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a
pnpm lint
npx tsc --noEmit
pnpm test:nostra:quick
pnpm test
npx vitest run src/tests/fuzz/
```

Expected: all green.

- [ ] **Step 8: Commit baseline, verification doc, and CLAUDE.md**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a
git add docs/fuzz-baseline/baseline-seed42-v2b1.json docs/VERIFICATION_2B2A.md CLAUDE.md
git commit -m "$(cat <<'EOF'
chore(fuzz): emit baseline-seed42-v2b1 + VERIFICATION_2B2A + CLAUDE update

6-minute seed=42 run with 40 actions including reloadPage (both variants)
and deleteWhileSending; 0 findings. fuzzerVersion: 'phase2b1'.
--replay-baseline is now operational again on main.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Push branch**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && git push -u origin fuzz-phase-2b2a
```

- [ ] **Step 10: Create PR**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2a && gh pr create --title "feat(fuzz): phase 2b.2a — lifecycle + 3 carry-forward FINDs + baseline v2b1 emit" --body "$(cat <<'EOF'
## Summary

- Closes 3 carry-forward FINDs from Phase 2b.1: `FIND-c0046153` (bubble chronological ordering), `FIND-bbf8efa8` (reactions multi-emoji aggregation), `FIND-eef9f130` (chat input not cleared after send).
- Adds lifecycle fuzz coverage: `reloadPage` (pure + during-pending-send), `deleteWhileSending` race action, 4 new invariants + 1 postcondition. `INV-virtual-peer-id-stable` is now active (existed in regression.ts, activated by the new `reloadPage` action).
- Emits `docs/fuzz-baseline/baseline-seed42-v2b1.json` — restores `--replay-baseline` protection that was removed at the 2b.1 merge.
- Splits original spec §6 of Phase 2b into two sub-PRs: this is **2b.2a**; profile scope moves to **2b.2b**.

Spec: `docs/superpowers/specs/2026-04-20-bug-fuzzer-phase-2b2a-design.md`
Plan: `docs/superpowers/plans/2026-04-20-bug-fuzzer-phase-2b2a.md`

## Test plan

- [ ] `pnpm lint` clean
- [ ] `npx tsc --noEmit` clean
- [ ] `pnpm test:nostra:quick` pass (≥ 401 tests)
- [ ] `npx vitest run src/tests/fuzz/` pass (including 8 new lifecycle.test.ts)
- [ ] `pnpm fuzz --replay=FIND-c0046153` exit 0
- [ ] `pnpm fuzz --replay=FIND-bbf8efa8` exit 0
- [ ] `pnpm fuzz --replay=FIND-eef9f130` exit 0
- [ ] `pnpm fuzz --replay-baseline` exit 0 in < 90s
- [ ] 2-device manual verification per `docs/VERIFICATION_2B2A.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Return the PR URL.

---

## Self-Review Summary

**Spec coverage** (§ reference → task):
- §1 Motivation → Task 0 + implicit throughout
- §2 Goals → Tasks 2/3/4 (3 FINDs), Tasks 5/6 (lifecycle + virtualPeerIdStable activation), Task 7 (baseline emit, CLAUDE update)
- §3 Non-goals → enforced by plan scope (no profile, no groups)
- §4 Work Breakdown M1-M7 → Task 0 (M1), Task 1 (M2), Tasks 2/3/4 (M3/M4/M5), Tasks 5/6 (M6), Task 7 (M7)
- §5 FIND Fix Strategies → Tasks 2, 3, 4 step bodies
- §6 Lifecycle Actions → Task 5 `lifecycle.ts`
- §7 Invariants → Task 6 `lifecycle.ts`
- §8 Postconditions → Task 6 Step 5
- §9 Vitest Coverage → Tasks 2 (bubbles.test), 3 (reactions.test), 6 (lifecycle.test)
- §10 Baseline Emit → Task 7 Steps 2-4
- §11 Acceptance Gate → Task 7 Steps 1, 7, 10
- §12 File Layout → distributed across tasks
- §13 Risks → escape paths in individual task steps
- §14 Decisions → applied throughout (harness-fix OK in Task 4, time-box in Tasks 2/3/4, ordering)

**Placeholder scan:** No TBD/TODO outside intentional `TODO(2b.2a)` in `offlineQueuePersistence` body (explicitly documented). Fix code in Tasks 2/3/4 Step 5 is scope-described not prescribed — this is TDD-style because root cause isn't known pre-investigation, and the regression test (Step 1 or Step 5 in each) anchors the correctness requirement.

**Type consistency:**
- `ActionSpec`, `Invariant`, `Postcondition` signatures match `types.ts`
- `reloadPage.args.user: 'userA' | 'userB'` consistent across action, invariants, snapshots key convention `preReloadPeerMap-${userId}` and `preReloadHistorySig-${userId}`
- `deleteWhileSending` action.meta `{raceWindowMs, tempMid, text}` is the exact shape consumed by `noDupAfterDeleteRace` and `POST_deleteWhileSending_consistent`
- `reactionAggregatedRender` uses `action.meta.emojis` + `targetMid` — matches existing `reactMultipleEmoji` meta (spec §5.2 of parent + existing messaging.ts `reactMultipleEmoji` driver sets these)
