# Agentic Explorer — F2c Autonomous Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Transform the F1/F2a/F2b foundation (6 → 28 intents, Oracle A hard checks, signature dedup, typed expectation verifier, triage subagent definition) into a true autonomous explorer. The user invokes `/nostra-explore [<goal>]`; the explorer subagent reads a priming pack, decides what to explore (explicit goal A, or autonomous selection D from cold-zone bias), spawns the driver, generates ~5 LLM invariants for Oracle D, and runs an iterative reason→emit→execute→verify loop. Each step declares a typed expectation; on candidate finding the triage subagent decides REAL_BUG | UNFOUNDED. Stop on first accepted finding or budget exhaustion.

**Architecture:** F2c is mostly orchestration + 3 new modules: `scripts/explorer/areas-coverage.ts` (tracks per-area exploration counts for D goal selection), `scripts/explorer/oracles/invariants.ts` (vm sandbox runner for LLM-generated `fn` strings), and a major rewrite of `.claude/agents/nostra-explorer.md` (replaces single-intent flow with autonomous loop instructions). The slash command `.claude/commands/nostra-explore.md` is also updated to dispatch under the new semantics. No driver code changes — the driver already supports `capture` / `intent` / `atomic` / `teardown` from F1.

**Tech Stack:** TypeScript 5.7, Playwright 1.59, Vitest 0.34, Zod 3.23, `node:vm` (built-in, used for invariant sandboxing).

**Phase scope:** F2c only — autonomous loop wiring. After F2c lands the F2 phase is complete; F3 (auto-fix pipeline) is its own track.

**Verification at end of F2c:**
- `/nostra-explore "edit profile bio with very long string"` (explicit goal A) drives a multi-step exploration session, declares per-step expectations, and produces either `runs/<uuid>/` (clean) or `FIND-<id>/` (finding) artifact. Manual smoke is the user's verification.
- `/nostra-explore` (no arg, autonomous goal D) reads the priming pack and picks an area not recently explored, then runs the loop.
- A candidate finding triggers the triage subagent dispatch; the verdict (REAL_BUG/UNFOUNDED) is written into the finding artifact under `triage.json`.
- Oracle D invariants execute in a sandboxed vm (no `require`, `process`, `fs` exposure); 5 invariants per run, executed every 10 steps; violations produce findings.
- `areas-coverage.json` is updated at the end of every run (run kind, finding kind both count).
- No regression on F2a/F2b unit tests; ≥30 unit tests still pass.

---

## Recap: foundation already shipped (F1 + F2a + F2b)

```
.claude/
├── agents/
│   ├── nostra-explorer.md           # F1 single-intent flow — F2c REWRITES
│   └── nostra-explorer-triage.md    # F2a definition — F2c WIRES INTO LOOP
└── commands/
    └── nostra-explore.md            # F1 slash command — F2c UPDATES

scripts/explorer/
├── driver.ts                        # F1 — F2c does NOT modify
├── ipc.ts, types.ts                 # F1
├── intents/                         # F2b: 28 intents across 7 areas
├── oracles/
│   ├── hard.ts                      # F1 Oracle A
│   └── expectations.ts              # F2a Oracle B verifier
├── reporter.ts                      # F2a (kind=finding|run|error)
├── replay.ts                        # F1
├── selector-resolver.ts             # F1
├── signature.ts                     # F2a (dedup)
└── socket-client.ts                 # F2a (sendOnce)

docs/explorer-reports/
├── README.md                        # F1
├── seen-signatures.json             # populated by F2a recordSighting
└── runs/<uuid>/, FIND-<id>/, errors/<uuid>/   # F2a artifacts
```

## File structure (F2c)

### New files

```
scripts/explorer/
├── areas-coverage.ts                # tracks per-area exploration counts (for goal D)
└── oracles/
    └── invariants.ts                # Oracle D — vm sandbox runner for LLM-generated invariants

src/tests/explorer/
├── areas-coverage.test.ts           # tracker round-trips + cold-zone bias query
└── invariants.test.ts               # vm sandbox isolation + execution timeout
```

### Modified files

```
.claude/agents/nostra-explorer.md    # FULL REWRITE — autonomous loop
.claude/commands/nostra-explore.md   # update for F2c semantics (no-arg = D mode)
docs/explorer-reports/areas-coverage.json   # initial empty {} — written at first run
```

---

## Phase F2c: Autonomous Loop

