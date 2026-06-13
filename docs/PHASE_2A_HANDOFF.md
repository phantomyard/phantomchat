# Phase 2a Execution Handoff

This is a context handoff from a session that started with bug-fuzzer brainstorming (Phase 1 → 2h overnight run → Phase 2a spec + plan) and completed Tasks 1-5 of the Phase 2a plan before checkpointing. A fresh Claude Code session picks up from here.

## One-line goal

Execute remaining Phase 2a tasks (6-33) on the `feat/bug-fuzzer-phase-2a` branch via subagent-driven-development, then open a PR that passes the triple acceptance gate (tech + 2-device manual + regression baseline).

## Where everything is

**Worktree for execution:**
`/home/raider/Repository/nostra.chat-wt/fuzz-phase-2a` — already set up, deps installed, branch created.

**Branch:** `feat/bug-fuzzer-phase-2a` (tracks `origin/feat/bug-fuzzer-phase-2a` — push after the next few commits).

**Plan file (READ THIS FIRST):**
`docs/superpowers/plans/2026-04-18-bug-fuzzer-phase-2a.md` — 33 tasks total, Task 5 was the last one executed.

**Spec file:**
`docs/superpowers/specs/2026-04-18-bug-fuzzer-phase-2a-design.md` — the design the plan implements.

**Phase 1 context:**
- Spec: `docs/superpowers/specs/2026-04-17-bug-fuzzer-design.md`
- Plan: `docs/superpowers/plans/2026-04-17-bug-fuzzer-phase-1.md`
- Shipped in PR #39 merged to main.

## What's already done on the branch (Tasks 1-5 — delete bug cycle)

All committed on `feat/bug-fuzzer-phase-2a`:

| SHA | Message |
|---|---|
| `660d40a8` | feat(nostra): export isP2PPeer(peerId) predicate helper |
| `b5fe1963` | test(nostra): add red test for delete P2P short-circuit (FIND-676d365a) |
| `1f9f4c1f` | fix(messages): P2P short-circuit in deleteMessages — dispatch local update with correct pts_count |
| `53786c59` | fix(fuzz): un-mute POST_delete_local_bubble_gone after FIND-676d365a fix |
| `3e385b8a` | docs(fuzz): FIND-676d365a writeup — delete P2P short-circuit |

Outcome: `FIND-676d365a` delete-local-bubble-gone bug is **fixed**. Unit test green, postcondition un-muted, 388/388 tests passing.

## Remaining work (Tasks 6-33)

Per `docs/superpowers/plans/2026-04-18-bug-fuzzer-phase-2a.md`:

| Task | Title | Complexity |
|---|---|---|
| 6 | Write regression guard test for single-target mid rename | low (Vitest only) |
| 7 | Diagnose FIND-cfd24d69 via fuzz replay (instrument + replay + DIAGNOSIS.md) | **HIGH** — investigation, unknown root cause |
| 8 | Apply dup-mid fix (shape depends on Task 7) | **HIGH** — depends on diagnosis |
| 9 | Un-mute `INV-no-dup-mid` | low |
| 10 | Update FIND-cfd24d69 README status → fixed | low |
| 11 | Diagnose FIND-1526f892 — determine caso A vs B | medium |
| 12 | Write red test for sender-side reaction store | low |
| 13 | Implement `nostra-reactions-local.ts` + dispatch | medium |
| 14 | Wire reactions DOM updater in `src/components/chat/reactions.ts` | medium |
| 15 | Un-mute `POST_react_emoji_appears` | low |
| 16 | Write FIND-1526f892 README (sender-side fix, receive-side deferred to 2b) | low |
| 17 | `LocalRelay.getAllEvents()` extension | low (but needs ws import) |
| 18 | `INV-mirrors-idb-coherent` + `INV-peers-complete` (medium tier, `state.ts`) | medium |
| 19 | `INV-delivery-tracker-no-orphans` extension | medium |
| 20 | `INV-offline-queue-purged` (medium tier, `queue.ts`) | low |
| 21 | `INV-no-nip04` + `INV-idb-seed-encrypted` (regression tier, `regression.ts`) | medium |
| 22 | `editRandomOwnBubble` snapshot capture | low |
| 23 | `INV-edit-preserves-mid-timestamp` + `INV-edit-author-check` | medium |
| 24 | `INV-virtual-peer-id-stable` (regression, silent in 2a — gated on reloadPage action) | low |
| 25 | Register 9 new invariants + add `runEndOfSequence` / `runEndOfRun` | medium |
| 26 | Wire tier runners into `fuzz.ts` main loop | medium |
| 27 | CLI flags `--emit-baseline` + `--replay-baseline` | medium |
| 28 | Round-trip unit test for baseline emit/replay | low |
| 29 | Generate `docs/fuzz-baseline/baseline-seed42.json` (10m fuzz run + emit) | medium — needs dev server + docker |
| 30 | Create `docs/VERIFICATION_2A.md` manual checklist | low |
| 31 | Tech gate — run full automated acceptance (~45 min) | medium — needs dev server |
| 32 | Update `CLAUDE.md` with Phase 2a notes | low |
| 33 | Open the PR with `gh pr create` | low |

