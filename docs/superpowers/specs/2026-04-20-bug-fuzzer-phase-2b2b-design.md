# Bug Fuzzer Phase 2b.2b — Reporter + Warmup + chrono-v2 + Profile + Baseline v2b2 Emit

Date: 2026-04-20
Status: Design approved (pre-approved in brainstorming session), ready for planning
Follows: [`2026-04-20-bug-fuzzer-phase-2b2a-design.md`](2026-04-20-bug-fuzzer-phase-2b2a-design.md)
Completes: §6 of [`2026-04-19-bug-fuzzer-phase-2b-design.md`](2026-04-19-bug-fuzzer-phase-2b-design.md) (profile scope)

## 1. Motivation

Phase 2b.2a shipped via PR #43 (merge commit `83437633`, 2026-04-20):
- 3 FINDs closed (`FIND-c0046153`, `FIND-bbf8efa8`, `FIND-eef9f130`) with surgical fixes + regression tests
- Lifecycle fuzz actions (`reloadPage` + `deleteWhileSending`) + 4 invariants + 1 postcondition
- `INV-virtual-peer-id-stable` activated

Three carry-forward items remained open:
- `FIND-chrono-v2` — `INV-bubble-chronological` same-second tempMid race (distinct from c0046153; 9/9 pass on c0046153 replay but ~60% flake on eef9f130 replay)
- `FIND-cold-deleteWhileSending` — cold-start relay-delivery race
- `FIND-cold-reactPeerSeesEmoji` — cold-start kind-7 subscription propagation race

One tool defect:
- `reporter.ts` clobbers `docs/FUZZ-FINDINGS.md` on every run — all curated "Fixed in Phase X" sections + carry-forward notes are wiped each time the fuzzer writes findings. Manual `git restore` required after every `pnpm fuzz` run to preserve curation.

One scope deferral:
- **Profile actions** (`editName`, `editBio`, `uploadAvatar`, `setNip05`) + Blossom mock + `INV-profile-propagates` were deferred from the original Phase 2b §6 spec.

