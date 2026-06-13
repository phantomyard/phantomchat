# Agentic Explorer — Design Spec

**Status**: brainstormed, awaiting user review before plan
**Date**: 2026-04-29
**Driver**: nostra.chat user (giuliodeltaindia@gmail.com)
**Scope**: MVP for an agentic exploration system that discovers bugs in nostra.chat surfaces not covered by the existing fuzz harness, and (where safe) opens auto-fix PR drafts.

---

## 1. Why this exists

The existing fuzz harness (`src/tests/fuzz/`) is property-based: it samples actions from a hand-coded `actionArb` and checks against hand-coded oracles (invariants, postconditions, end-of-sequence). It's deterministic, fast, and has shipped real fixes (mirror IDB coherence, group bridge, reactions eventId).

But its coverage is **bounded by the action set** and **bounded by the oracle set**. Surfaces and bug classes that aren't modelled stay invisible. The user's pain (Q1) is **coverage**: bugs being missed because the fuzz can't see them.

The agentic explorer fills this gap by exploring the UI like a curious user, generating expectations on the fly, and catching whole classes of bugs (visual regressions, missing UI elements, network failures, broken navigation) the property-based fuzz can't model.

**Pain**: coverage, not investigation/fix throughput.
**Target areas** (Q2): profile editing advanced (bio/avatar/Lightning/relays), media & input (paste, drag&drop, voice, media editor, stickers), edge of messaging already fuzzed (forward, pin, delete-for-everyone, search, scroll history), network/offline (relay drop, offline queue, slow connection).

---

## 2. Architecture overview

The explorer is an **in-session Claude Code agentic system** that pilots a pair of Playwright browser contexts (userA, userB). It is invoked manually, runs on demand, produces findings in a fuzz-compatible format, and (where the LLM judges safe and guardrails permit) opens **draft PR fixes**.

```
┌────────────────────────────────────────────────────────────────────┐
│ User's Claude Code session                                         │
│                                                                    │
│  /nostra-explore "<goal>"                                          │
│         │                                                          │
│         ▼                                                          │
│  Slash command (.claude/commands/nostra-explore.md)                │
│  Compiles prompt + budget, dispatches the explorer subagent        │
│         │                                                          │
│         ▼                                                          │
│  ┌─────────────────────────────────────────────┐                   │
│  │ Subagent: nostra-explorer                   │                   │
│  │ (.claude/agents/nostra-explorer.md)         │                   │
│  │                                             │                   │
│  │ Tool whitelist: Bash, Read, Write, Glob     │                   │
│  │ NO: Edit on src/                            │                   │
│  │                                             │                   │
│  │ Internal loop:                              │                   │
│  │  1. Read priming pack                       │                   │
│  │  2. Bash: spawn driver subprocess           │                   │
│  │  3. Bash: send {capture}                    │                   │
│  │  4. Reason → emit intent + expectation      │                   │
│  │  5. Bash: send {execute intent}             │                   │
│  │  6. Verify → finding? → Write FIND-*        │                   │
│  │  7. Stop on first finding or budget end     │                   │
│  └─────────────────────────────────────────────┘                   │
│         │                                                          │
│         │ if finding produced                                      │
│         ▼                                                          │
│  ┌─────────────────────────────────────────────┐                   │
│  │ Subagent: nostra-fixer (fresh context)      │                   │
│  │ (.claude/agents/nostra-fixer.md)            │                   │
│  │                                             │                   │
│  │ Input: FIND-*/                              │                   │
│  │ 1. Self-classification (mandatory schema)   │                   │
│  │ 2. If category not-shallow → exit           │                   │
│  │ 3. git worktree + branch                    │                   │
│  │ 4. Edit (Edit/Write tool exposed here)      │                   │
│  │ 5. Regex tripwire on diff → match? rollback │                   │
│  │ 6. Test gates (replay+quick+lint+tsc)       │                   │
│  │ 7. gh pr create --draft                     │                   │
│  └─────────────────────────────────────────────┘                   │
└────────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────────┐
│ Node driver subprocess (long-running, Unix socket IPC)             │
│                                                                    │
│  scripts/explorer/driver.ts                                        │
│   - Imports bootHarness from src/tests/fuzz/harness.ts             │
│   - Opens pageA + pageB on pnpm preview                            │
│   - Exposes line-based JSON protocol over Unix socket              │
│   - Commands: capture | intent | atomic | snapshot | teardown      │
│   - Internally: intent registry (scripts/explorer/intents/*)       │
│                                                                    │
│  pnpm preview (production build, :8080)                            │
│   - 2 isolated BrowserContext                                      │
│   - Shared LocalRelay                                              │
└────────────────────────────────────────────────────────────────────┘
```