### Task 1: Areas coverage tracker

**Why:** The autonomous goal-D mode picks the area with the lowest recent exploration count. We need a small persistent store that the explorer subagent reads at run start (to bias goal selection) and writes at run end (to update counts).

**Files:**
- Create: `scripts/explorer/areas-coverage.ts`
- Create: `src/tests/explorer/areas-coverage.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tests/explorer/areas-coverage.test.ts`:

```typescript
import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {loadCoverage, recordRun, pickColdZone, type CoverageStore} from '../../../scripts/explorer/areas-coverage';

describe('areas coverage tracker', () => {
  let tmpRoot: string;
  let storePath: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exp-coverage-'));
    storePath = join(tmpRoot, 'areas-coverage.json');
  });

  afterEach(() => {
    rmSync(tmpRoot, {recursive: true, force: true});
  });

  it('loadCoverage returns {} when the file does not exist', async() => {
    const c = await loadCoverage(storePath);
    expect(c).toEqual({});
  });

  it('recordRun creates the store on first call', async() => {
    await recordRun(storePath, 'messaging', '2026-04-30T10:00:00Z');
    const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as CoverageStore;
    expect(parsed.messaging).toMatchObject({runs: 1, last_run: '2026-04-30T10:00:00Z'});
  });

  it('recordRun bumps count for repeat areas', async() => {
    await recordRun(storePath, 'profile', 't0');
    await recordRun(storePath, 'profile', 't1');
    await recordRun(storePath, 'media', 't2');
    const c = await loadCoverage(storePath);
    expect(c.profile.runs).toBe(2);
    expect(c.media.runs).toBe(1);
    expect(c.profile.last_run).toBe('t1');
  });

  it('pickColdZone returns an area not in the store when one is missing', async() => {
    await recordRun(storePath, 'messaging', 't0');
    await recordRun(storePath, 'navigation', 't1');
    const cold = await pickColdZone(storePath, ['messaging', 'navigation', 'profile', 'media', 'edge', 'network', 'settings']);
    // Should pick a never-explored area first
    expect(['profile', 'media', 'edge', 'network', 'settings']).toContain(cold);
  });

  it('pickColdZone returns the area with the lowest count when all are in the store', async() => {
    await recordRun(storePath, 'messaging', 't0');
    await recordRun(storePath, 'messaging', 't1');
    await recordRun(storePath, 'profile', 't2');
    const cold = await pickColdZone(storePath, ['messaging', 'profile']);
    expect(cold).toBe('profile');
  });
});
```

- [ ] **Step 2: Run test to verify it FAILS** — module not found.

- [ ] **Step 3: Implement `scripts/explorer/areas-coverage.ts`**

```typescript
import {existsSync, readFileSync, writeFileSync} from 'node:fs';

export interface CoverageEntry {
  runs: number;
  last_run: string;
  findings: number;
}

export type CoverageStore = Record<string, CoverageEntry>;

export async function loadCoverage(storePath: string): Promise<CoverageStore> {
  if(!existsSync(storePath)) return {};
  const raw = readFileSync(storePath, 'utf8');
  if(!raw.trim()) return {};
  return JSON.parse(raw) as CoverageStore;
}

export async function recordRun(
  storePath: string,
  area: string,
  timestamp: string,
  finding: boolean = false
): Promise<void> {
  const store = await loadCoverage(storePath);
  const entry = store[area] ?? {runs: 0, last_run: '', findings: 0};
  entry.runs += 1;
  entry.last_run = timestamp;
  if(finding) entry.findings += 1;
  store[area] = entry;
  writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
}

/**
 * Pick the cold-zone area: returns an area from `candidates` that has the
 * lowest run count (zero if it's never been recorded). Ties broken alphabetically.
 */
export async function pickColdZone(storePath: string, candidates: string[]): Promise<string> {
  if(candidates.length === 0) throw new Error('pickColdZone: candidates list is empty');
  const store = await loadCoverage(storePath);
  let best = candidates[0];
  let bestRuns = store[best]?.runs ?? 0;
  for(const c of candidates.slice(1)) {
    const runs = store[c]?.runs ?? 0;
    if(runs < bestRuns || (runs === bestRuns && c < best)) {
      best = c;
      bestRuns = runs;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run test to verify it PASSES** — 5/5.

- [ ] **Step 5: Lint clean**

```bash
cd /home/raider/Repository/nostra.chat-wt/explorer-f2a
npx eslint scripts/explorer/areas-coverage.ts src/tests/explorer/areas-coverage.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add scripts/explorer/areas-coverage.ts src/tests/explorer/areas-coverage.test.ts
git commit -m "$(cat <<'EOF'
feat(explorer): areas coverage tracker for goal-D autonomous selection