One post-merge discovery:
- `fix(nostra): populate getAvailableReactions stub so reactions menu renders` (PR #47) — the reactions picker UI was shipping broken because `getAvailableReactions` stub returned empty, making the reactions popup invisible. The existing fuzz action `reactRandomBubble` calls `rs.managers.appReactionsManager.sendReaction(...)` directly via the manager proxy, **bypassing the UI picker entirely** — the bug was latent and shipped to prod, surfaced only via manual review. Fuzz coverage must include a UI-driven reaction action.

Missing infrastructure:
- `docs/fuzz-baseline/` is empty on main. `--replay-baseline` has no file to load. Main is unprotected against regressions relative to any prior known-good state.

Phase 2b.2b is a single monolithic PR closing all of the above: reporter merge semantics, warmup handshake, `chrono-v2`, UI-driven reaction action, profile scope, baseline v2b2 emit, triple gate.

## 2. Goals

- **Reporter `parse-preserve-update inline`** — `src/tests/fuzz/reporter.ts` reads existing `FUZZ-FINDINGS.md`, preserves all `## Fixed` subsections and per-heading curation byte-for-byte, updates only `## Open` entries (bump `Occurrences` + `Last seen` if signature already present; append if new). No more `git restore` workaround. Existing `parseFindingsMarkdown` is re-used as the parse step.
- **Multi-kind deterministic warmup** — `bootHarness` performs a fixed bidirectional sequence after `linkContacts` exercising kinds 1059 (send), 7 (reaction), 5 (delete). Each step waits for DOM confirmation before proceeding. Closes `FIND-cold-deleteWhileSending` + `FIND-cold-reactPeerSeesEmoji`. Removes any `actionIndex < N` guards.
- **`mid` tiebreaker in P2P sort** — `src/components/chat/bubbleGroups.ts`: when `sortItemsKey === 'timestamp'` (P2P), add `mid` as secondary key to break ties deterministically. Closes `FIND-chrono-v2`.
- **`reactViaUI(user, emoji)` fuzz action** — new action in `src/tests/fuzz/actions/reactions.ts`: opens bubble context menu via real click + selects emoji from rendered picker, instead of manager-proxy shortcut. Would have intercepted the `getAvailableReactions` empty-stub bug.
- **Profile scope** (original §6 of Phase 2b spec):
  - Actions: `editName`, `editBio`, `uploadAvatar` (Blossom mock via `context.addInitScript`), `setNip05`
  - Invariants: `INV-profile-propagates` (cross-peer kind-0 sync), `INV-profile-kind0-single-active`, `INV-profile-cache-coherent`
  - Postconditions: `POST_editName_cache_updated`, `POST_editName_relay_published`, `POST_uploadAvatar_propagated`
- **Emit `baseline-seed42-v2b2.json`** — 6-min run at seed=42, max-commands=40, `findings === 0`, `fuzzerVersion: 'phase2b2'`. Single baseline committed at end of PR. v2b1 is NOT committed.
- **Triple gate**: tech (`pnpm lint` + `npx tsc --noEmit` + `pnpm test:nostra:quick` ≥401 + `npx vitest run src/tests/fuzz/` ≥63) + 2-device manual via `docs/VERIFICATION_2B2B.md` + `pnpm fuzz --replay-baseline` passes 0 findings.
- **Update CLAUDE.md** — reflect baseline v2b2 presence, reporter fix, profile coverage.

## 3. Non-goals

- **Groups** (`createGroup`, `addGroupMember`, etc.) → Sub-PR 2b.3.
- **Chaos actions** (`flakyRelay`, `connectivityLoss`) → Phase 3.
- **Tor backend, `--pairs>1`, UI contract manifest** → Phase 3.
- **Multi-device sync actions** → future.
- **v2b1 baseline emit** — skipped. Task 4 does a smoke-run to verify `findings === 0` but does not commit the JSON. v2b2 is the only baseline committed.
- **Multi-wave fix cascades** — when profile or reactViaUI surface new bugs: max **1** fix wave per task, residues carry-forward to Phase 2b.3. Stricter than 2b.2a's per-milestone cap of 2.

## 4. Decisions (pre-approved in brainstorming)

Recorded for downstream planning/execution traceability:

| # | Decision | Value | Rationale |
|---|---|---|---|
| 1 | PR split | Monolithic (1 PR, 8 tasks) | User preference; keeps review coherent. |
| 2 | Baseline strategy | v2b2 only, committed at task 7 | Avoids commit churn; the baseline that ships is the richest. |
| 3 | Fix wave cap | Max 1 per task, else carry-forward | Prevents timeline blow-up in monolithic PR. |
| 4 | Warmup architecture | Deterministic bidirectional handshake post-linkContacts | Prior single-kind bilateral insufficient; `actionIndex<3` guard insufficient. |
| 5 | Reporter merge | Parse-preserve-update inline, single file | Minimal churn on tooling; re-uses existing `parseFindingsMarkdown`. |

## 5. Work Breakdown (8 tasks)

Ordering: sequential linear. Each task is a single atomic Conventional Commit.

| # | Task | Deliverable | Commit message | Exit condition |
|---|---|---|---|---|
| T1 | Reporter merge-not-overwrite | `src/tests/fuzz/reporter.ts` reads FUZZ-FINDINGS.md, preserves Fixed+curated sections byte-for-byte, updates only Open entries. Vitest in `reporter.test.ts`. | `fix(fuzz): reporter preserves curated Fixed sections via parse-merge` | `pnpm fuzz` run followed by `git diff docs/FUZZ-FINDINGS.md` shows Fixed sections unchanged; Open entries updated only. Vitest 3 new cases pass. |
| T2 | Multi-kind warmup handshake | `bootHarness` in `src/tests/fuzz/harness.ts`: after linkContacts, executes deterministic A→B send, B→A react, A→B delete, B→A react-remove. Each step awaits DOM confirmation. Removes `actionIndex<N` guards. | `fix(fuzz): deterministic bidirectional multi-kind warmup in bootHarness` | Replay of `FIND-cold-deleteWhileSending` + `FIND-cold-reactPeerSeesEmoji` — 10/10 passes each. `pnpm fuzz --duration=3m --seed=42` from cold boot: 0 postcondition misfires in actions 0-10. |
| T3 | chrono-v2 fix (`mid` tiebreaker) | `src/components/chat/bubbleGroups.ts`: add `mid` as secondary key when `sortItemsKey === 'timestamp'` + P2P peer. Regression test in `bubbles.test.ts`. | `fix(nostra): bubble chronological order — mid tiebreaker on same-second ties` | Replay of `FIND-eef9f130` — 10/10 passes (was ~40% flake post-2b.2a). `pnpm test:nostra:quick` still ≥401. |
| T4 | Baseline v2b1 smoke-run (no commit) | `pnpm fuzz --duration=6m --max-commands=40 --seed=42` run, verify `findings === 0`. Record run metadata to PR description. No JSON emit. | (skip — no commit, part of T5 verification) | Run completes with 0 findings. Screenshot/log captured for PR body. |
| T5 | `reactViaUI` fuzz action | New action in `src/tests/fuzz/actions/reactions.ts`: opens bubble context menu via `page.click(bubbleSelector, {button: 'right'})` (or long-press), clicks emoji in rendered `.reactions-picker`. Registered in `actions/index.ts`. New invariant + Vitest. | `feat(fuzz): reactViaUI action + INV-reactions-picker-renders` | `pnpm fuzz --duration=3m --seed=42` with reactViaUI included → 0 new findings OR max 1 fix wave then carry-forward. Vitest passes. |
| T6 | Profile scope | Actions `editName`, `editBio`, `uploadAvatar`, `setNip05` in `src/tests/fuzz/actions/profile.ts`. Blossom mock via `context.addInitScript` in harness. Invariants `INV-profile-propagates`, `INV-profile-kind0-single-active`, `INV-profile-cache-coherent` in `invariants/profile.ts`. Postconditions in `postconditions/profile.ts`. Vitest in `profile.test.ts`. | `feat(fuzz): profile actions + invariants + Blossom mock` | All 4 actions register, invariants + postconditions run, Vitest ≥3 new passing. `pnpm fuzz --duration=3m --seed=42` with profile → 0 new findings OR max 1 fix wave then carry-forward. |
| T7 | Baseline v2b2 emit | `pnpm fuzz --duration=6m --max-commands=40 --seed=42 --emit-baseline`. Produces `docs/fuzz-baseline/baseline-seed42-v2b2.json` with `fuzzerVersion: 'phase2b2'`. Committed. | `chore(fuzz): emit baseline-seed42-v2b2.json (profile scope included)` | File exists, `fuzzerVersion` field correct, `findings === 0` confirmed in file. `pnpm fuzz --replay-baseline` passes. |
| T8 | Triple gate + docs + PR | `docs/VERIFICATION_2B2B.md` (2-device manual steps), update CLAUDE.md (baseline v2b2 claim, profile coverage, reporter fix), tech gate complete, PR draft. | `docs(fuzz): phase 2b.2b verification + CLAUDE.md sync` | All 3 gates pass. PR body references: `fix(fuzz): reporter…` + `fix(fuzz): warmup…` + `fix(nostra): chrono-v2…` + `feat(fuzz): reactViaUI…` + `feat(fuzz): profile…` + `chore(fuzz): baseline…` + this docs commit. |

PR title (squash-merge, Conventional Commits):

```
feat(fuzz): phase 2b.2b — reporter fix + warmup + profile + baseline v2b2 emit
```

Rationale for title using `feat(fuzz)`: the dominant change is the new capability (profile + reactViaUI + baseline v2b2); the `fix` subcommits will show in the squash commit body.

## 6. Subsystem Details

### 6.1 Reporter parse-merge (T1)

Current behavior (`writeFindingsMarkdown`):
1. If file doesn't exist → write fresh template
2. If exists → open in append mode implicitly via `writeFileSync` — **clobbers existing file** with `renderFindingsMarkdown(allFindings)` result, losing curation.

Target behavior:
1. Read existing file (if any) via `readFileSync`.
2. Split into three zones:
   - **Prelude**: everything before the first `## Open` heading (title, ToC, etc.). Preserved literally.
   - **Open**: `## Open` section — parsed via existing `parseFindingsMarkdown`, new findings merged (see rules below).
   - **Postlude**: everything from `## Fixed` heading onward. Preserved literally.
3. Merge rules for Open:
   - If signature already present: bump `Occurrences` counter, update `Last seen`, keep everything else untouched (trace, first seen, seed, assertion).
   - If signature is new: append new entry at end of Open section.
   - If signature was in Open and user manually moved it to Fixed between runs: **do NOT re-add** (detection: parse Fixed section too, skip Open entries whose signature appears in Fixed).
4. Re-render Open entries only; concat Prelude + rendered Open + Postlude.
5. Write back.

Implementation sketch:

```ts
// src/tests/fuzz/reporter.ts
export function writeFindingsMarkdown(newFindings: Finding[]): void {
  let prelude = DEFAULT_PRELUDE;
  let openEntries: ReportEntry[] = [];
  let postlude = '';

  if(existsSync(FINDINGS_PATH)) {
    const existing = readFileSync(FINDINGS_PATH, 'utf8');
    ({prelude, openEntries, postlude} = splitExisting(existing));
  }

  const fixedSignatures = parseFixedSignatures(postlude);
  const merged = mergeFindings(openEntries, newFindings, fixedSignatures);
  const output = prelude + renderOpenSection(merged) + postlude;
  writeFileSync(FINDINGS_PATH, output, 'utf8');
}

function splitExisting(md: string): {
  prelude: string;
  openEntries: ReportEntry[];
  postlude: string;
} { /* regex-based zone split on `^## Open` and `^## Fixed` */ }

function parseFixedSignatures(postlude: string): Set<string> {
  const set = new Set<string>();
  for(const m of postlude.matchAll(ENTRY_HEADER_RE)) set.add(m[1]);
  return set;
}
```

Vitest cases (`src/tests/fuzz/reporter.test.ts`):
- **T1.V1** — Fresh file: writes template + renders new findings under Open.
- **T1.V2** — Existing file with Fixed section: Fixed preserved byte-for-byte after merge.
- **T1.V3** — Signature in both Open and Fixed: skipped from Open update (fixed wins).
- **T1.V4** — Re-occurrence of existing Open: occurrences bumped, `Last seen` updated.
- **T1.V5** — New finding appends to Open without touching existing entries.

### 6.2 Multi-kind warmup handshake (T2)

Target `bootHarness` flow (after `linkContacts`):

```ts
async function warmupHandshake(a: UserHandle, b: UserHandle): Promise<void> {
  // Step 1: A→B text (kind 1059). Wait until B's bubbles contain it.
  const warmupText = `__warmup_${Date.now()}__`;
  await sendTextFromUI(a, b, warmupText);
  await waitForBubbleOnPeer(b, warmupText, {timeout: 15000});

  // Step 2: B→A reaction on that bubble (kind 7). Wait until A's bubble shows it.
  const warmupEmoji = '👍';
  await reactToBubbleOnUI(b, warmupText, warmupEmoji);
  await waitForReactionOnPeer(a, warmupText, warmupEmoji, {timeout: 15000});

  // Step 3: A→B delete (kind 5). Wait until B's bubble is removed/tombstoned.
  await deleteBubbleOnUI(a, warmupText);
  await waitForBubbleAbsenceOnPeer(b, warmupText, {timeout: 15000});

  // Step 4: sanity reset — B→A react on (now-deleted) bubble should fail silently;
  //         we don't wait for it, just give 500ms drain window.
  await a.page.waitForTimeout(500);
}
```

Helper selectors use the same locators the fuzzer's real actions use (to ensure subscribe-path coverage matches fuzz-path coverage). The helpers are exported from `harness.ts` and also reused by existing fuzz actions where convenient.

**Exit criteria verification script** (for T2 exit):
- Replay `FIND-cold-deleteWhileSending` 10×; expect 10/10 pass.
- Replay `FIND-cold-reactPeerSeesEmoji` 10×; expect 10/10 pass.
- Cold-boot `pnpm fuzz --duration=3m --seed=42`: no postcondition failures in actions 0-10.

Any `actionIndex < N` guards in invariants/postconditions introduced in 2b.2a (via "cold-start warmup" comments) are removed in this task.

### 6.3 `mid` tiebreaker (T3)

`src/components/chat/bubbleGroups.ts` currently (P2P branch):

```ts
const isP2P = Number(chat.peerId) >= 1e15;
this.sortItemsKey = chat.type === ChatType.Scheduled || isP2P ? 'timestamp' : 'mid';
this.sortGroupsKey = chat.type === ChatType.Scheduled || isP2P ? 'lastTimestamp' : 'lastMid';
```

The `sortItemsKey` is a single key. We need a 2-key comparator when P2P. Options:

- **Option A (minimal):** switch the sort callsite to a custom comparator when `isP2P`, with `timestamp DESC, mid DESC` fallback.
- **Option B (broader):** convert `sortItemsKey` and `sortGroupsKey` to tuples `['timestamp', 'mid']` / `['lastTimestamp', 'lastMid']` and update comparator everywhere.

We pick **Option A** — narrower blast radius, easier to isolate. Locate the comparator (`itemsArr` descending by `sortItemsKey`) and gate on `isP2P`:

```ts
// Pseudocode
function compareItems(a: GroupItem, b: GroupItem): number {
  if(this._isP2P) {
    if(a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
    return b.mid - a.mid;  // same-second tiebreaker
  }
  return b[this.sortItemsKey] - a[this.sortItemsKey];
}
```

Regression test (`src/tests/fuzz/invariants/bubbles.test.ts` — new case `INV-bubble-chronological — FIND-chrono-v2 regression`):
- Construct 3 `GroupItem`s with identical `timestamp` but distinct `mid` values (in reverse order).
- Verify `itemsArr` final order is deterministic: descending `mid`.
- Run 20× to confirm determinism (was non-deterministic pre-fix).

### 6.4 `reactViaUI` fuzz action (T5)

`src/tests/fuzz/actions/reactions.ts` — add new action:

```ts
export const reactViaUIAction: FuzzAction = {
  name: 'reactViaUI',
  weight: 1.0,
  gen: (rng, state) => {
    const user = rng.pick(['userA', 'userB']);
    const emoji = rng.pick(['👍', '❤️', '😂', '🎉', '😮']);
    const targetMid = state.pickRandomBubble(user, {allowOwn: false})?.mid;
    if(!targetMid) return null;
    return {user, emoji, mid: targetMid};
  },
  execute: async (ctx, args) => {
    const u = ctx.user(args.user);
    // Open context menu on target bubble via right-click or long-press
    const bubble = await u.page.locator(`[data-mid="${args.mid}"]`).first();
    await bubble.click({button: 'right', timeout: 5000});
    // Wait for reactions picker to render
    const picker = u.page.locator('.reactions-picker, [data-test="reactions-picker"]');
    await picker.waitFor({state: 'visible', timeout: 3000});
    // Click emoji inside picker
    await picker.getByText(args.emoji).click({timeout: 3000});
    // Dismiss any residual overlay
    await u.page.keyboard.press('Escape');
  }
};
```

**Invariant `INV-reactions-picker-renders`** (cheap tier): whenever a `reactViaUI` action runs, the picker must have been visible for ≥1 frame (detected via the `waitFor` call succeeding inside `execute` — no separate invariant needed beyond the action itself). However: we add `INV-reactions-picker-nonempty` (cheap) that asserts, whenever any right-click on a bubble opens the picker, it contains ≥3 emoji choices. This would have caught the empty-stub bug.

Vitest: `src/tests/fuzz/actions/reactions.test.ts` — verify action generator + execute wiring via a mocked page.

**Fix wave handling**: per §4 decision #3, if `reactViaUI` surfaces a UI-layer bug other than the one already fixed in PR #47: 1 fix wave max, then carry-forward to 2b.3.

### 6.5 Profile scope (T6)

#### 6.5.1 Actions

`src/tests/fuzz/actions/profile.ts`:

- **`editName(user, newName)`** — opens Settings → Profile → Name field, types new name, saves. Expected side-effects: local kind-0 republished, cross-peer kind-0 fetch within ~2s.
- **`editBio(user, newBio)`** — analog for About/bio field.
- **`uploadAvatar(user, pngBytes)`** — opens Settings → Profile → Avatar, triggers file picker via `page.setInputFiles`, confirms crop. Blossom mock intercepts the upload POST and returns a stable fake URL.
- **`setNip05(user, nip05)`** — sets NIP-05 identifier field. Stored in local kind-0 but no DNS verification performed (NIP-05 DNS verification is out of scope — we only test that the string round-trips through kind-0).

#### 6.5.2 Blossom mock

Injected via `context.addInitScript` in harness `bootHarness`:

```ts
await context.addInitScript(() => {
  const originalFetch = window.fetch;
  (window as any).__fuzzBlossomUploads = new Map<string, Uint8Array>();
  window.fetch = async function(input: any, init?: any) {
    const url = typeof input === 'string' ? input : input.url;
    if(url && /^https?:\/\/[^/]+\/(upload|media)(\/|\?|$)/.test(url) && init?.method === 'PUT') {
      const body = init.body instanceof Uint8Array ? init.body : new Uint8Array(await (init.body as Blob).arrayBuffer());
      const sha = await (async () => {
        const hash = await crypto.subtle.digest('SHA-256', body);
        return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      })();
      (window as any).__fuzzBlossomUploads.set(sha, body);
      const fakeUrl = `https://blossom.fuzz/${sha}.png`;
      return new Response(JSON.stringify({
        url: fakeUrl,
        sha256: sha,
        size: body.byteLength,
        uploaded: Math.floor(Date.now() / 1000)
      }), {status: 200, headers: {'content-type': 'application/json'}});
    }
    return originalFetch.call(this, input, init);
  };
});
```

Rationale: narrow URL pattern matching avoids intercepting the relay WebSocket upgrade or other app fetches. Stored bytes can be asserted against in `INV-profile-propagates` (download-and-compare SHA).

#### 6.5.3 Invariants

`src/tests/fuzz/invariants/profile.ts`:

- **`INV-profile-kind0-single-active`** (cheap) — for each user, exactly one kind-0 event per pubkey is "active" at any time (latest-wins). Asserts via storage query.
- **`INV-profile-cache-coherent`** (medium) — each user's locally cached profile (displayName, bio, avatarUrl, nip05) matches the latest published kind-0 content.
- **`INV-profile-propagates`** (regression, post-action poll) — after a profile mutation action, the peer's cached view of the author's profile updates within N seconds (default 5s). Polls `peerA.page.evaluate(() => apiManagerProxy.mirrors.peers[peerId].first_name)`.

#### 6.5.4 Postconditions

`src/tests/fuzz/postconditions/profile.ts`:

- **`POST_editName_cache_updated`** — after `editName`, the actor's local profile cache reflects new name within 3s.
- **`POST_editName_relay_published`** — after `editName`, a kind-0 event with the new name was published to the relay (verified via `LocalRelay.getPublishedEvents({kind: 0, pubkey: actor.pubkey})`).
- **`POST_uploadAvatar_propagated`** — after `uploadAvatar`, peer's cache has a `.photo.url` matching the mock URL within 5s.

#### 6.5.5 Vitest

`src/tests/fuzz/actions/profile.test.ts`: action generators produce valid args; generators respect rng determinism.
`src/tests/fuzz/invariants/profile.test.ts`: each invariant detects its known failure mode (e.g. `INV-profile-cache-coherent` fires when we manually desync the mirror).

**Fix wave handling**: per §4 decision #3, if any profile action surfaces a bug: 1 fix wave max, else carry-forward to 2b.3. Bugs logged in `docs/FUZZ-FINDINGS.md` Open.

### 6.6 Baseline v2b2 emit (T7)

Command:

```
pnpm fuzz --duration=6m --max-commands=40 --seed=42 --emit-baseline
```

Expected outputs:
- Harness runs 40 actions, all invariants pass, `findings === 0`.
- Baseline writer emits `docs/fuzz-baseline/baseline-seed42-v2b2.json` with:
  - `fuzzerVersion: 'phase2b2'`
  - `seed: 42`
  - `maxCommands: 40`
  - Action trace + observed states
  - Timestamp

Post-emit verification:

```
pnpm fuzz --replay-baseline
```

Must exit 0.

File committed separately in `chore(fuzz): emit baseline-seed42-v2b2.json`.

### 6.7 Verification doc + CLAUDE.md sync (T8)

`docs/VERIFICATION_2B2B.md` — 2-device manual steps covering:
1. Reporter: run `pnpm fuzz --duration=30s` then inspect `git diff FUZZ-FINDINGS.md` → Fixed sections unchanged.
2. Warmup: cold-boot fuzz, observe 0 cold-start postcondition failures.
3. chrono-v2: replay `FIND-eef9f130` 10 times → 10 passes.
4. reactViaUI: open chat, right-click any bubble → picker renders with ≥3 emojis.
5. Profile: edit name on device A → observe device B shows new name within 5s.
6. Baseline: `pnpm fuzz --replay-baseline` exits 0.

CLAUDE.md updates:
- Replace "baseline deferred to 2b.2b" with "baseline committed: `docs/fuzz-baseline/baseline-seed42-v2b2.json` (`fuzzerVersion: 'phase2b2'`)"
- Add note under "Bug Fuzzer" that reporter preserves curated sections automatically (no `git restore` needed)
- Add note that profile scope (editName/editBio/uploadAvatar/setNip05) is covered by fuzzer
- Update "Phase 2b.2a closed / carry-forward" lines to "Phase 2b.2b closed chrono-v2 + cold-start races + reporter bug + profile scope + baseline v2b2 emit"

## 7. Risk Register

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | Warmup handshake itself flakes on slow relays | Medium | Each step has 15s timeout, steps are sequential with explicit DOM waits, no parallelism. If timeout → harness boot fails loudly (not silent). |
| R2 | `reactViaUI` surfaces further UI bugs beyond getAvailableReactions | Medium-High | Fix wave cap: 1 wave per task, else carry-forward per §4.3. Protects PR timeline. |
| R3 | Profile scope surfaces races from IndexedDB profile cache vs kind-0 roundtrip | High | Same cap. Log in Open. Proceed to baseline emit with known-open FINDs counted in Open (not blocking — baseline gate is `findings === 0` IN THAT RUN, not globally). |
| R4 | `mid` tiebreaker conflicts with some edge case where tempMid=realMid collision | Low | Regression test covers same-timestamp distinct-mid; the narrow branch only activates when both timestamps equal (P2P only). |
| R5 | Reporter merge breaks on malformed pre-existing file | Low | Vitest cases T1.V1-V5 cover fresh, existing, mixed-state files. Fallback: if parse throws, preserve existing file verbatim and append new findings under a `## Uncategorized` heading. |
| R6 | Baseline v2b2 run takes longer than 6m on fuzz machine | Low | Harness supports `--duration=10m` override. Document actual duration in PR body. |
| R7 | Blossom mock conflicts with other `addInitScript` calls | Low | Mock is additive (patches `window.fetch`, doesn't replace other patches). Guarded by narrow URL regex. |

## 8. Validation gate

PR merge requires all three:

1. **Tech gate**:
   - `pnpm lint` clean
   - `npx tsc --noEmit` clean
   - `pnpm test:nostra:quick` ≥ 401 passing
   - `npx vitest run src/tests/fuzz/` ≥ 63 passing (baseline 63 post-2b.2a, +5 new from T1 + T3 + T5 + T6 = ≥68 target; accept ≥63 as floor)

2. **2-device manual** (`docs/VERIFICATION_2B2B.md` checklist fully ticked)

3. **Baseline replay**: `pnpm fuzz --replay-baseline` exit 0

If any gate fails, block merge. Carry-forward remaining open FINDs to 2b.3.

## 9. Operational notes

- **Worktree location**: `/home/raider/Repository/nostra.chat-wt/2b2b`
- **Branch**: `fuzz-phase-2b2b` from `origin/main` (`00f8de2e`)
- **`.env.local`**: copied from main repo
- **`pnpm fuzz` prereq**: `pnpm start` running in background at `:8080`. Harness does NOT auto-start.
- **Husky pre-push**: runs typecheck. Any new TS error blocks push. For test helper empty arrays, type explicitly (`consoleLog: [] as string[]`).
- **After `pnpm fuzz` runs**: with T1 merged, `git status` should show `FUZZ-FINDINGS.md` diff ONLY if findings were added. Curated sections are untouched.