### Components

| Component | Responsibility | Reuse |
|---|---|---|
| Slash command `/nostra-explore` | User entry point, args parsing, explorer subagent dispatch | new |
| Explorer subagent | Exploration loop, decision making, finding writing | new |
| Fixer subagent | Self-classification, fix attempt, gates, PR | new |
| Node driver `scripts/explorer/driver.ts` | Multi-context Playwright, IPC protocol | **reuses** `bootHarness`, allowlist, types from fuzz |
| Intent registry `scripts/explorer/intents/*.ts` | High-level move catalog → atomic | **wraps** `src/tests/fuzz/actions/*` |
| Oracle library `scripts/explorer/oracles/*.ts` | A (hard), B (typed expectation verifier), D (invariant runner) | **reuses** logic from `postconditions/`, `invariants/` |
| Reporter `scripts/explorer/reporter.ts` | FIND-* artifact, signature, dedup, allowlist | **reuses** fuzz reporter schema |
| Replay `scripts/explorer/replay.ts` | Re-runs trace pure-Playwright (no LLM) | new |
| Output `docs/explorer-reports/` | FIND-{id}/ + seen-signatures.json + allowlist.ts | new, fuzz-compatible format |

### Isolation principles

- **Explorer subagent CANNOT Edit/Write src/**. Read + Write on `docs/explorer-reports/` + Bash only. Discovery phase cannot accidentally modify the product.
- **Fixer subagent CAN Edit/Write src/** but constrained to a separate worktree. Errors cannot touch the user's main worktree.
- **Driver subprocess is isolated** — driver crash does not bring the subagent down; subagent can re-spawn it.
- **Intent registry and fuzz actions are cousins, not duplicates**: intents import existing `actionImpl` from the fuzz where present.
- **Replay is pure-Playwright**: `pnpm explorer:replay <FIND-id>` does not call LLM, just re-runs the trace. Zero-cost reproduction.

---

## 3. Run lifecycle (one full flow)

### Invocation

```
/nostra-explore "edit profile bio with very long string"
/nostra-explore                          (no arg → autonomous goal)
/nostra-explore --budget=20m --steps=80  (explicit caps)
/nostra-explore --no-fix                 (report-only, skip fixer dispatch)
```

Default budget: **30 minutes** OR **120 steps** (whichever first), stop-on-first-finding.

### End-to-end flow (single run, intent-level)

```
T+0s   [slash command]  parse args, build prompt, dispatch explorer subagent
T+1s   [explorer]       Read priming pack:
                          - docs/FEATURES.md  (what the app does)
                          - docs/FUZZ-FINDINGS.md  (known bugs, do not duplicate)
                          - .claude/projects/.../memory/MEMORY.md  (rules)
                          - docs/explorer-reports/seen-signatures.json (cross-run dedup)
                          - docs/explorer-reports/allowlist.ts (known noise)
                        Decide goal (A explicit | D autonomous, cold-zone bias)

T+5s   [explorer]       Bash: spawn `node scripts/explorer/driver.ts --socket=/tmp/exp-$$.sock`
                        Driver: bootHarness → 2 BrowserContext, navigate pnpm preview, login A+B
                        Driver: emit READY on socket

T+15s  [explorer]       LOOP (step 1)
       └─ Bash: send {cmd: "capture"}
          ← {pageA: {screenshot, ax_tree, console, network}, pageB: {...}, time}
       └─ Reason: "goal=edit bio long string. I'm in chat list on A. Need to open settings."
       └─ Emit: {
            intent: "open_settings",
            params: {page: "A"},
            expectation: {
              type: "element_appears", page: "A", selector_hint: "settings panel header",
              text_contains: "Settings", timeout_ms: 3000
            }
          }
       └─ Bash: send {cmd: "intent", payload: <above>}
          ← {ok: true, atomic_trace: [{type:"click",...}], duration_ms: 420}
       └─ Verify expectation via driver:
          - Driver runs Playwright vanilla check → match? OK : finding-candidate
          - PLUS Oracle A (hard, always): console errors / unhandled / 5xx → match? finding
       └─ Append step to trace; persist to /tmp/exp-$$/trace.jsonl

T+30s  [explorer]       LOOP (step 2..N) — same pattern, expectation per step
                        Goal-aware reasoning across steps.

T+...  [explorer]       Periodic invariants (Oracle D), every 10 steps:
                        - generated invariants
                        - run via driver → match? finding

T+X    CANDIDATE finding fires (expectation failed | console error | invariant violated)
       └─ [explorer]    Run second-pass triage (Oracle B candidates only — Oracle A
                        and D are deterministic, no triage needed):
                        LLM call: "given goal X, expectation Y, observed Z, real bug
                        or unfounded expectation?" → accept | reject
                        - reject → log to triage-rejected.jsonl, continue loop
                        - accept → proceed to STOP-ON-FIRST
       └─ STOP-ON-FIRST: break loop
       └─ [explorer]    compute signature(area, intent, oracle, hashed_msg)
                        check seen-signatures.json:
                          - already seen, status=open? → bump occurrences, exit clean
                          - already seen, status=fixed? → REGRESSION, FIND with regression flag
                          - already seen, status=allowlisted? → ignore
                          - new? → continue to artifact creation

       └─ [explorer]    Write artifact: docs/explorer-reports/FIND-<8hex>/
                          ├─ report.md           (human report: goal, steps, expectation, observation)
                          ├─ trace.jsonl         (intent+atomic for replay)
                          ├─ screenshots/        (pageA+B at finding moment)
                          ├─ ax-trees.json
                          ├─ console.log
                          ├─ network.har
                          └─ signature.txt
       └─ Update seen-signatures.json

       └─ Bash: send {cmd: "teardown"} → driver closes contexts, removes socket
       └─ [explorer]    Emit summary back to slash command

T+X+1s [main session]   Decide: dispatch fixer subagent (default yes, opt-out via --no-fix)

[fixer flow → §5]
```

### Cleanup guarantees

- `try/finally` in subagent: even on crash mid-run, driver receives teardown
- Driver has **idle timeout** (10 min without commands → self-shutdown)
- `pkill -f "explorer/driver.ts"` as last-resort safety net

### Persistence between runs

| File | Role | Versioned? |
|---|---|---|
| `docs/explorer-reports/FIND-*/` | Finding artifacts | yes (committed like fuzz) |
| `docs/explorer-reports/seen-signatures.json` | Cross-run dedup | yes |
| `docs/explorer-reports/allowlist.ts` | Known noise to skip | yes (user edits) |
| `docs/explorer-reports/areas-coverage.json` | Per-area exploration counts (for goal-D balancing) | yes |
| `/tmp/exp-<pid>/` | Volatile run state | no (gitignore) |

---

## 4. Intent registry & oracle stack

### Intent registry — concretizing choice C (Q9)

```typescript
// scripts/explorer/intents/types.ts
export type IntentName = string;

