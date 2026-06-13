# Bug Fuzzer — Stateful Property-Based UI/State Testing

Date: 2026-04-17
Status: Design approved, ready for planning

## 1. Motivation

Bugs in Nostra.chat are currently discovered by the maintainer using the app with two devices and reporting issues one at a time. Each bug triggers a round-trip: reproduce → report → diagnose → fix → verify. The loop is slow and biased toward bugs the maintainer happens to hit in personal use — avatar rendering, delivery ticks, Tor console errors, reload persistence. Long-tail UI and state bugs across the 40+ shipped features (messaging, profile, groups, QR exchange, relay config, reset, lifecycle) stay undiscovered until they bite.

We want an autonomous bug-discovery tool that exercises the full app surface over hours, captures minimal reproducers, and hands them to Claude for deterministic fixing. The goal is to shift from reactive bug-reporting to proactive bug-harvesting.

## 2. Goals

- **Autonomous discovery** of UI state bugs, ordering bugs, data-coherence bugs, and regressions across shipped features — without human in the loop during the run.
- **Deterministic replay**: every reported bug includes a seed + minimal action trace that reliably reproduces on the local backend. Claude can then fix-verify without chasing flakiness.
- **Living findings file** (`docs/FUZZ-FINDINGS.md`) that accumulates de-duplicated bugs across runs and ranks them by occurrence frequency. Claude opens the file at the start of a session and attacks the top entry.
- **Adaptive scope**: MVP covers messaging core (1 day of build), then grows feature-by-feature driven by what the first runs surface.

## 3. Non-goals

- **Not a replacement for E2E regression tests.** Scripted E2Es (`src/tests/e2e/*.ts`) verify specific flows pass; the fuzzer explores the space and catches unknown-unknowns. Both live.
- **Not a CI gate.** Runs are local, on-demand (invoked by Claude or the maintainer). A future evolution may add a nightly CI job, but v1 is local-only.
- **Not a performance benchmark.** No timing assertions, no flamegraphs. Bugs it finds are correctness bugs.
- **Not targeting unshipped features.** Channels (Phase 6), import-identity, WebRTC/TURN are out of scope until shipped.

## 4. Architecture

A single Node process orchestrates:

1. **`LocalRelay`** — reused from `src/tests/e2e/helpers/local-relay.ts` (strfry in Docker on `ws://localhost:7777`). In `--backend=real` mode, skipped and public relays are used.
2. **Two Playwright browser contexts** (`userA`, `userB`) created via `browser.newContext()` for storage isolation, relay injected via `addInitScript` setting `window.__nostraTestRelays`. Reuses `launchOptions`, `dismissOverlays`, `createIdentity` patterns from existing E2E.
3. **Onboarding (fixed, non-fuzzed)** at harness startup: both users create identity, publish kind 0, add each other as contacts via `appUsersManager.injectP2PUser` + `storeMapping`. This is deterministic setup — not part of the action space.
4. **Fast-check main loop** using `fc.asyncProperty(fc.commands(actionRegistry, {maxCommands: 120}), async cmds => run(cmds))`. Each iteration = fresh browser contexts + a new random command sequence. On invariant failure, fast-check triggers shrinking (budget: 60s) to produce the minimal reproducer.
5. **Invariant engine** runs tiered checks (cheap after every action, medium every N, regression at end of run) against both contexts and the `LocalRelay` event stream.
6. **Reporter** computes a stable signature per failure, de-duplicates against `FUZZ-FINDINGS.md`, writes artifacts to `docs/fuzz-reports/FIND-<sig>/`, continues running.

Design principle: **layered driver**. DOM-level actions exercise what the user experiences (catches render bugs). API-level actions (via `window.__nostra*` globals and `rootScope.managers`) handle setup, state inspection, and precision operations (opening specific chats) where DOM clicking is flaky.

## 5. File layout