Persistent store at docs/explorer-reports/areas-coverage.json. The
autonomous goal-D mode reads it at run start to bias toward
cold zones (areas with fewest recent runs). recordRun is called
at the end of every run.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Oracle D — vm sandbox invariant runner

**Why:** F2c lets the explorer subagent generate up to 5 invariant `fn` bodies per run (as TypeScript-ish strings) that are evaluated in a sandboxed vm context every 10 steps. The sandbox must NOT expose `require`, `process`, `fs`, etc. — only the page handles via `ctx.pageA`/`ctx.pageB` and a `relay` reference.

**Files:**
- Create: `scripts/explorer/oracles/invariants.ts`
- Create: `src/tests/explorer/invariants.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/tests/explorer/invariants.test.ts`:

```typescript
import {describe, expect, it, beforeAll, afterAll} from 'vitest';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright';
import {compileInvariant, runInvariant, type SandboxContext} from '../../../scripts/explorer/oracles/invariants';

let browser: Browser;
let ctxA: BrowserContext;
let ctxB: BrowserContext;
let pageA: Page;
let pageB: Page;

beforeAll(async() => {
  browser = await chromium.launch({headless: true});
  ctxA = await browser.newContext();
  ctxB = await browser.newContext();
  pageA = await ctxA.newPage();
  pageB = await ctxB.newPage();
}, 30_000);

afterAll(async() => {
  await ctxA.close();
  await ctxB.close();
  await browser.close();
});

describe('Oracle D — invariant vm sandbox', () => {
  it('compileInvariant accepts a syntactically valid fn body', () => {
    const inv = compileInvariant({
      name: 'INV-test',
      description: 'Always true',
      fnBody: 'return {ok: true};'
    });
    expect(inv.name).toBe('INV-test');
  });

  it('runInvariant executes a true invariant against live pages', async() => {
    await pageA.setContent('<div class="bubble">a</div><div class="bubble">b</div>');
    const inv = compileInvariant({
      name: 'INV-bubble-count-pos',
      description: 'pageA has at least 1 bubble',
      fnBody: `
        const c = await ctx.pageA.locator('.bubble').count();
        return {ok: c >= 1, value: {bubbles: c}};
      `
    });
    const ctx: SandboxContext = {pageA, pageB};
    const result = await runInvariant(inv, ctx, 5000);
    expect(result.ok).toBe(true);
  });

  it('runInvariant detects a false invariant', async() => {
    await pageA.setContent('<div>nothing</div>');
    const inv = compileInvariant({
      name: 'INV-bubble-count-fail',
      description: 'pageA always has bubbles',
      fnBody: `
        const c = await ctx.pageA.locator('.bubble').count();
        return {ok: c > 0};
      `
    });
    const result = await runInvariant(inv, {pageA, pageB}, 5000);
    expect(result.ok).toBe(false);
  });

  it('compileInvariant rejects body containing require/import/process', () => {
    expect(() => compileInvariant({
      name: 'INV-bad',
      description: 'malicious',
      fnBody: 'const fs = require("fs"); return {ok: true};'
    })).toThrow(/banned/i);

    expect(() => compileInvariant({
      name: 'INV-bad2',
      description: 'malicious',
      fnBody: 'process.exit(1); return {ok: true};'
    })).toThrow(/banned/i);
  });

  it('runInvariant times out and reports ok=false', async() => {
    const inv = compileInvariant({
      name: 'INV-slow',
      description: 'never resolves',
      fnBody: 'await new Promise(r => setTimeout(r, 10_000)); return {ok: true};'
    });
    const result = await runInvariant(inv, {pageA, pageB}, 200);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/timeout/i);
  });
});
```

- [ ] **Step 2: Run test to verify it FAILS** — module not found.

- [ ] **Step 3: Implement `scripts/explorer/oracles/invariants.ts`**