export interface IntentDef<P = IntentParams> {
  name: IntentName;
  area: 'messaging' | 'profile' | 'media' | 'navigation' | 'settings' | 'network' | 'edge';
  paramsSchema: ZodSchema<P>;
  description: string;             // visible to LLM in system prompt
  exec: (params: P, ctx: DriverContext) => Promise<IntentResult>;
}

export interface IntentResult {
  ok: boolean;
  atomic_trace: AtomicAction[];    // Playwright vanilla sequence for replay
  observations: Observation[];      // post-action snapshot
  error?: string;
}

export type AtomicAction =
  | {type: 'click', page: 'A'|'B', selector: string}
  | {type: 'fill', page: 'A'|'B', selector: string, value: string}
  | {type: 'press', page: 'A'|'B', key: string}
  | {type: 'navigate', page: 'A'|'B', url: string}
  | {type: 'wait', ms: number}
  | {type: 'evaluate', page: 'A'|'B', script: string};
```

### Initial catalog (MVP)

Bootstrap from existing fuzz actions + new intents for the four Q2 areas:

```
Wrappers from fuzz:
  send_text_message       wraps actions/messaging.ts::sendText
  edit_own_message        wraps actions/messaging.ts::editRandomOwnBubble
  react_to_message        wraps actions/reactions.ts::reactViaUI
  create_group            wraps actions/groups.ts::createGroup
  leave_group             wraps actions/groups.ts::leaveGroup
  edit_profile_field      wraps actions/profile.ts (existing)

New for Q2 areas:
  edit_bio_with_text      params: {text}
  upload_avatar           params: {imagePath}
  configure_lightning_address params: {address}
  edit_relays_nip65       params: {add: string[], remove: string[]}
  paste_image_to_input    params: {imagePath}
  drag_drop_file_to_chat  params: {filePath}
  record_voice_message    params: {durationMs}
  forward_message         params: {fromBubbleHint, toPeer}
  pin_message             params: {bubbleHint}
  delete_for_everyone     params: {bubbleHint}
  search_in_chat          params: {query}
  scroll_history_back     params: {messageCount}
  toggle_offline          params: {page, offline: boolean}
  disconnect_relay        params: {relayUrl}
  reconnect_relay         params: {relayUrl}
  slow_network            params: {downloadKbps, uploadKbps}