```
src/tests/fuzz/
├── fuzz.ts                          # CLI entry, run loop, fast-check orchestration
├── harness.ts                       # LocalRelay boot, 2-context setup, onboarding, teardown
├── actions/
│   ├── index.ts                     # Action registry (weights, fc.commands wiring)
│   ├── messaging.ts                 # sendText, reply, edit, delete, react
│   ├── navigation.ts                # openChat, scrollHistory, waitForPropagation
│   ├── profile.ts                   # uploadAvatar, editName, editBio, setNip05
│   ├── groups.ts                    # createGroup, sendGroupMsg, add/remove/leave
│   ├── lifecycle.ts                 # reload, toggleTor, resetLocalData, logout
│   └── chaos.ts                     # disconnectRelay, slowNetwork
├── invariants/
│   ├── index.ts                     # Registry, runTier(tier, ctx)
│   ├── console.ts                   # INV-console-clean with allowlist
│   ├── bubbles.ts                   # INV-no-dup-mid, INV-bubble-chronological, INV-no-auto-pin
│   ├── delivery.ts                  # INV-delivery-ui-matches-tracker
│   ├── avatar.ts                    # INV-avatar-dom-matches-cache
│   ├── state.ts                     # INV-mirrors-idb-coherent, INV-peers-complete
│   ├── queue.ts                     # INV-offline-queue-purged
│   ├── regression.ts                # INV-no-nip04, INV-idb-seed-encrypted
│   └── edit.ts                      # INV-edit-preserves-mid-timestamp, INV-edit-author-check
├── ui-contracts.ts                  # UI contract manifest (button → expected effect)
├── postconditions/
│   └── index.ts                     # Per-action post-check map
├── reporter.ts                      # Signature, dedup, FUZZ-FINDINGS.md update, artifacts
├── replay.ts                        # --replay=FIND-xxx / --replay-file loader
├── allowlist.ts                     # Known-benign console noise patterns
└── types.ts                         # Shared types (FuzzContext, Invariant, Action, ...)
```

One invariant = one file. One action category = one file. Adding a new invariant or action class is append-only. No invariant or action file should exceed ~200 lines.

## 6. Actions

Actions are fast-check `AsyncCommand`s with weights. Phase gating below — Phase 1 is the MVP, later phases expand the registry.

### Phase 1 — Core messaging (MVP)

| Action | Weight | Driver | Notes |
|---|---|---|---|
| `sendText(from, to, text)` | 40 | DOM | `text` via `fc.string({maxLength: 200})` + emoji/markdown variants |
| `replyToRandomBubble(from)` | 15 | DOM | picks random recent `.bubble[data-mid]` |
| `editRandomOwnBubble(from)` | 8 | API `initMessageEditing(mid)` + DOM | touches cross-device echo dedup |
| `deleteRandomOwnBubble(from)` | 5 | DOM context menu | exercises NIP-09 propagation |
| `reactToRandomBubble(user, emoji)` | 8 | DOM double-tap | |
| `openRandomChat(user, peerId)` | 12 | API `appImManager.setPeer` | DOM chatlist click is flaky in headless |
| `scrollHistoryUp(user)` | 7 | DOM `.bubbles` scroll | exercises `getHistory` pagination |
| `waitForPropagation(ms)` | 5 | `page.waitForTimeout(500-3000)` | drift-settle window |

### Phase 2 — Profile + groups

| Action | Weight | Driver |
|---|---|---|
| `uploadAvatar(user, blob)` | 6 | API set `EditPeer.lastAvatarBlob` + DOM save |
| `editDisplayName(user, name)` | 4 | DOM |
| `editBio(user, text)` | 3 | DOM |
| `setNip05(user, alias)` | 2 | DOM + verify |
| `createGroup(members[], name)` | 3 | DOM new-group tab |
| `sendGroupMessage(group, from, text)` | 10 | DOM |
| `addGroupMember(group, newMember)` | 2 | DOM |
| `removeGroupMember(group, member)` | 2 | DOM |
| `leaveGroup(group, user)` | 1 | DOM |
| `addContactViaNpub(from, to)` | 2 | API |

### Phase 3 — Lifecycle + Tor + chaos

| Action | Weight | Driver |
|---|---|---|
| `reloadPage(user)` | 3 | `page.reload()` + re-hydrate wait |
| `toggleReadReceipts(user)` | 1 | DOM |
| `toggleTor(user)` | 0.5 | DOM — costly, used rarely |
| `disconnectRelay(user, relayIdx)` | 2 | API `relay.instance.ws.close()` — chaos |
| `resetLocalData(user)` | 0.2 | DOM + confirm popup |
| `logout(user)` | 0.1 | DOM + confirm — terminates sequence |