## Gotchas learned during Tasks 1-5

1. **`@config/debug` mock needs `default` export**: when vitest imports `appMessagesManager.ts` (which imports `@config/debug` default), the mock must provide `{default: {...}, <spread-keys>}` shape. Task 3's implementer discovered this.

2. **Instance-level manager stubs, not module-level mocks**: `AppManager` wires deps via `Object.assign(this, managers)`. `vi.doMock('@lib/appManagers/appPeersManager'...)` doesn't help because the instance has already been constructed with real refs. Stub on the instance: `appMessagesManager.apiUpdatesManager = {processLocalUpdate: capture}`.

3. **`fake-indexeddb/auto` at test file top**: modules that init IDB at import time will throw `indexedDB is not defined` in jsdom. Import `fake-indexeddb/auto` before importing any Nostra module.

4. **New tests need to be added to `pnpm test:nostra:quick` manually** — per CLAUDE.md, the quick path lists test files explicitly.

5. **ESLint `no-space-before-paren` rule**: project enforces `async ()` as `async()`. Pre-commit hook fails on space-before-paren. Task 2's implementer had to `async()` in 4 places.

## How to resume

Start a fresh Claude Code session at repo root (`/home/raider/Repository/nostra.chat`), then:

```
I'm resuming Phase 2a execution per docs/PHASE_2A_HANDOFF.md.

Worktree: ../nostra.chat-wt/fuzz-phase-2a (branch feat/bug-fuzzer-phase-2a).
Plan: docs/superpowers/plans/2026-04-18-bug-fuzzer-phase-2a.md
Spec: docs/superpowers/specs/2026-04-18-bug-fuzzer-phase-2a-design.md

Tasks 1-5 are complete (delete P2P fix cycle). Next is Task 6.

Use superpowers:subagent-driven-development to execute tasks 6-33 in order:
- Read each task from the plan file (full text, don't just reference).
- Dispatch a fresh implementer subagent per task with the verbatim task text + the "Gotchas" section from the handoff doc as context.
- After each task: verify commit landed, run quick checks (tsc/vitest), then move to next.
- Skip spec+quality reviewer rounds UNLESS the task touches substantive logic (bugs 1/3 fixes, invariant implementations); for doc/comment-only/un-mute tasks, a Bash verify of the commit is sufficient.
- Task 7 (dup-mid diagnose) REQUIRES running the dev server + replaying a fuzz finding. The implementer will need to start `pnpm exec vite --port 8090 --strictPort` in background and replay FIND-cfd24d69. Make sure Docker is running for strfry LocalRelay.

Start with Task 6.
```

## Environment pre-check to run before Task 6

```bash
# Verify Docker is available (needed for LocalRelay)
docker ps  # expect empty table or some containers

# Verify pnpm + tsx work
cd /home/raider/Repository/nostra.chat-wt/fuzz-phase-2a
pnpm fuzz --help  # expect help text
pnpm test:nostra:quick 2>&1 | tail -3  # expect 388+/388+ passing
```

## Acceptance gate reminder

Before merging the PR (Task 33), all three must pass:
- **A — Tech gate** (Task 31): unit tests + lint + tsc + 30m clean fuzz + E2E
- **B — Manual 2-device verification** (Task 30): maintainer runs the checklist and posts "PASS 2A manual"
- **C — Regression baseline** (Task 29): `docs/fuzz-baseline/baseline-seed42.json` committed + `pnpm fuzz --replay-baseline` exits 0

Spec §9 has the full criteria.

## Phase 1 context bits worth knowing

- **Fuzz invariants currently muted** (un-mute is part of this phase):
  - `INV-no-dup-mid` in `src/tests/fuzz/invariants/index.ts` — Task 9 un-mutes
  - `POST_delete_local_bubble_gone` in `src/tests/fuzz/postconditions/index.ts` — Task 4 un-muted ✓
  - `POST_react_emoji_appears` in `src/tests/fuzz/postconditions/index.ts` — Task 15 un-mutes
- **Fuzz documented findings** so far (directories under `docs/fuzz-reports/`):
  - `FIND-cfd24d69/README.md` — dup-mid (status: open, Phase 2a fixes)
  - `FIND-676d365a/README.md` — delete P2P (status: **fixed** by commit `1f9f4c1f`)
  - (Phase 2a Task 16 will create `FIND-1526f892/README.md`)

## Summary of progress

- Phase 1 MVP: ✅ shipped PR #39
- Phase 2a planning: ✅ spec + plan committed to main
- Phase 2a execution: 🔄 5/33 tasks done — delete bug cycle closed
- Phase 2a remaining: 28 tasks — dup-mid + react fixes + invariants + baseline + acceptance gate

Clean checkpoint. Fresh session picks up at Task 6.