```

### Atomic fallback (intent off-catalog)

If the LLM emits an unknown intent, the driver responds `{error: "unknown_intent", available_intents: [...]}`. The LLM has two options:

1. Reformulate using a catalog intent
2. Decompose into atomic actions: emit `{atomic_actions: [{type:"click",...}, ...]}` — the driver executes them in sequence; atomic_trace IS the sequence.

The two emit formats are mutually exclusive per step: the LLM either emits `{intent, params, expectation}` OR `{atomic_actions, expectation}`, never both. The expectation is mandatory in either case (Oracle B requires it).

**No "dynamic intents" the LLM creates as functions on the fly**: too risky. The catalog grows only via human PR.

### Reuse: shared `bootHarness` + fuzz actions

```typescript
import {bootHarness, type FuzzContext} from '../../src/tests/fuzz/harness';
import {sendText} from '../../src/tests/fuzz/actions/messaging';

const ctx = await bootHarness({headed: false, slowMo: 0});

export const send_text_message: IntentDef = {
  name: 'send_text_message',
  area: 'messaging',
  paramsSchema: z.object({from: z.enum(['userA','userB']), text: z.string()}),
  description: 'Send a text message from one user to the other.',
  async exec(params, ctx) {
    return await sendText({from: params.from, text: params.text}, ctx);
  }
};
```

The fuzz `Action` types are extended with `atomic_trace`/`observations` capture (backwards-compatible, optional for vanilla fuzz).

### Oracle A — Hard automatic (always on)

Run by the driver after EVERY intent (or atomic action), before returning result:

| Oracle | Trigger |
|---|---|
| `console_error` | any `page.on('console')` with type=error, excluding allowlist patterns |
| `unhandled_rejection` | `page.on('pageerror')` |
| `network_5xx` | `page.on('response')` with `status >= 500`, excluding noted |
| `network_4xx_unexpected` | 4xx on endpoint not in allowlist |
| `white_screen` | post-action screenshot: > 95% uniform pixels → suspect |
| `crash` | unexpected `page.isClosed()` |

Signature: `A:<oracle>:<truncated_message_hash>`. Example: `A:console_error:8a7b2c1f`.

**Reuse**: `src/tests/fuzz/allowlist.ts` is **directly imported** by the oracle layer. Explorer adds `docs/explorer-reports/allowlist.ts` only for patterns specific to exploration.

### Oracle B — Expectation-based typed (declared BEFORE execution)

Strict schema eliminates free prose:

```typescript
export type Expectation =
  | {type: 'element_appears', page: 'A'|'B', selector_hint: string, text_contains?: string, timeout_ms: number}
  | {type: 'element_disappears', page: 'A'|'B', selector_hint: string, timeout_ms: number}
  | {type: 'text_changes', page: 'A'|'B', selector_hint: string, from?: string, to_contains: string, timeout_ms: number}
  | {type: 'navigation_to', page: 'A'|'B', url_pattern: string, timeout_ms: number}
  | {type: 'count_equals', page: 'A'|'B', selector_hint: string, count: number, timeout_ms: number}
  | {type: 'value_changes', page: 'A'|'B', selector_hint: string, expected: string, timeout_ms: number}
  | {type: 'bilateral_message_propagation', from_page: 'A'|'B', to_page: 'A'|'B', text_contains: string, timeout_ms: number};