**DOM vs API policy:**
- DOM drives actions where the bug can be in the rendering or handler wiring (send, reply, upload, react, context menu).
- API drives setup (onboarding, chat switching), state inspection (all invariants), and precision injection (relay disconnect).
- Fast-check's `shrink` is respected: when the minimal trace includes an action, the replay uses the same driver as the original run.

## 7. Invariants

Invariants are classified by cost, which dictates check frequency.

### Cheap — after every action (<50ms)

| ID | What | How |
|---|---|---|
| `INV-console-clean` | No `console.error`/`console.warn` from app modules | `page.on('console')` + `page.on('pageerror')` buffer; filter by prefixes (`[ChatAPI]`, `[NostrRelay]`, `[NostraSync]`, `[VirtualMTProto`, `[NostraOnboarding`); subtract `allowlist.ts` known-benign patterns |
| `INV-no-dup-mid` | All `data-mid` on `.bubble` in open chat are unique | `new Set(mids).size === mids.length` |
| `INV-bubble-chronological` | `data-timestamp` monotonically increasing across visible bubbles | sorted asc check |
| `INV-delivery-ui-matches-tracker` | Each own-outgoing bubble's CSS state class (`is-sent`/`is-delivered`/`is-read`) matches `DeliveryTracker.getState(mid)` | `page.evaluate` reads both, compares pairwise; allows 2s propagation window after send |
| `INV-avatar-dom-matches-cache` | `.chat-info .avatar img[src]` equals `loadCachedProfile().picture` (or dicebear fallback derived from `npub`) | string equality after cache-age check |
| `INV-no-auto-pin` | No `.bubble.is-pinned` exists when no pin action has fired in the trace | count check |
| `INV-sent-bubble-visible-after-send` | After `sendText(from, to, text)`, a `.bubble[data-mid]` containing `text` exists on `from`'s page within 2s | presence poll |

### Medium — every N=10 actions (~200-500ms)

| ID | What |
|---|---|
| `INV-mirrors-idb-coherent` | Every `mid` in `apiManagerProxy.mirrors.messages[${peerId}_history]` has a matching row in `nostra-messages` IDB |
| `INV-peers-complete` | For every `peerId` referenced in the session, `mirrors.peers[peerId]` has a non-hex-fallback `first_name` (regex `^[0-9a-f]{8}` must not match) |
| `INV-delivery-tracker-no-orphans` | Every `mid` in `deliveryTracker.states` corresponds to an existing bubble or IDB row |
| `INV-offline-queue-purged` | After propagation wait, `offlineQueue.getQueueLength(peerId)` is 0 for peers last-sent-to |

### Regression — once per run (at end)

| ID | What |
|---|---|
| `INV-no-nip04` | `LocalRelay.getAllEvents()` contains no `kind === 4` events during the run |
| `INV-idb-seed-encrypted` | Raw dump of `IDBDatabase('Nostra.chat').nostra_identity` contains no `nsec1`/bech32-seed plaintext |
| `INV-edit-preserves-mid-timestamp` | For every edited message snapshot-pair, `mid` and `timestamp` are identical pre/post |
| `INV-edit-author-check` | Every stored edit has `rumor.pubkey === original.senderPubkey` |
| `INV-group-wrap-count` | For every group `sendGroupMessage(groupOfN)`, `LocalRelay.getAllEvents()` shows exactly N+1 `kind: 1059` events sharing the same `created_at` |
| `INV-virtual-peer-id-stable` | Same `npub` → same `peerId` across reload (uses `reloadPage` snapshots) |

### False-positive control

Three required mechanisms:
1. **Warmup window** (5s after reload/boot): `INV-console-clean` disabled — Vite HMR, SW install, dicebear load emit noise.
2. **Propagation window** (2s after `sendText`): `INV-delivery-ui-matches-tracker` delays first check — clock-state is expected transient.
3. **Allowlist** (`src/tests/fuzz/allowlist.ts`): explicit `RegExp[]` of known-benign console messages (e.g. Vite HMR updates, informational `[NostraSync] buffer size N`). Anything else is a violation. Allowlist diffs are reviewed in code review.