```typescript
import * as vm from 'node:vm';
import type {Page} from 'playwright';

export interface InvariantSpec {
  name: string;
  description: string;
  fnBody: string;  // TypeScript-ish body, evaluated as `async function(ctx) { <fnBody> }`
}

export interface CompiledInvariant {
  name: string;
  description: string;
  fn: (ctx: SandboxContext) => Promise<InvariantResult>;
}

export interface SandboxContext {
  pageA: Page;
  pageB: Page;
}

export interface InvariantResult {
  ok: boolean;
  value?: unknown;
  message?: string;
}

const BANNED_PATTERNS: RegExp[] = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bprocess\b/,
  /\bglobal\b/,
  /\bglobalThis\b/,
  /\bnode:/,
  /\bfs\b/,
  /\bchild_process\b/,
  /\bnet\b/,
  /\bhttp\b/,
  /\beval\s*\(/,
  /\bFunction\s*\(/
];

export function compileInvariant(spec: InvariantSpec): CompiledInvariant {
  for(const re of BANNED_PATTERNS) {
    if(re.test(spec.fnBody)) {
      throw new Error(`Invariant ${spec.name}: body contains banned pattern ${re.source}`);
    }
  }
  // Compile the fnBody as `async function(ctx) { <body> }` inside a sandbox.
  // We use vm.Script + runInNewContext for each invocation to isolate state.
  const wrapped = `(async function(ctx) {\n${spec.fnBody}\n})`;
  const script = new vm.Script(wrapped, {filename: `invariant-${spec.name}.js`});
  return {
    name: spec.name,
    description: spec.description,
    fn: async(ctx: SandboxContext) => {
      // Run the wrapped function in a new sandbox each call.
      // Pass ONLY ctx (which holds pageA/pageB) — no other globals leak in.
      const sandbox: Record<string, unknown> = {ctx};
      const fn = script.runInNewContext(sandbox, {timeout: 1000}) as (c: SandboxContext) => Promise<InvariantResult>;
      return await fn(ctx);
    }
  };
}

export async function runInvariant(
  inv: CompiledInvariant,
  ctx: SandboxContext,
  timeoutMs: number
): Promise<InvariantResult> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<InvariantResult>((resolve) => {
    timer = setTimeout(() => resolve({ok: false, message: `invariant ${inv.name} timeout after ${timeoutMs}ms`}), timeoutMs);
  });
  try {
    const result = await Promise.race([
      inv.fn(ctx),
      timeoutPromise
    ]);
    return result;
  } catch(err: any) {
    return {ok: false, message: `invariant ${inv.name} threw: ${err?.message ?? String(err)}`};
  } finally {
    if(timer) clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test to verify it PASSES** — 5/5.

- [ ] **Step 5: Lint clean**

```bash
npx eslint scripts/explorer/oracles/invariants.ts src/tests/explorer/invariants.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add scripts/explorer/oracles/invariants.ts src/tests/explorer/invariants.test.ts
git commit -m "$(cat <<'EOF'
feat(explorer): Oracle D — vm sandbox invariant runner

LLM-generated invariant fn bodies (max 5 per run) are compiled in a
node:vm sandbox with banned-pattern check (require, import, process,
fs, child_process, net, http, eval, Function — all rejected) and
executed against live page handles. Timeout per invocation prevents
runaway invariants. F2c subagent will generate ~5 invariants at run
start and execute them every 10 loop steps.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Rewrite the explorer subagent definition for autonomous loop

**Why:** The F1 subagent is hardcoded ("if goal=='send a message' then run send_text_message"). F2c replaces it with full LLM reasoning over the 28-intent catalog. The subagent prompt becomes a loop instruction.

**Files:**
- Modify: `.claude/agents/nostra-explorer.md` (FULL REWRITE)

This is a definition file (markdown frontmatter + instructions), not code. The implementer just rewrites it.

- [ ] **Step 1: Replace `.claude/agents/nostra-explorer.md`** with this content:

```markdown
---
name: nostra-explorer
description: Autonomous agentic explorer for nostra.chat. Reads priming pack, decides what to explore (explicit goal A from $ARGUMENTS or autonomous goal D from cold-zone bias), spawns the Playwright driver, generates Oracle D invariants, runs an iterative reason→intent→verify loop with stop-on-first-finding semantics. Dispatches the triage subagent on candidate findings.
tools: Bash, Read, Write, Glob, Grep
---

You are the **nostra-explorer subagent** — F2c autonomous mode. Your job is to run a single exploration session that surfaces (or doesn't) one new bug in nostra.chat.

# Inputs you receive in the prompt

The orchestrator passes you:
- `$GOAL` — either the user's explicit goal (string), or the literal `<autonomous>` if the user invoked `/nostra-explore` with no args.
- `$BUDGET_MS` — wall-clock budget for the run (default 1800000 = 30 min).
- `$BUDGET_STEPS` — max loop iterations (default 120).

# Step 0 — Read the priming pack

Read in this order; do not skip:
1. `docs/superpowers/specs/2026-04-29-agentic-explorer-design.md` (full design — sections 1-8 are load-bearing)
2. `docs/FEATURES.md` (what nostra.chat does — for reasoning about plausible expectations)
3. `docs/explorer-reports/seen-signatures.json` (cross-run dedup state)
4. `docs/explorer-reports/areas-coverage.json` (per-area exploration counts)
5. `docs/explorer-reports/allowlist.ts` (additional benign patterns to ignore)

# Step 1 — Decide goal

If `$GOAL` is a non-empty string and not `<autonomous>`: that's your goal verbatim, e.g. "edit profile bio with very long string". From the goal, pick one or two most-relevant areas from {messaging, navigation, profile, edge, network, settings, media}.

If `$GOAL == <autonomous>`: read `areas-coverage.json` and use `pickColdZone` semantics — pick the area with the fewest runs (ties broken alphabetically). Then synthesize a sub-goal in that area from your knowledge of nostra.chat's features. Example: cold area = `media`, synthesize `"paste a small image into the chat input and verify the upload completes"`.

Bias rule: if you've explored the same area in the last 3 runs (check `areas-coverage.json` last_run timestamps within the last hour), switch to a different cold area. This prevents repetitive runs.

# Step 2 — Spawn the driver

```bash
SOCKET=/tmp/exp-$(date +%s%N).sock
pnpm explorer:driver --socket=$SOCKET
```

Run this in background (`run_in_background: true`). Watch the log for `[driver] listening` (~30-60s for harness boot). If the driver does not READY within 90 seconds, write an `errors/<uuid>/` artifact via `pnpm exec tsx -e "..."` (kind=error, errorReason="driver did not READY in 90s", errorStderr=captured driver log) and exit cleanly.

# Step 3 — Generate Oracle D invariants

Generate up to 5 invariant fn bodies that should hold throughout the session. Examples (you tailor to the goal):

- `INV-bilateral-message-count`: `const a = await ctx.pageA.locator('.bubble.is-out').count(); const b = await ctx.pageB.locator('.bubble.is-in').count(); return {ok: a === b};`
- `INV-no-error-toasts`: `const t = await ctx.pageA.locator('.toast-error, .notification-error').count(); return {ok: t === 0};`

Send them to the driver as a special `intent` call with `intentName: '__internal_register_invariants'` (NOTE: the driver does NOT have this intent in F1/F2a/F2b — for F2c, you call `compileInvariant` + `runInvariant` directly via inline `pnpm exec tsx -e ...` shell-outs, since the driver IPC protocol doesn't yet host invariants). For each invariant, store the compiled handle in your subagent state (a JSON file at `/tmp/exp-${SOCKET#/tmp/exp-}/invariants.json` containing the spec strings — recompiled at each periodic check).

Banned patterns are enforced by `compileInvariant` itself; if your body contains `require`/`process`/etc. it will throw and you'll skip that invariant.

# Step 4 — Loop

Variables:
- `step = 0`
- `start = Date.now()`
- `trace = []`

Loop while `step < $BUDGET_STEPS && (Date.now() - start) < $BUDGET_MS`:

  4.1. Increment `step`.

  4.2. **Capture observation**:
  ```bash
  pnpm exec tsx scripts/explorer/socket-client.ts $SOCKET '{"id":"step-N","cmd":"capture"}'
  ```
  Parse the response: `{data: {A: {url, screenshotPath, consoleTail}, B: {...}}}`.

  4.3. **Reason about next action**: given the goal, the trace so far, and the observation, decide ONE of:
  - **Catalog intent + expectation**: `{intent: <name from registry>, params: {...}, expectation: {...typed Expectation...}}`. Pick a concrete intent from the 28 in the registry. Pick params consistent with `paramsSchema`. Declare a typed expectation BEFORE executing — the verifier will resolve it after.
  - **Atomic actions + expectation** (only if no catalog intent fits): `{atomic_actions: [{type:"click",...}], expectation: {...}}`.

  4.4. **Execute**:
  ```bash
  pnpm exec tsx scripts/explorer/socket-client.ts $SOCKET '{"id":"step-N","cmd":"intent","intentName":"<name>","params":{...}}'
  ```
  Or for atomic: `{"cmd":"atomic","actions":[...]}`. Note: F1 driver returns "not implemented in F1 yet" for atomic — for F2c, prefer catalog intents whenever possible.

  4.5. **Verify expectation**: call the F2a verifier inline:
  ```bash
  pnpm exec tsx -e "import('./scripts/explorer/oracles/expectations.ts').then(m => m.verifyExpectation(<exp>, <pages>).then(r => console.log(JSON.stringify(r))))"
  ```
  (NOTE: the verifier needs Playwright Page handles, which live inside the driver process — for F2c MVP you call it via a special driver command. If the driver doesn't expose this command, fall back to inferring expectation outcome from the next `capture` snapshot. Document this gap in your finding artifact if it arises.)

  4.6. **Append step** to `trace`: `{step, intent, params, atomic_trace, expectation, observation_summary}`. Persist `trace` to `/tmp/exp-${SOCKET#/tmp/exp-}/trace.jsonl` (append-only).

  4.7. **Oracle A check** (driver returned this in `data.hard_findings`): if non-empty → CANDIDATE finding (Oracle A is deterministic, NO triage needed).

  4.8. **Oracle D periodic check** (every 10 steps): for each compiled invariant, run `runInvariant(inv, {pageA, pageB}, 5000)`. If any returns `{ok: false}` → CANDIDATE finding (Oracle D is deterministic, NO triage needed).

  4.9. **Oracle B candidate**: if the typed expectation verifier returned `{ok: false}` → this is a candidate that NEEDS TRIAGE. Dispatch the `nostra-explorer-triage` subagent with: goal, trace so far, failed expectation, observation. Wait for its JSON verdict. If `verdict == REAL_BUG` → CANDIDATE accepted. If `verdict == UNFOUNDED` → log to `docs/explorer-reports/triage-rejected.jsonl` and continue the loop (do NOT break). If `verdict == RETRY_WITH_WIDER_TIMEOUT` → re-emit the same expectation with 3× timeout and re-verify once.

  4.10. **STOP-ON-FIRST**: any accepted candidate (from Oracle A, D, or B-after-triage) → BREAK loop. Continue to step 5.

# Step 5 — Write artifact

If a finding fired (any oracle, any step):
```bash
pnpm exec tsx -e "
import('./scripts/explorer/reporter.ts').then(m => m.writeReport({
  reportRoot: 'docs/explorer-reports',
  kind: 'finding',
  goal: '<goal>',
  trace: <trace>,
  finding: <hard_finding_or_synthesized>,
  screenshots: [...]
}))"
```

The reporter will compute the signature and call `recordSighting` automatically. Check the returned dir path: it ends with `FIND-<8hex>`.

If no finding (loop completed budget exhausted): kind=run, finding=null. The reporter writes to `runs/<uuid>/`.

If the driver crashed mid-loop: kind=error, errorReason + errorStderr.

# Step 6 — Update areas-coverage and teardown

```bash
pnpm exec tsx -e "
import('./scripts/explorer/areas-coverage.ts').then(m => m.recordRun(
  'docs/explorer-reports/areas-coverage.json', '<area>', new Date().toISOString(), <foundFinding>
))"
```

Send teardown:
```bash
pnpm exec tsx scripts/explorer/socket-client.ts $SOCKET '{"id":"teardown","cmd":"teardown"}'
```

# Step 7 — Final summary

Emit to stdout, exactly:
```
RESULT: /nostra-explore "<goal>"

Verdict: CLEAN|FINDING|ERROR|REGRESSION

Artifact: <dir-path>
- report.md, trace.jsonl, screenshots/, signature.txt (if FINDING)

Steps: <N>
Triage rejected: <count>
Oracle D invariants violated: <list of names or none>

Replay: pnpm explorer:replay <FIND-id|run-uuid>
```

# Constraints

- You CANNOT Edit files under `src/` — your tools are Bash, Read, Write, Glob, Grep ONLY.
- Stay within the budget. If you hit `$BUDGET_STEPS` or `$BUDGET_MS`, finish the loop and write the artifact (kind=run if no finding).
- If the triage subagent verdict is UNFOUNDED, the loop continues — do NOT count UNFOUNDED candidates as findings.
- ALWAYS write to `docs/explorer-reports/` only. Never write to `src/`.
- `seen-signatures.json` is updated by the reporter on findings; do NOT manually edit it.
- If a candidate signature already has `status=fixed` in `seen-signatures.json`, the reporter flags it as REGRESSION — surface this loudly in the final summary.

# Anti-patterns

- Do NOT skip Step 0. The priming pack is what grounds your reasoning in the actual codebase.
- Do NOT generate invariants that have nothing to do with the goal area — they waste time and fire spurious findings.
- Do NOT take more than 60 seconds reasoning between steps. If you're stuck, emit `{intent: "open_settings", params: {page: "userA"}}` as a "back to safe ground" move and continue.
- Do NOT auto-fix anything. F3 is the auto-fix phase; F2c is detection only.
```

- [ ] **Step 2: Verify the file is well-formed**

```bash
cd /home/raider/Repository/nostra.chat-wt/explorer-f2a
head -10 .claude/agents/nostra-explorer.md
wc -l .claude/agents/nostra-explorer.md
```

Expected: opening `---`, frontmatter with `name: nostra-explorer`, `tools: Bash, Read, Write, Glob, Grep`, closing `---`. Body length ~200-250 lines.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/nostra-explorer.md
git commit -m "$(cat <<'EOF'
feat(explorer): rewrite explorer subagent for F2c autonomous loop

Replaces the F1 single-intent flow with full autonomous reasoning:
- Reads priming pack (spec, FEATURES, seen-signatures, areas-coverage, allowlist)
- Decides goal (explicit A from \$ARGUMENTS or autonomous D via pickColdZone)
- Spawns driver via socket-client
- Generates up to 5 Oracle D invariants
- Runs reason→intent→verify loop with per-step typed expectations
- Dispatches triage subagent on candidate findings
- Stop-on-first-finding (after triage acceptance)
- Updates areas-coverage at end

F2c entry point. F1 single-intent semantics are gone — but the slash
command is updated separately (Task 4).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Update slash command for F2c semantics

**Files:**
- Modify: `.claude/commands/nostra-explore.md`

The F1/F2a slash command instructs the orchestrator to dispatch the F1 single-intent subagent with a hardcoded goal mapping. F2c removes the hardcoded mapping; the orchestrator just passes `$ARGUMENTS` (or `<autonomous>` if empty) to the new subagent.

- [ ] **Step 1: Replace `.claude/commands/nostra-explore.md`** with this content:

```markdown
---
description: Run the autonomous agentic explorer for nostra.chat (F2c)
---

You're the orchestrator for `/nostra-explore`. The user invoked it with `$ARGUMENTS`.

**F2c behavior** (autonomous loop):

1. Compute `$GOAL`:
   - If `$ARGUMENTS` is non-empty: `$GOAL = $ARGUMENTS` (explicit goal A mode)
   - Else: `$GOAL = "<autonomous>"` (autonomous goal D mode)
2. Verify dev server is running: `curl -sI http://localhost:8080 | head -1`. If not 200, instruct user to run `pnpm start` first. Do NOT suggest `pnpm preview` — preview's SPA fallback breaks the harness's dynamic TS imports.
3. Dispatch the `nostra-explorer` subagent (custom subagent at `.claude/agents/nostra-explorer.md`) via the Agent tool with prompt:
   ```
   $GOAL=<computed goal>
   $BUDGET_MS=1800000
   $BUDGET_STEPS=120
   ```
   The subagent's frontmatter + body contain all instructions; just pass these inputs.
4. Relay the subagent's `RESULT:` summary to the user verbatim.
5. If the subagent reports `Verdict: REGRESSION`, alert the user prominently — a previously-fixed signature has re-emerged.
6. If the subagent reports `Verdict: FINDING`, suggest replay: `pnpm explorer:replay <FIND-id>`.

**F2c capabilities** (vs F1):
- Single-intent flow → autonomous reason→act→verify loop
- Hardcoded goal mapping → free-form goal interpretation + autonomous mode
- Oracle A only → A + B (typed expectations) + D (LLM invariants in vm sandbox)
- No triage → second-pass triage on candidate Oracle B findings
- No cross-run dedup → seen-signatures.json + REGRESSION detection
- No coverage tracking → areas-coverage.json drives autonomous goal selection

**Out of scope (F3+)**:
- Auto-fix pipeline
- gh CLI / draft PR creation
- Network/Tor scenarios beyond Playwright `setOffline`

See `docs/superpowers/specs/2026-04-29-agentic-explorer-design.md` for the full design.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/commands/nostra-explore.md
git commit -m "$(cat <<'EOF'
feat(explorer): update slash command for F2c autonomous semantics

Drops the F1 hardcoded goal mapping. The orchestrator now passes
\$ARGUMENTS (or "<autonomous>") to the rewritten F2c subagent
which handles all reasoning in its own prompt.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: F2c milestone — verify cumulative state, smoke (user-driven), commit

- [ ] **Step 1: Run all explorer unit tests**

```bash
cd /home/raider/Repository/nostra.chat-wt/explorer-f2a
pnpm exec vitest run \
  src/tests/explorer/ipc.test.ts \
  src/tests/explorer/intents.test.ts \
  src/tests/explorer/selector-resolver.test.ts \
  src/tests/explorer/oracle-hard.test.ts \
  src/tests/explorer/reporter.test.ts \
  src/tests/explorer/replay.test.ts \
  src/tests/explorer/socket-client.test.ts \
  src/tests/explorer/signature.test.ts \
  src/tests/explorer/reporter-error.test.ts \
  src/tests/explorer/expectations.test.ts \
  src/tests/explorer/areas-coverage.test.ts \
  src/tests/explorer/invariants.test.ts \
  > /tmp/f2c-final.log 2>&1
grep -E '"numTotalTests":|"numPassedTests":|"numFailedTests":|"success":' /tmp/f2c-final.log | head -5
```

Expected: `success: true`, total ≥40 (28 from F1+F2a + 5 areas-coverage + 5 invariants + 2 from existing intents.test.ts updated assertion).

- [ ] **Step 2: Lint clean**

```bash
npx eslint scripts/explorer/areas-coverage.ts scripts/explorer/oracles/invariants.ts \
  src/tests/explorer/areas-coverage.test.ts src/tests/explorer/invariants.test.ts
```

Expected: 0 errors.

- [ ] **Step 3: Manual smoke (user-driven, NOT in the implementer subagent)**

The user runs `pnpm start` in another terminal, then invokes:
- `/nostra-explore "edit profile bio with a very long string"` (explicit goal A)
- `/nostra-explore` (autonomous goal D)

Each should produce one of:
- `runs/<uuid>/` (clean run, budget exhausted, no finding)
- `FIND-<id>/` (finding accepted, with `signature.txt` + `triage.json` if Oracle B+triage path)
- `errors/<uuid>/` (driver failed to boot or crashed)

The user verifies the reports and confirms F2c works. This is NOT verified by the implementer subagent.

- [ ] **Step 4: Optional milestone empty commit**

```bash
git commit --allow-empty -m "$(cat <<'EOF'
feat(explorer): F2c milestone — autonomous loop complete

F2c delivers:
- areas-coverage tracker (goal-D cold-zone bias)
- Oracle D vm sandbox invariant runner with banned-pattern check
- Full rewrite of nostra-explorer subagent for autonomous reason→act→verify loop
- Slash command updated for F2c semantics (explicit A | autonomous D)
- Triage subagent dispatch wired into Oracle B candidate path
- Stop-on-first-finding semantics across A/B/D oracles

Cumulative explorer unit tests pass (≥40). Manual smoke is the user's
verification step — F2c involves driver subprocess runs which require
the dev server.

F2 phase is complete (F2a foundation + F2b catalog + F2c autonomous).
F3 (auto-fix pipeline) is the next track.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

The empty milestone commit is OPTIONAL — skip if you prefer a clean log.

---

## Out of scope for F2c (explicit)

- Auto-fix pipeline (entire F3): self-classification, regex tripwire, test gates, draft PR creation
- gh CLI authentication checks
- Worktree isolation for fixer
- Tor / multi-relay simulation beyond Playwright `setOffline`/route blocking
- Multi-pair parallel exploration (>1 context pair)
- Triage subagent calibration / training (F2c uses the F2a definition as-is)
- Per-step screenshot diffing (visual regression) — F3+
- Automatic intent catalog promotion (F2c finding artifacts contain manual proposal docs but PRs are human-driven)

These are tracked at the spec §6 list and would each be separate plans if/when they're prioritized.