```

Verifier **runs in driver via Playwright vanilla**, not another LLM call:

- `selector_hint` resolved by a fallback chain in priority order: (1) `data-testid` exact match, (2) ARIA `role` + accessible name, (3) visible text contains, (4) `aria-label` exact, (5) CSS class match. First non-empty match wins; if all fail, expectation resolves to `{ok: false, reason: "selector_unresolvable"}`
- Match → `{ok: true}`. Timeout → `{ok: false, observed: <screenshot+ax-tree>}`.

**Second-pass triage** before writing FIND-*: a second prompt to the subagent ("given goal X, expectation Y, observed Z, real bug or unfounded expectation?"). If "unfounded", discard — log to `docs/explorer-reports/triage-rejected.jsonl` for audit. Costs ~1 extra LLM call per finding but eliminates ~80% of expected false positives.

### Oracle D — Cross-page invariants (LLM-generated, periodic)

Generated once at run start by the subagent reading the domain, written as inline TypeScript functions (validated before accepting):

```typescript
{
  name: "INV-bilateral-message-count",
  description: "Messages visible to B equals messages sent by A minus deleted",
  fn: async (ctx) => {
    const sentA = await ctx.pageA.locator('.bubble.is-out').count();
    const seenB = await ctx.pageB.locator('.bubble.is-in').count();
    const deletedA = await ctx.pageA.evaluate(/* ... */);
    return {ok: sentA - deletedA === seenB, value: {sentA, seenB, deletedA}};
  }
}
```

**Safety**: LLM generates `fn` as string, driver eval-s it in a sandbox VM (`node:vm` with limited context). Sandbox exposes only `ctx.pageA`, `ctx.pageB`, `ctx.relay` — no `require`, `process`, `fs`. Invariants are GENERATED once, at run start (max 5 per run), then RUN periodically every 10 steps during the loop. Each invariant execution has a 5s timeout. Violation → finding (no triage needed for D, the assertion is deterministic).

Persistence: "good" invariants (never violated for N consecutive runs without being a FIND root cause) can be **promoted** to permanent fuzz invariants via human PR.

### Signature & cross-run dedup

```typescript
function computeSignature(f: Finding): string {
  return [
    f.area,                        // 'profile' | 'messaging' | …
    f.intent_name || 'atomic',
    f.oracle_kind,                 // 'A:console_error' | 'B:element_appears' | 'D:INV-x'
    truncatedHash(f.error_signature, 8)
  ].join(':');
}
// Example: "profile:edit_bio_with_text:B:element_appears:8a7b2c1f"
```

`docs/explorer-reports/seen-signatures.json`:
```json
{
  "profile:edit_bio_with_text:B:element_appears:8a7b2c1f": {
    "find_id": "FIND-3c99f5a3",
    "first_seen": "2026-04-29T14:22:00Z",
    "last_seen": "2026-04-30T09:11:00Z",
    "occurrences": 4,
    "status": "open" | "fixed" | "allowlisted"
  }
}
```

A run hitting an `open` signature: bump occurrences, **no** new FIND, exit clean. A `fixed` signature reappearing: REGRESSION, new FIND with `regression: true` flag. An `allowlisted` signature: ignored.

---

## 5. Finding → fixer pipeline (auto-fix C-mode with guardrails)

### Trigger and handoff

When the explorer writes `docs/explorer-reports/FIND-<id>/`, the slash command (main session, not explorer) decides whether to proceed to auto-fix. Default: yes if signature is new; opt-out via `/nostra-explore --no-fix`.

```
[explorer subagent] returns: {find_id, signature, summary}
        │
        ▼
[main session]  Check fix gate:
                  - --no-fix flag? → stop, report only
                  - signature already seen with status=fixed?
                    → REGRESSION, alert user, NO auto-fix
                  - default: dispatch fixer subagent
```

### Fixer subagent — 7-stage pipeline

```
INPUT: docs/explorer-reports/FIND-<id>/

STAGE 1 — Self-classification (mandatory, structured output)
────────────────────────────────────────────────────────────
Fixer MUST emit this JSON first:
{
  category: "ui-cosmetic" | "i18n" | "timeout-bump" | "logic-pure" | "css-style"
          | "async-timing" | "storage" | "race" | "messageport" | "other",
  confidence: 0..1,
  reasoning: string,
  scope_files: string[]
}

ALLOWED categories to proceed:
  ui-cosmetic, i18n, timeout-bump, logic-pure, css-style

DISALLOWED → immediate exit, status="report-only", reason logged:
  async-timing, storage, race, messageport, other
  (even with confidence=0.99 — LLM cannot force scope outside this set)

STAGE 2 — Branch + worktree setup
─────────────────────────────────
git worktree add ../nostra.chat-explorer/<find-id> -b explorer/fix-<find-id> main
cd ../nostra.chat-explorer/<find-id>
All edits happen in this separate worktree. User's main worktree is never touched.

STAGE 3 — Edit (LLM-driven, free within declared category)
──────────────────────────────────────────────────────────
Fixer modifies files. Soft prompt-level constraints:
  - "Stay within scope_files declared in stage 1"
  - "Total diff ≤ 50 lines (soft cap)"
  - "Do not add new dependencies (pnpm install)"