## 8. Action postconditions

Separate from global invariants: each action carries its own post-check asserting the action produced its intended effect. Runs **only** after that action, in addition to the global tier. Each lives in `postconditions/index.ts` as a map `actionName → Postcondition[]`.

Initial set (Phase 1):

```ts
{
  sendText: [
    POST_sendText_bubble_appears,        // new .bubble[data-mid] with the text
    POST_sendText_input_cleared,         // .chat-input is empty post-send
    POST_sendText_tick_visible,          // .bubble .tick.is-sent within 2s
    POST_sendText_scrolled_to_bottom     // .bubbles-inner scrollTop near scrollHeight
  ],
  editRandomOwnBubble: [
    POST_edit_mid_unchanged,
    POST_edit_timestamp_unchanged,
    POST_edit_content_updated,
    POST_edit_indicator_shown            // .is-edited class or 'edited' label
  ],
  uploadAvatar: [
    POST_uploadAvatar_dom_updates,       // .chat-info .avatar img src changes within 3s
    POST_uploadAvatar_cache_written,     // loadCachedProfile().picture matches
    POST_uploadAvatar_kind0_published,   // LocalRelay has new kind 0 with picture
    POST_uploadAvatar_no_clobber         // other fields (about, nip05) still present
  ],
  deleteRandomOwnBubble: [
    POST_delete_local_bubble_gone,       // .bubble[data-mid=X] absent within 2s
    POST_delete_remote_bubble_gone,      // after propagation, receiver no longer shows it
    POST_delete_nip09_event_on_relay     // kind 5 referencing X
  ],
  reactToRandomBubble: [
    POST_react_emoji_appears,
    POST_react_count_increments
  ]
  // ... more added as actions expand
}
```

Postcondition failures report under a distinct ID namespace (`POST-xxx` vs `INV-xxx`) so the findings file shows them separately.

## 9. UI contract manifest

File `src/tests/fuzz/ui-contracts.ts` declares, for every tracked UI button: selector, context requirements, and expected post-click effect as an executable predicate.

```ts
export type UIContract = {
  id: string;                              // 'UI-sidebar-hamburger-open'
  selector: string;                        // Playwright locator string
  context?: 'chat-open' | 'sidebar-open' | 'profile-tab' | 'settings-tab';
  requires?: {bubbleSelected?: boolean; groupOpen?: boolean};
  expect: (page: Page) => Promise<boolean>;
  description: string;
};

export const UI_CONTRACTS: UIContract[] = [
  {
    id: 'UI-sidebar-hamburger-open',
    selector: '.sidebar-header .btn-menu-toggle',
    expect: async (page) => await page.locator('.btn-menu-item:has-text("Profile")').isVisible(),
    description: 'Clicking hamburger opens sidebar menu with Profile entry'
  },
  {
    id: 'UI-chat-input-attach',
    context: 'chat-open',
    selector: '.chat-input .btn-icon[title*="ttach"]',
    expect: async (page) => await page.locator('.attach-menu').isVisible(),
    description: 'Attach button opens attach menu'
  }
  // ~25 entries in v1; grows on-demand
];
```

### Two usage modes

- **Smoke pass** at fuzzer startup (`--smoke-only` or always): iterate each contract, apply `requires`, click, assert `expect`. Catches dead buttons (routed but handler missing, silent no-op, Solid delegation broken). Takes ~30s.
- **Free fuzz injection**: ~5% of fuzz actions pick a random `UI-xxx` from the manifest. Click, verify `expect`. Broadens coverage beyond the explicit action catalog.

### Scope

v1 ships with ~25 high-value entries (sidebar, hamburger, chat input toolbar, context menu items, settings top-level, profile tab headers). Grows on-demand as bugs are reported: each "button X didn't do Y" bug becomes a new contract entry + postcondition, so the same class of regression never escapes again.

## 10. Runtime & CLI

```bash
pnpm fuzz                                        # local, 1h, 1 pair, headless, seed=Date.now()
pnpm fuzz --duration=6h                          # overnight
pnpm fuzz --backend=real --tor --duration=30m    # sanity run on public relays + Tor
pnpm fuzz --pairs=3                              # 3 parallel user-pairs
pnpm fuzz --headed --slowmo=200                  # visible for debugging
pnpm fuzz --smoke-only                           # UI contract pass only, no fuzz loop
pnpm fuzz --replay=FIND-a7b3c9d2                 # deterministic replay of a finding
pnpm fuzz --replay-file=<trace.json>             # replay arbitrary trace
pnpm fuzz --seed=<n>                             # fixed seed for reproducibility
pnpm fuzz --max-commands=60                      # shorter sequences per iteration (default 120)
```

**Execution model.** One run = one root seed + a `duration` budget. Fast-check iterates `fc.asyncProperty(fc.commands(registry, {maxCommands}), async cmds => runSequence(cmds))`. Each iteration:

1. Fresh browser contexts (full isolation)
2. Onboarding (fixed: creates identities, publishes kind 0, establishes contacts)
3. Run command sequence, invariants tiered
4. On failure: throw → fast-check shrinks → `onShrunk(cmds, err)` dispatches to reporter
5. Teardown contexts, next iteration

Typical throughput: ~10-20 actions/s at local backend, so 1h = 35k-70k actions at 1 pair. With 3 pairs, 100k+ per hour.

**Parallelization.** N pairs = N Node children with `baseSeed + i`. Each child runs its own pair of browser contexts but shares the `LocalRelay` container (strfry is fine with multi-subscriber). Findings are appended to `FUZZ-FINDINGS.md` via file lock (`proper-lockfile`). RAM: ~1.5GB per pair (2 Chromium processes).

**How Claude runs it.** When asked to fuzz:
1. Verify strfry container via `docker ps` (or skip for `--backend=real`)
2. `Bash run_in_background=true` to launch, capture log file path
3. Monitor the log via `Monitor` tool on the background task (no polling sleeps)
4. On completion: read `FUZZ-FINDINGS.md`, summarize top-5 by frequency, propose attack order
5. To fix: `pnpm fuzz --replay=FIND-xxx --headed` to observe, edit code, replay to verify fix, commit

## 11. Reporter — `FUZZ-FINDINGS.md`

The file lives at `docs/FUZZ-FINDINGS.md` (repo root `docs/`, not inside `superpowers/`). Checked into git — the findings are project truth, not session-local.

### Signature

`FIND-<sig>` where `sig = sha256(invariantId + firstAssertionMessage + stackTraceTopFrame).slice(0, 8)`. Stable across runs: same logical bug collapses to same ID.

### Entry format

```markdown
### FIND-a7b3c9d2 — INV-delivery-ui-matches-tracker
- **Status**: open
- **Occurrences**: 1247
- **First seen**: 2026-04-17 22:35 (run seed 1744924508331)
- **Last seen**: 2026-04-18 03:02
- **Minimal trace** (5 actions, replay `pnpm fuzz --replay=FIND-a7b3c9d2`):
  1. `sendText(A→B, "hi")`
  2. `reloadPage(B)`
  3. `sendText(A→B, "hi 2")`
  4. `waitForPropagation(2000)`
  5. expect `B.bubble[mid=...].classList` includes `is-delivered` → actual: `is-sent`
- **Assertion**: `bubble tick is 'sent' but DeliveryTracker has 'delivered'`
- **Artifacts**: [`docs/fuzz-reports/FIND-a7b3c9d2/`](../fuzz-reports/FIND-a7b3c9d2/)
```

### File structure

```markdown
# Fuzz Findings

Last updated: 2026-04-18 03:02:11
Runs aggregated: 12 (total actions: 340k)

## Open (sorted by occurrences desc)

### FIND-a7b3c9d2 — ...
### FIND-1e5f4a80 — ...

## Fixed

### FIND-b3c9d2a7 — ... (fixed 2026-04-18 in commit abc1234)
```

### Artifact layout per finding

```
docs/fuzz-reports/FIND-a7b3c9d2/
├── screenshot-A.png
├── screenshot-B.png
├── dom-A.html
├── dom-B.html
├── console.log
├── idb-A.json
├── idb-B.json
├── trace.json          # replay-able
└── network-events.ndjson  # LocalRelay events during the failing sequence
```

Rotation: subdirs with `mtime > 30d` and `Status: fixed` are moved to `docs/fuzz-reports/archive/`.