STAGE 4 — Regex tripwire (HARD GATE, automated, not bypassable by LLM)
─────────────────────────────────────────────────────────────────────
git diff --staged | regex_check.sh
Banned patterns (match → abort):
  - MessagePort | postMessage | new Promise | \.then\( | async function (in production code, not tests)
  - setTimeout | setInterval | requestAnimationFrame | clearTimeout
  - IndexedDB | StorageKey | getStorage | storage\.delete
  - Worker | SharedWorker | ServiceWorker
  - relay | subscription | nostra-sync | virtual-mtproto

EXCEPTIONS:
  - timeout-bump category MAY modify numeric constants in src/tests/fuzz/postconditions/
  - Check is on additions (+ in diff) only, not removals
  - "production" = any file under src/ EXCEPT src/tests/. Test files (src/tests/**)
    are permissive: banned patterns there are allowed. The intent is to protect
    production runtime code, not test scaffolding.

Match in production → git rollback, downgrade FIND to "report-only", exit.

STAGE 5 — Test gate (HARD, sequential, fail-fast)
─────────────────────────────────────────────────
Sequential Bash invocations:
  1. node scripts/explorer/replay.js FIND-<id>     # bug must NOT reproduce
  2. pnpm test:nostra:quick                        # ~160 critical tests, < 2s
  3. pnpm lint                                     # ESLint on src/**/*.{ts,tsx}
  4. npx tsc --noEmit                              # full type check

Any failure → rollback worktree, downgrade FIND to "report-only",
write FIND-<id>/fix-attempt-failed.md with stage and output.

STAGE 6 — Commit + push + PR draft
───────────────────────────────────
git add <files>
git commit -m "fix(explorer): <one-line description>

Fixes FIND-<id> (signature: <sig>).
Category: <cat>. Confidence: <conf>.
Test gates: replay ✓ test:nostra:quick ✓ lint ✓ tsc ✓

Co-Authored-By: nostra-explorer <noreply@nostra.chat>"

git push -u origin explorer/fix-<find-id>
gh pr create --draft --title "fix(explorer): <desc>" --body "<full body>"

Title: ALWAYS Conventional Commit (memory rule honored).
Draft: ALWAYS. NO auto-merge. User reviews.

Body includes:
  - link to FIND-<id> artifact (with before/after screenshots)
  - fixer self-classification (cat + confidence + reasoning)
  - diff summary
  - replay command for manual verification
  - "Test gates passed" checklist
  - "[explorer-generated]" footer

STAGE 7 — Update seen-signatures.json
──────────────────────────────────────
{
  "<signature>": {
    ...,
    "status": "fix-pr-open",
    "fix_pr": "https://github.com/.../pull/N",
    "fix_branch": "explorer/fix-<find-id>"
  }
}

OUTPUT: PR URL + summary returned to main session
```

### Failure modes & handling

| Stage | Failure | Consequence |
|---|---|---|
| 1 self-classification | category disallowed | report-only, no PR |
| 1 self-classification | output not parsable | retry 1x, then report-only |
| 2 worktree | path already exists (prior run) | `git worktree remove --force`, recreate |
| 3 edit | LLM touches files outside `scope_files` | warning + proceed; stage 4 regex catches anyway |
| 4 regex tripwire | match | rollback, report-only, log matched pattern in `fix-attempt-failed.md` |
| 5.1 replay | bug still reproduces | fix doesn't resolve → rollback |
| 5.2 test:nostra:quick | failure | fix breaks regression tests → rollback |
| 5.3 lint | error | typical LLM mistake → rollback (NEVER `--no-verify`) |
| 5.4 tsc | error | typical LLM mistake → rollback |
| 6 push | network/auth | retry 2x, then report-only with local branch |
| 6 gh pr create | tool not authed | report-only with pushed branch |

**Golden rule**: every rollback saves `FIND-<id>/fix-attempt-N/` with stage, output, attempted diff. Builds an audit dataset of "what the LLM tries when it CAN'T fix correctly". Useful for refining guardrails over time.

### Rate limit & worktree hygiene

- **Max 1 fixer subagent active** at a time (mutex via lockfile `/tmp/nostra-explorer-fixer.lock`)
- **Worktree cleanup**: after PR merge (or close), `pnpm explorer:cleanup-worktrees` removes obsolete worktrees. NOT automatic — user runs.
- **Soft cap on open draft PRs**: if 5+ `explorer/fix-*` draft PRs already open on GitHub, fixer refuses to open new ones → forces user to drain backlog before accumulating.

### REGRESSION behavior

If signature `status=fixed` re-emerges: new FIND with `regression: true` flag, **never** auto-fix (previous fix didn't hold, needs human to understand why). Summary slack to user: "⚠️ regression detected on signature X, previous fix in PR #Y didn't hold".

---

## 6. File layout, scope, future work

### Full file layout

```
nostra.chat/
├── .claude/
│   ├── commands/
│   │   └── nostra-explore.md            # /nostra-explore slash command
│   └── agents/
│       ├── nostra-explorer.md           # explorer subagent (NO Edit tool)
│       └── nostra-fixer.md              # fixer subagent (Edit OK in worktree)
│
├── scripts/
│   └── explorer/
│       ├── driver.ts                    # entry — long-running Node, opens 2 contexts
│       ├── ipc.ts                       # JSON line protocol over Unix socket
│       ├── intents/
│       │   ├── types.ts                 # IntentDef, IntentResult, AtomicAction
│       │   ├── registry.ts              # exports the catalog
│       │   ├── messaging.ts
│       │   ├── reactions.ts
│       │   ├── groups.ts
│       │   ├── profile.ts
│       │   ├── media.ts
│       │   ├── messaging-edge.ts
│       │   ├── network.ts
│       │   └── navigation.ts
│       ├── oracles/
│       │   ├── hard.ts                  # A: console/network/crash/whitescreen
│       │   ├── expectations.ts          # B: typed expectation verifier
│       │   ├── invariants.ts            # D: vm-sandbox runner + invariant store
│       │   └── triage.ts                # second-pass LLM triage on candidates
│       ├── reporter.ts                  # FIND-* artifact writer
│       ├── replay.ts                    # `pnpm explorer:replay <FIND-id>` entry
│       ├── signature.ts                 # computeSignature + dedup logic
│       ├── allowlist.ts                 # explorer-specific noise (extends fuzz)
│       └── selector-resolver.ts         # selector_hint → robust selector heuristic
│
├── docs/
│   └── explorer-reports/
│       ├── README.md                    # how to read FINDs, replay, allowlist
│       ├── seen-signatures.json         # cross-run dedup
│       ├── areas-coverage.json          # per-area exploration counts
│       ├── allowlist.ts                 # known noise to skip
│       ├── triage-rejected.jsonl        # audit of finding discarded by triage
│       └── FIND-<8hex>/
│           ├── report.md                # human report
│           ├── trace.jsonl              # intent+atomic for replay
│           ├── screenshots/
│           ├── ax-trees.json
│           ├── console.log
│           ├── network.har
│           ├── signature.txt
│           └── fix-attempt-N/           # only if fixer attempted
│               ├── classification.json
│               ├── diff.patch
│               ├── stage-failed.txt
│               └── outputs.log
│
├── src/tests/
│   ├── fuzz/                            # unchanged, explorer imports but does not modify
│   │   ├── harness.ts                   # bootHarness reused
│   │   ├── allowlist.ts                 # imported by oracles/hard.ts
│   │   ├── actions/                     # wrapped by intents
│   │   └── postconditions/              # logic verifier reusable in oracles/expectations
│   │
│   └── explorer/
│       ├── intents.test.ts              # every intent has valid schema + synthetic example
│       ├── signature.test.ts            # dedup signature stable on identical inputs
│       ├── regex-tripwire.test.ts       # banned patterns caught on synthetic diffs
│       ├── replay.test.ts               # known trace.jsonl replays end-to-end
│       └── classification.test.ts       # stage-1 fixer output schema parsable
│
└── package.json                         # new scripts (explorer:driver, explorer:replay, ...)
```

### New `package.json` scripts

```json
{
  "scripts": {
    "explorer:driver": "tsx scripts/explorer/driver.ts",
    "explorer:replay": "tsx scripts/explorer/replay.ts",
    "explorer:cleanup-worktrees": "tsx scripts/explorer/cleanup.ts",
    "explorer:list-findings": "ls -1 docs/explorer-reports/FIND-*/ 2>/dev/null"
  }
}
```

`/nostra-explore` invokes `pnpm explorer:driver` as internal subprocess; user does not call directly.

### Scope MVP — in

- ✅ Slash command `/nostra-explore [<goal>]` with default 30m/120step budget
- ✅ Explorer subagent + Fixer subagent definitions
- ✅ Node driver with 2 BrowserContext via `bootHarness`, Unix socket IPC
- ✅ Initial intent catalog (~25 intents) covering the 4 Q2 areas
- ✅ Atomic fallback for off-catalog intents
- ✅ Oracle stack A + B + D, second-pass triage
- ✅ Signature + cross-run dedup + regression detection
- ✅ Auto-fix C-mode with classification + regex tripwire + 4 test gates
- ✅ Conventional-titled draft PR in separate worktree, never auto-merge
- ✅ Pure-Playwright deterministic replay
- ✅ Tests for the explorer system itself (5 test files)

### Out of scope MVP — explicit (anti-scope-creep)

- ❌ Background loop / cron / CI integration (Q3 options B/C/D)
- ❌ Cloud always-on (Q3 option D)
- ❌ Multi-pair parallel (more than one context pair simultaneously)
- ❌ Auto-promotion of intents/expectations/invariants to fuzz (kept as human-curated PR step post-MVP)
- ❌ Network/Tor scenarios (Tor cold-start is known chaos; explorer simulates offline via Playwright `setOffline` but does NOT run with Tor)
- ❌ Push notifications, Service Worker update flow (Phase A) — too delicate
- ❌ Multi-account (>2 users simultaneously)
- ❌ Visual regression / screenshot diff suite

### Implementation phasing (input for `writing-plans`)

| Phase | Content | Verifiable by |
|---|---|---|
| **F1: skeleton** | driver + IPC + 5 intents (send_text, react, edit_profile, scroll, navigate) + oracle A + replay | Manual run `/nostra-explore "send a message"` produces trace.jsonl + deterministic replay. No B/D/fixer yet. |
| **F2: full explorer** | Complete intent catalog + oracle B + D + triage + signature dedup + markdown report | Run on "edit profile" area surfaces a plausible finding (synthetic, manually injected for test OK). |
| **F3: fixer pipeline** | classification + tripwire + test gate + worktree + PR | On a synthetic ui-cosmetic FIND, fixer opens draft PR passing all gates. |

Each phase is committable and usable on its own (F1 = manual report-only, F2 = automatic report-only, F3 = full system).

### Open items (clarify in plan, not blocking spec)

- **Priming pack**: subagent reads `docs/FEATURES.md`, `docs/FUZZ-FINDINGS.md`, `MEMORY.md`. Sufficient, or curate a hand-written `EXPLORER-PRIMER.md` with domain cheat sheet (e.g. "this is how NIP-17 works in nostra.chat") for richer LLM context?
- **MCP playwright vs Bash**: subagent already has MCP playwright exposed in session — worth using for ad-hoc consultations (single screenshot outside main loop), or exclude to avoid confusion with dedicated driver? Inclination: exclude. One source of truth for the browser.
- **gh CLI auth**: fixer assumes `gh` authed. Add preliminary check in stage 6 with clear message if missing, instead of crashing.

### Operational cost expectations

- **Subscription tokens per typical run**: 1 explorer dispatch ~30k tokens output estimated + 1 fixer dispatch ~10k → within Pro/Max budget
- **Wall clock per run with finding**: 10-20 min (exploration) + 2-5 min (fixer) = ~15-25 min total
- **Expected first-month noise**: 30-50% raw findings will be triage-rejected (LLM false positives); second month estimated <15% after allowlist + intent refinement
- **Mergeable PR rate expected**: 40-60% on first 10 generated PRs. Runs failing test gate are *free* (automatic rollback, nothing to revert).

---

## 7. Decisions log (explicit user approvals during brainstorming)

| Decision | Choice | Q ref |
|---|---|---|
| Primary pain | B — coverage (bugs being missed) | Q1 |
| Target areas | profile-advanced, media-input, edge-messaging, network-offline | Q2 |
| Mode | A — local on-demand | Q3 |
| Stack | Path 3 — Claude Code subscription + Node Playwright driver | Q4 |
| Sub-architecture | 3b — slash command + custom subagent type | Q4 follow-up |
| Oracle stack | A + B + D | Q5 |
| Output level | D — auto-fix shallow + stop-on-first | Q6 |
| Fixer boundary | C — LLM-judged scope + safety stack (classification + regex + tests) | Q7 |
| Goal selection | A (explicit) + D (autonomous when no arg) | Q8 |
| Step granularity | C — intent + atomic fallback | Q9 |

---

## 8. Risks & mitigations summary

| Risk | Mitigation |
|---|---|
| LLM hallucinates expectations → false-positive findings | Typed schema (Oracle B), driver-side verifier (not LLM), second-pass triage subagent |
| LLM tries to fix race condition / IDB / MessagePort | Self-classification disallow list + regex tripwire + worktree isolation |
| Fix passes lint/tsc but breaks runtime | `pnpm test:nostra:quick` is in test gate (catches mirror coherence, group bridge, reaction tests) |
| Subscription rate limit hit | Single-run-at-a-time, soft cap on open PRs, idle timeout on driver |
| Worktree drift / dirty state | One worktree per FIND, manual cleanup script, `--force` on conflicts |
| FIND artifacts pile up in repo | Same pattern as `docs/fuzz-reports/` (already accepted), curate via `status=allowlisted` |
| Driver crash mid-run | `try/finally` teardown + idle timeout + `pkill` safety net |
| Auto-merged bad fix | Draft-only PRs, NEVER auto-merge, Conventional title for release-please compatibility |
| Same finding repeatedly auto-PR'd | seen-signatures.json dedup; status `fix-pr-open` blocks new PR for same signature |
| Generated invariant code injects malicious / breaks driver | `node:vm` sandbox with limited context, 5s timeout, max 5 invariants per run |