## 12. Replay

### Deterministic mode (`--backend=local`)

Replay guarantees: each step dispatches the same logical action, with the same arguments, against fresh browser contexts and a fresh strfry database. Expected reproduction rate: ~95%. Residual 5% is browser layout/scroll timing — mitigated by explicit `waitForPropagation` steps in the trace.

### Non-deterministic mode (`--backend=real`, `--tor`)

Replay is best-effort. The finding entry carries a `reproducibilityScore` (fraction of N=5 replay attempts that re-trigger the bug). Scores < 0.5 are tagged `[flaky]` in the markdown and Claude treats the trace as hint, not guarantee.

### Replay format (`trace.json`)

```json
{
  "seed": 1744924508331,
  "backend": "local",
  "commands": [
    {"name": "sendText", "args": {"from": "userA", "to": "userB", "text": "hi"}},
    {"name": "reloadPage", "args": {"user": "userB"}},
    ...
  ]
}
```

## 13. Dependencies

- **`fast-check`** (new, dev-dep) — property-based testing with stateful commands and shrinking. Version ^3.x.
- **`proper-lockfile`** (new, dev-dep) — safe concurrent append to `FUZZ-FINDINGS.md` across parallel pair processes.
- **`playwright`** (already installed, `^1.59.1`).
- **Docker** (already required for existing E2E LocalRelay).

No runtime dependencies added — everything is `devDependencies` and `src/tests/fuzz/` is excluded from production builds.

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Flakiness drowns the signal | Three-layer false-positive control (warmup, propagation window, explicit allowlist); every allowlist addition reviewed |
| Fuzzer finds bugs in itself, not the app | Each invariant has a unit test in `src/tests/fuzz/invariants/*.test.ts` proving it flags the intended violation and passes on a known-good state |
| Dedup signature conflates distinct bugs | Signature includes top stack frame — distinct code paths produce distinct sigs. If two real bugs merge, the maintainer can split by bumping invariant ID |
| Long runs hit OOM | Per-iteration context recreation; RAM budget capped per pair; `--pairs` defaults to 1 |
| Tor/real-backend runs are slow and mostly non-deterministic | Treated as a separate canal used pre-release (~30min sanity run) rather than the main loop |
| Public relays rate-limit during real-backend runs | Honor documented limits; back off on 429; default real-backend duration capped at 30m |
| LocalRelay strfry state contamination between iterations | Strfry `--tmpfs /app/strfry-db` (already used by E2E) wipes per-container-restart; fuzzer restarts the container between iterations if necessary |

## 15. Open questions

- **Media blob corpus**: initial set for `uploadAvatar`/media-send — ship 3 fixtures (tiny PNG, 1MB JPG, broken PNG)? Decided in implementation.
- **Group size distribution**: uniform 2-12 or biased toward 2-3? Defer to Phase 2 tuning.
- **Cross-session state**: should some fuzz iterations intentionally reuse prior IndexedDB state to exercise migration/restore paths? Defer to Phase 3.

## 16. Out of scope

- Channels (Phase 6, not yet shipped) — actions and invariants added when shipped.
- WebRTC/TURN paths — not in v1.
- Import-identity flow — partial, wait for Phase 2 completion.
- CI integration (nightly scheduled run with Slack alerts) — future milestone.
- Auto-fix loop (fuzzer triggers Claude to attempt fixes automatically) — deferred until fuzzer trust is established.

## 17. Implementation phasing

Phase gates match scope phases in section 6:

- **MVP (Phase 1, ~1 day)**: Harness + messaging actions + cheap invariants + reporter + replay. Ship pnpm script, verify replay works, run 1h and read `FUZZ-FINDINGS.md`.
- **Phase 2 (+1-2 days)**: Profile actions (avatar/name/bio/nip05), groups actions, medium + regression invariants, action postconditions expanded.
- **Phase 3 (+1-2 days)**: Lifecycle actions, chaos actions, Tor backend mode, UI contract manifest (v1 ~25 entries), parallelization (`--pairs`).
- **Evolution**: new bugs → new invariants / postconditions / UI contracts. Append-only.

Each phase is separately planned and executed via `writing-plans`.
