# Bug Fuzzer Phase 1 — MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working `pnpm fuzz` command that runs a stateful property-based fuzzer for a user-specified duration, exercises messaging actions across two Playwright browser contexts against a local strfry relay, verifies cheap-tier invariants after every action, and writes de-duplicated bug findings to `docs/FUZZ-FINDINGS.md` with deterministically replayable traces.

**Architecture:** Node entry (`src/tests/fuzz/fuzz.ts`) invoked via `npx tsx`. Boots strfry via existing `LocalRelay` helper, launches 2 Chromium contexts, onboards userA+userB programmatically, then runs `fc.asyncProperty(fc.array(actionGen))` iterations. Each iteration is a fresh pair of contexts running a random command sequence; after every command, the cheap invariant tier + action postcondition runs. On violation, fast-check shrinks → reporter dedups by signature → appends to living findings file → continues.

**Tech Stack:** TypeScript (`// @ts-nocheck` following the project's E2E convention), Playwright 1.59.x (already installed), fast-check 3.x (new), proper-lockfile 4.x (new), Docker strfry (via existing `LocalRelay`), Vitest for invariant unit tests.

**Spec:** [`docs/superpowers/specs/2026-04-17-bug-fuzzer-design.md`](../specs/2026-04-17-bug-fuzzer-design.md)

**Scope (Phase 1 MVP, from spec §17):**
- Harness boot: LocalRelay + 2 contexts + onboarding
- Actions: `sendText`, `replyToRandomBubble`, `editRandomOwnBubble`, `deleteRandomOwnBubble`, `reactToRandomBubble`, `openRandomChat`, `scrollHistoryUp`, `waitForPropagation`
- Cheap-tier invariants: all 7 (`INV-console-clean`, `INV-no-dup-mid`, `INV-bubble-chronological`, `INV-delivery-ui-matches-tracker`, `INV-avatar-dom-matches-cache`, `INV-no-auto-pin`, `INV-sent-bubble-visible-after-send`)
- Action postconditions for: `sendText`, `reply`, `edit`, `delete`, `react`
- Reporter: `docs/FUZZ-FINDINGS.md` writer, dedup signature, artifacts folder
- Replay: `--replay=FIND-xxx` and `--replay-file` modes
- Smoke test: 2-minute fuzz run exits 0 and produces a non-empty report

**Out of scope (Phase 2/3):** profile/group/lifecycle actions, medium- and regression-tier invariants, UI contract manifest, parallel pairs, Tor/real backend mode, chaos actions.

---

## File Structure

| File | Role | Type |
|---|---|---|
| `package.json` | Add `fuzz` script + deps | Modify |
| `src/tests/fuzz/types.ts` | Shared types (Action, Invariant, Postcondition, FuzzContext, ReportEntry) | Create |
| `src/tests/fuzz/allowlist.ts` | Regex allowlist for benign console noise | Create |
| `src/tests/fuzz/harness.ts` | LocalRelay + 2 contexts + onboarding | Create |
| `src/tests/fuzz/cli.ts` | CLI flag parser | Create |
| `src/tests/fuzz/actions/index.ts` | Action registry, weighted generator | Create |
| `src/tests/fuzz/actions/messaging.ts` | Messaging actions + drivers | Create |
| `src/tests/fuzz/actions/navigation.ts` | openChat, scroll, wait | Create |
| `src/tests/fuzz/invariants/index.ts` | Tier runner | Create |
| `src/tests/fuzz/invariants/console.ts` | `INV-console-clean` | Create |
| `src/tests/fuzz/invariants/bubbles.ts` | `INV-no-dup-mid`, `INV-bubble-chronological`, `INV-no-auto-pin`, `INV-sent-bubble-visible-after-send` | Create |
| `src/tests/fuzz/invariants/delivery.ts` | `INV-delivery-ui-matches-tracker` | Create |
| `src/tests/fuzz/invariants/avatar.ts` | `INV-avatar-dom-matches-cache` | Create |
| `src/tests/fuzz/postconditions/index.ts` | Postcondition map + runner | Create |
| `src/tests/fuzz/postconditions/messaging.ts` | Postconditions for messaging actions | Create |
| `src/tests/fuzz/reporter.ts` | Signature, dedup, markdown writer, artifacts | Create |
| `src/tests/fuzz/replay.ts` | Replay mode loader | Create |
| `src/tests/fuzz/fuzz.ts` | Entry point, main loop | Create |
| `src/tests/fuzz/invariants/bubbles.test.ts` | Unit test for bubbles invariants | Create |
| `src/tests/fuzz/invariants/console.test.ts` | Unit test for console invariant | Create |
| `src/tests/fuzz/reporter.test.ts` | Unit test for signature + dedup | Create |
| `docs/FUZZ-FINDINGS.md` | Living findings file | Auto-created by reporter |

---

## Task 1: Install dependencies and add `pnpm fuzz` script

**Files:**
- Modify: `package.json` (add deps + script)

- [ ] **Step 1: Install fast-check and proper-lockfile**

```bash
pnpm add -D fast-check@^3.23.2 proper-lockfile@^4.1.2 @types/proper-lockfile@^4.1.4
```

Expected: pnpm-lock.yaml updated, no errors.

- [ ] **Step 2: Add `fuzz` script to package.json**

Open `package.json` and add inside the `"scripts"` block, after `"test:e2e:debug"`:

```json
    "fuzz": "tsx src/tests/fuzz/fuzz.ts"
```

Final scripts block should have the line `"fuzz": "tsx src/tests/fuzz/fuzz.ts",` (trailing comma if not last).

- [ ] **Step 3: Verify the script is callable**

Run: `pnpm fuzz --help`
Expected: the command resolves but fails because `src/tests/fuzz/fuzz.ts` doesn't exist yet. The error should be about the missing file, NOT about the script itself being missing.

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build(fuzz): add fast-check + proper-lockfile deps and pnpm fuzz script"
```

---

## Task 2: Core types

**Files:**
- Create: `src/tests/fuzz/types.ts`

- [ ] **Step 1: Create the types file**

Create `src/tests/fuzz/types.ts`:

```ts
// @ts-nocheck
import type {BrowserContext, Page} from 'playwright';
import type {LocalRelay} from '../e2e/helpers/local-relay';

export type UserId = 'userA' | 'userB';

export interface UserHandle {
  id: UserId;
  context: BrowserContext;
  page: Page;
  displayName: string;
  npub: string;
  /** peerId the OTHER user sees when talking to this user */
  remotePeerId: number;
  /** Console lines captured since harness start (ring buffer). */
  consoleLog: string[];
  /** Timestamps of reload events — used to gate INV-console-clean warmup. */
  reloadTimes: number[];
}

export interface FuzzContext {
  users: {userA: UserHandle; userB: UserHandle};
  relay: LocalRelay;
  /** Snapshots captured during the sequence so regression invariants can diff. */
  snapshots: Map<string, any>;
  /** Action index inside the current sequence — for tiered invariant pacing. */
  actionIndex: number;
}

export interface Action {
  name: string;
  args: Record<string, any>;
  /** Applied by the action module if the action cannot run (e.g. edit when no bubble exists). */
  skipped?: boolean;
  /** Metadata the action wants to pass to its own postconditions. */
  meta?: Record<string, any>;
}

export type ActionDriver = (ctx: FuzzContext, action: Action) => Promise<Action>;

export interface ActionSpec {
  name: string;
  weight: number;
  /** Fast-check arbitrary that generates `args` for this action. */
  generateArgs: () => any;
  drive: ActionDriver;
}

export type InvariantTier = 'cheap' | 'medium' | 'regression';

export interface InvariantResult {
  ok: boolean;
  /** Human-readable first assertion that failed. Undefined if ok. */
  message?: string;
  /** Optional extra data captured at the moment of failure (DOM snippet, state dump). */
  evidence?: Record<string, any>;
}

export interface Invariant {
  id: string;
  tier: InvariantTier;
  check(ctx: FuzzContext, action?: Action): Promise<InvariantResult>;
}

export interface Postcondition {
  id: string;
  check(ctx: FuzzContext, action: Action): Promise<InvariantResult>;
}

export interface FailureDetails {
  invariantId: string;
  tier: InvariantTier | 'postcondition';
  message: string;
  evidence?: Record<string, any>;
  action?: Action;
  stackTopFrame?: string;
}

export interface ReportEntry {
  signature: string;
  invariantId: string;
  tier: FailureDetails['tier'];
  assertion: string;
  occurrences: number;
  firstSeen: string;
  lastSeen: string;
  seed: number;
  minimalTrace: Action[];
  status: 'open' | 'fixed';
  fixedAt?: string;
  fixedCommit?: string;
}
```

- [ ] **Step 2: Verify TypeScript does not error on the file**

Run: `npx tsc --noEmit src/tests/fuzz/types.ts 2>&1 | head -30`
Expected: no errors specific to this file (pre-existing vendor errors are OK).

- [ ] **Step 3: Commit**

```bash
git add src/tests/fuzz/types.ts
git commit -m "feat(fuzz): shared types (FuzzContext, Action, Invariant, ReportEntry)"
```

---

## Task 3: Console allowlist

**Files:**
- Create: `src/tests/fuzz/allowlist.ts`

- [ ] **Step 1: Create the allowlist**

Create `src/tests/fuzz/allowlist.ts`:

```ts
/**
 * Known-benign console messages. Anything matching these patterns is filtered
 * out before INV-console-clean evaluates.
 *
 * Additions to this list are a policy decision — each new entry should cite
 * why the noise is benign (dev-only, informational, transient).
 *
 * Keep patterns narrow: prefer matching the specific logger prefix + a
 * substring, rather than broad wildcards. Overly-broad entries silence real
 * bugs.
 */

export const CONSOLE_ALLOWLIST: readonly RegExp[] = [
  // Vite dev server (not our code)
  /\[vite\]/i,
  /\[HMR\]/i,

  // Chromium internal warnings
  /DevTools/,

  // ServiceWorker installation logs — safe and one-shot
  /ServiceWorker registration successful/,
  /SW installed, waiting/i,

  // Nostra.chat informational loggers — NOT errors, they log in info/log channel
  /\[NostraSync\] buffer size \d+/,
  /\[NostraOnboarding\] kind 0 publish/,
  /\[ChatAPI\] subscription active/,
  /\[NostrRelay\] connected to/,

  // Playwright emits console.log of Playwright events when headed
  /pw:/
];

/**
 * Returns true if the message is in the allowlist (i.e. should be ignored).
 */
export function isAllowlisted(message: string): boolean {
  return CONSOLE_ALLOWLIST.some((re) => re.test(message));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tests/fuzz/allowlist.ts
git commit -m "feat(fuzz): console allowlist for known-benign dev noise"
```

---

## Task 4: Harness — LocalRelay + 2 contexts + onboarding

**Files:**
- Create: `src/tests/fuzz/harness.ts`

**Context for engineer:** onboarding via DOM is slow and flaky (30s per user). Instead we drive it programmatically through the same API the onboarding UI calls. `createIdentity` from `e2e-bidirectional.ts` is the canonical reference — our version skips UI for speed but follows the same sequence. Contact-add is done via `appUsersManager.injectP2PUser` + `virtualPeersDB.storeMapping`, matching the CLAUDE.md guidance.

- [ ] **Step 1: Create the harness**

Create `src/tests/fuzz/harness.ts`:

```ts
// @ts-nocheck
/**
 * Fuzzer harness — spawns LocalRelay, 2 browser contexts, onboards both users,
 * establishes mutual contact. Exposes UserHandle objects the fuzzer drives.
 *
 * Onboarding is deterministic setup, not part of the fuzzed action space.
 */

import {chromium, type Browser} from 'playwright';
import {launchOptions} from '../e2e/helpers/launch-options';
import {LocalRelay} from '../e2e/helpers/local-relay';
import {dismissOverlays} from '../e2e/helpers/dismiss-overlays';
import type {FuzzContext, UserHandle, UserId} from './types';

const APP_URL = process.env.FUZZ_APP_URL || 'http://localhost:8080';
const CONSOLE_BUFFER_MAX = 5000;

export interface HarnessOptions {
  /** How many console lines to retain per user (ring buffer). Default 5000. */
  consoleBufferMax?: number;
}

export async function bootHarness(opts: HarnessOptions = {}): Promise<{
  browser: Browser;
  relay: LocalRelay;
  ctx: FuzzContext;
  teardown: () => Promise<void>;
}> {
  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions);

  const userA = await createUser(browser, 'userA', 'Alice-Fuzz', relay.url, opts);
  const userB = await createUser(browser, 'userB', 'Bob-Fuzz', relay.url, opts);

  // Exchange pubkeys + inject contacts bidirectionally via API (skip DOM add-contact UI).
  await linkContacts(userA, userB);

  const ctx: FuzzContext = {
    users: {userA, userB},
    relay,
    snapshots: new Map(),
    actionIndex: 0
  };

  const teardown = async () => {
    await userA.context.close().catch(() => {});
    await userB.context.close().catch(() => {});
    await browser.close().catch(() => {});
    await relay.stop().catch(() => {});
  };

  return {browser, relay, ctx, teardown};
}

async function createUser(
  browser: Browser,
  id: UserId,
  displayName: string,
  relayUrl: string,
  opts: HarnessOptions
): Promise<UserHandle> {
  const context = await browser.newContext();
  await context.addInitScript((url) => {
    (window as any).__nostraTestRelays = [{url, read: true, write: true}];
  }, relayUrl);
  const page = await context.newPage();

  const consoleLog: string[] = [];
  const max = opts.consoleBufferMax ?? CONSOLE_BUFFER_MAX;
  page.on('console', (msg) => {
    consoleLog.push(`[${msg.type()}] ${msg.text()}`);
    if(consoleLog.length > max) consoleLog.shift();
  });
  page.on('pageerror', (err) => {
    consoleLog.push(`[pageerror] ${err.message}\n${err.stack || ''}`);
    if(consoleLog.length > max) consoleLog.shift();
  });

  // Standard Vite-HMR-friendly boot sequence from e2e-bug-regression.ts.
  await page.goto(APP_URL, {waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(15000);
  await dismissOverlays(page);

  await page.getByRole('button', {name: 'Create New Identity'}).waitFor({state: 'visible', timeout: 30000});
  await page.getByRole('button', {name: 'Create New Identity'}).click();
  await page.waitForTimeout(2000);

  const npub = await page.evaluate(() => {
    for(const e of document.querySelectorAll('*')) {
      if(e.children.length === 0 && e.textContent?.includes('npub1')) {
        return e.textContent.trim();
      }
    }
    return '';
  });

  await page.getByRole('button', {name: 'Continue'}).click();
  await page.waitForTimeout(2000);
  const nameInput = page.getByRole('textbox');
  if(await nameInput.isVisible()) {
    await nameInput.fill(displayName);
    await page.getByRole('button', {name: 'Get Started'}).click();
  }
  await page.waitForTimeout(8000);

  const reloadTimes: number[] = [Date.now()];
  page.on('load', () => reloadTimes.push(Date.now()));

  return {
    id,
    context,
    page,
    displayName,
    npub,
    remotePeerId: 0, // set later in linkContacts
    consoleLog,
    reloadTimes
  };
}

async function linkContacts(a: UserHandle, b: UserHandle): Promise<void> {
  // Inject B's identity into A's contact list and vice versa, bypassing the
  // add-contact DOM flow.
  const aSeesB = await injectContact(a, b);
  const bSeesA = await injectContact(b, a);
  a.remotePeerId = aSeesB;
  b.remotePeerId = bSeesA;
}

async function injectContact(self: UserHandle, other: UserHandle): Promise<number> {
  return self.page.evaluate(async ({otherNpub, otherName}) => {
    const rs = (window as any).rootScope;
    const {nip19} = await import('/@fs/' + 'nostr-tools-nip19'); // resolved by Vite
    // Fallback: use built-in util exposed on chatAPI when nip19 import path is fragile.
    const chatAPI = (window as any).__nostraChatAPI;
    const pubkeyHex = chatAPI?.npubToHex
      ? chatAPI.npubToHex(otherNpub)
      : (function decode(s: string) {
        const {data} = (window as any).nostrTools?.nip19?.decode?.(s) ?? {data: s};
        return typeof data === 'string' ? data : Buffer.from(data).toString('hex');
      })(otherNpub);

    const virtualPeersDB = (window as any).__nostraVirtualPeersDB
      || (await import('/src/lib/nostra/virtual-peers-db.ts')).virtualPeersDB;
    const peerId = await virtualPeersDB.storeMapping(pubkeyHex, null, otherName);

    const appUsersManager = rs.managers?.appUsersManager;
    if(appUsersManager?.injectP2PUser) {
      appUsersManager.injectP2PUser({peerId, pubkey: pubkeyHex, firstName: otherName});
    }
    return peerId;
  }, {otherNpub: other.npub, otherName: other.displayName});
}
```

**Known-fragile note:** the `injectContact` body uses runtime introspection — if `__nostraVirtualPeersDB` isn't exposed globally, dynamic import falls back. If both paths fail, the engineer must add `(window as any).__nostraVirtualPeersDB = virtualPeersDB;` next to the existing `__nostraChatAPI` export in `src/lib/nostra/virtual-peers-db.ts`.

- [ ] **Step 2: Verify `__nostraVirtualPeersDB` is exposed (quick scan)**

Run: `grep -n "__nostraVirtualPeersDB" src/lib/nostra/virtual-peers-db.ts 2>&1 || echo NOT_EXPOSED`
Expected: if output is `NOT_EXPOSED`, patch the module to expose the singleton (one-liner, 1 minute).

If `NOT_EXPOSED`, add to `src/lib/nostra/virtual-peers-db.ts` near the bottom (inside the `if(typeof window !== 'undefined')` block if present, else create one):

```ts
if(typeof window !== 'undefined') {
  (window as any).__nostraVirtualPeersDB = virtualPeersDB;
}
```

- [ ] **Step 3: Smoke-verify the harness boots**

This is a manual smoke at the bash level — we do a full integration smoke later in Task 19. Skip any invocation here; commit the file.

- [ ] **Step 4: Commit**

```bash
git add src/tests/fuzz/harness.ts src/lib/nostra/virtual-peers-db.ts
git commit -m "feat(fuzz): harness — LocalRelay, 2 contexts, onboarding, linkContacts"
```

---

## Task 5: CLI parser

**Files:**
- Create: `src/tests/fuzz/cli.ts`

- [ ] **Step 1: Create the CLI parser**

Create `src/tests/fuzz/cli.ts`:

```ts
// @ts-nocheck
/**
 * Minimal CLI flag parser for the fuzzer — no external dep.
 *
 * Supported flags (per spec §10):
 *   --duration=<time>      e.g. 30m, 2h, 90s (default 1h)
 *   --seed=<n>             fixed PRNG seed (default Date.now())
 *   --max-commands=<n>     max actions per iteration (default 120)
 *   --backend=<local|real> relay backend (default local) — Phase 3 flag, parsed but warn if 'real'
 *   --tor                  enable Tor (Phase 3, parsed but warn)
 *   --headed               launch visible browsers
 *   --pairs=<n>            parallel pairs (Phase 3, parsed but warn if > 1)
 *   --replay=<FIND-id>     deterministic replay of a finding
 *   --replay-file=<path>   replay arbitrary trace.json
 *   --smoke-only           run UI contract smoke pass only (Phase 3 — exit early with warn)
 *   --help, -h             print usage and exit
 */

export interface CliOptions {
  durationMs: number;
  seed: number;
  maxCommands: number;
  backend: 'local' | 'real';
  tor: boolean;
  headed: boolean;
  pairs: number;
  replay?: string;
  replayFile?: string;
  smokeOnly: boolean;
  help: boolean;
}

const DEFAULTS: CliOptions = {
  durationMs: 3600 * 1000,
  seed: Date.now(),
  maxCommands: 120,
  backend: 'local',
  tor: false,
  headed: false,
  pairs: 1,
  smokeOnly: false,
  help: false
};

export function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {...DEFAULTS};
  for(const arg of argv.slice(2)) {
    if(arg === '--help' || arg === '-h') opts.help = true;
    else if(arg === '--tor') opts.tor = true;
    else if(arg === '--headed') opts.headed = true;
    else if(arg === '--smoke-only') opts.smokeOnly = true;
    else if(arg.startsWith('--duration=')) opts.durationMs = parseDuration(arg.slice(11));
    else if(arg.startsWith('--seed=')) opts.seed = Number(arg.slice(7));
    else if(arg.startsWith('--max-commands=')) opts.maxCommands = Number(arg.slice(15));
    else if(arg.startsWith('--backend=')) opts.backend = arg.slice(10) as 'local' | 'real';
    else if(arg.startsWith('--pairs=')) opts.pairs = Number(arg.slice(8));
    else if(arg.startsWith('--replay=')) opts.replay = arg.slice(9);
    else if(arg.startsWith('--replay-file=')) opts.replayFile = arg.slice(14);
    else throw new Error(`Unknown flag: ${arg}`);
  }
  return opts;
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)(ms|s|m|h)?$/);
  if(!m) throw new Error(`Bad duration: ${s}`);
  const n = Number(m[1]);
  const unit = m[2] || 'ms';
  switch(unit) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60 * 1000;
    case 'h': return n * 3600 * 1000;
    default: throw new Error(`Unknown unit: ${unit}`);
  }
}

export const HELP_TEXT = `
pnpm fuzz [options]

  --duration=<time>      Run budget (ms, s, m, h). Default 1h.
  --seed=<n>             PRNG seed. Default Date.now().
  --max-commands=<n>     Max actions per iteration. Default 120.
  --backend=<local|real> Relay backend. Default local. (real = Phase 3)
  --tor                  Enable Tor (Phase 3).
  --headed               Visible browsers.
  --pairs=<n>            Parallel pairs (Phase 3). Default 1.
  --replay=<FIND-id>     Deterministic replay of a finding.
  --replay-file=<path>   Replay from a trace.json.
  --smoke-only           UI contract smoke only (Phase 3).
  --help, -h             Print this help.

Examples:
  pnpm fuzz
  pnpm fuzz --duration=2h --seed=42
  pnpm fuzz --replay=FIND-a7b3c9d2 --headed
`.trim();
```

- [ ] **Step 2: Commit**

```bash
git add src/tests/fuzz/cli.ts
git commit -m "feat(fuzz): CLI flag parser"
```

---

## Task 6: INV-console-clean

**Files:**
- Create: `src/tests/fuzz/invariants/console.ts`
- Create: `src/tests/fuzz/invariants/console.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `src/tests/fuzz/invariants/console.test.ts`:

```ts
import {describe, it, expect} from 'vitest';
import {consoleClean} from './console';
import type {FuzzContext, UserHandle} from '../types';

function fakeUser(consoleLog: string[], reloadTimes: number[] = [Date.now() - 60_000]): UserHandle {
  return {
    id: 'userA',
    context: null as any,
    page: null as any,
    displayName: 'A',
    npub: '',
    remotePeerId: 0,
    consoleLog,
    reloadTimes
  };
}

function ctx(aLog: string[], bLog: string[] = []): FuzzContext {
  return {
    users: {userA: fakeUser(aLog), userB: fakeUser(bLog)},
    relay: null as any,
    snapshots: new Map(),
    actionIndex: 100
  };
}

describe('INV-console-clean', () => {
  it('passes when log is clean', async () => {
    const r = await consoleClean.check(ctx([]));
    expect(r.ok).toBe(true);
  });

  it('passes when only allowlisted entries are present', async () => {
    const r = await consoleClean.check(ctx(['[log] [vite] hmr update', '[log] [ChatAPI] subscription active 4/4']));
    expect(r.ok).toBe(true);
  });

  it('fails on pageerror entry', async () => {
    const r = await consoleClean.check(ctx(['[pageerror] ReferenceError: x is not defined\n    at …']));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ReferenceError');
  });

  it('fails on console.error from our code', async () => {
    const r = await consoleClean.check(ctx(['[error] [ChatAPI] relay publish failed: 503']));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('relay publish failed');
  });

  it('skips warmup window (5s after reload)', async () => {
    const justReloaded = fakeUser(['[error] [NostraSync] unexpected EOSE'], [Date.now() - 2000]);
    const c: FuzzContext = {
      users: {userA: justReloaded, userB: fakeUser([])},
      relay: null as any,
      snapshots: new Map(),
      actionIndex: 1
    };
    const r = await consoleClean.check(c);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run src/tests/fuzz/invariants/console.test.ts`
Expected: FAIL with "Cannot find module './console'" or similar.

- [ ] **Step 3: Implement the invariant**

Create `src/tests/fuzz/invariants/console.ts`:

```ts
// @ts-nocheck
import type {Invariant, FuzzContext, UserHandle, InvariantResult} from '../types';
import {isAllowlisted} from '../allowlist';

const WARMUP_MS = 5000;

function isWithinWarmup(user: UserHandle): boolean {
  const lastReload = user.reloadTimes[user.reloadTimes.length - 1] ?? 0;
  return Date.now() - lastReload < WARMUP_MS;
}

function findBadLine(user: UserHandle): string | null {
  if(isWithinWarmup(user)) return null;
  for(const line of user.consoleLog) {
    const isError = line.startsWith('[error]') || line.startsWith('[pageerror]') || line.startsWith('[warning]');
    if(!isError) continue;
    if(isAllowlisted(line)) continue;
    return line;
  }
  return null;
}

export const consoleClean: Invariant = {
  id: 'INV-console-clean',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    const bad = findBadLine(ctx.users.userA) || findBadLine(ctx.users.userB);
    if(!bad) return {ok: true};
    return {
      ok: false,
      message: `Unallowlisted console error: ${bad.slice(0, 300)}`,
      evidence: {badLine: bad}
    };
  }
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/tests/fuzz/invariants/console.test.ts`
Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tests/fuzz/invariants/console.ts src/tests/fuzz/invariants/console.test.ts
git commit -m "feat(fuzz): INV-console-clean with warmup window + allowlist"
```

---

## Task 7: INV-no-dup-mid, INV-bubble-chronological, INV-no-auto-pin, INV-sent-bubble-visible-after-send

**Files:**
- Create: `src/tests/fuzz/invariants/bubbles.ts`
- Create: `src/tests/fuzz/invariants/bubbles.test.ts`

- [ ] **Step 1: Write failing unit tests**

Create `src/tests/fuzz/invariants/bubbles.test.ts`:

```ts
import {describe, it, expect, vi} from 'vitest';
import {noDupMid, bubbleChronological, noAutoPin} from './bubbles';
import type {FuzzContext, UserHandle} from '../types';

function userWithBubbles(bubbles: Array<{mid: string; timestamp: number; pinned?: boolean}>): UserHandle {
  return {
    id: 'userA',
    context: null as any,
    page: {
      evaluate: vi.fn(async (fn: any) => {
        // Simulate the browser-side script against the fake bubble list.
        return fn({
          bubbles: bubbles.map((b) => ({
            dataset: {mid: b.mid, timestamp: String(b.timestamp)},
            classList: b.pinned ? ['bubble', 'is-pinned'] : ['bubble']
          }))
        });
      })
    } as any,
    displayName: 'A',
    npub: '',
    remotePeerId: 0,
    consoleLog: [],
    reloadTimes: [Date.now() - 60_000]
  };
}

function ctx(user: UserHandle): FuzzContext {
  return {users: {userA: user, userB: user}, relay: null as any, snapshots: new Map(), actionIndex: 0};
}

describe('INV-no-dup-mid', () => {
  it('passes when mids are unique', async () => {
    const r = await noDupMid.check(ctx(userWithBubbles([{mid: '1', timestamp: 1}, {mid: '2', timestamp: 2}])));
    expect(r.ok).toBe(true);
  });
  it('fails when duplicate mid present', async () => {
    const r = await noDupMid.check(ctx(userWithBubbles([{mid: '1', timestamp: 1}, {mid: '1', timestamp: 2}])));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('duplicate');
  });
});

describe('INV-bubble-chronological', () => {
  it('passes on monotonic order', async () => {
    const r = await bubbleChronological.check(ctx(userWithBubbles([
      {mid: '1', timestamp: 1000},
      {mid: '2', timestamp: 2000},
      {mid: '3', timestamp: 3000}
    ])));
    expect(r.ok).toBe(true);
  });
  it('fails on out-of-order', async () => {
    const r = await bubbleChronological.check(ctx(userWithBubbles([
      {mid: '1', timestamp: 3000},
      {mid: '2', timestamp: 1000}
    ])));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('not chronological');
  });
});

describe('INV-no-auto-pin', () => {
  it('passes when no bubble is pinned', async () => {
    const r = await noAutoPin.check(ctx(userWithBubbles([{mid: '1', timestamp: 1}])));
    expect(r.ok).toBe(true);
  });
  it('fails when a bubble is pinned (no user pin action)', async () => {
    const r = await noAutoPin.check(ctx(userWithBubbles([{mid: '1', timestamp: 1, pinned: true}])));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('pinned');
  });
});
```

- [ ] **Step 2: Run the test to see it fail**

Run: `npx vitest run src/tests/fuzz/invariants/bubbles.test.ts`
Expected: FAIL with missing module.

- [ ] **Step 3: Implement the invariants**

Create `src/tests/fuzz/invariants/bubbles.ts`:

```ts
// @ts-nocheck
import type {Invariant, FuzzContext, UserHandle, InvariantResult, Action} from '../types';

/**
 * Run a DOM inspection script against both users and return the first failure.
 * `check` receives a "snapshot" object computed inside the browser so the test
 * harness can stub page.evaluate.
 */
async function forEachUser(
  ctx: FuzzContext,
  browserScript: (args: {bubbles: Array<{dataset: any; classList: string[] | DOMTokenList}>}) => InvariantResult | Promise<InvariantResult>
): Promise<InvariantResult> {
  for(const id of ['userA', 'userB'] as const) {
    const user: UserHandle = ctx.users[id];
    const result: InvariantResult = await user.page.evaluate(({script}: any) => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
      const input = {
        bubbles: bubbles.map((b) => ({
          dataset: (b as HTMLElement).dataset,
          classList: Array.from((b as HTMLElement).classList)
        }))
      };
      // eslint-disable-next-line no-new-func
      return (new Function('args', `return (${script})(args)`))(input);
    }, {script: browserScript.toString()});
    if(!result.ok) return {...result, evidence: {...(result.evidence || {}), user: id}};
  }
  return {ok: true};
}

export const noDupMid: Invariant = {
  id: 'INV-no-dup-mid',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    return forEachUser(ctx, (args) => {
      const mids = args.bubbles.map((b) => b.dataset.mid);
      const set = new Set(mids);
      if(set.size === mids.length) return {ok: true};
      const dupes = mids.filter((m, i) => mids.indexOf(m) !== i);
      return {
        ok: false,
        message: `duplicate mid(s) in DOM: ${[...new Set(dupes)].join(', ')}`,
        evidence: {totalBubbles: mids.length, uniqueMids: set.size, duplicates: [...new Set(dupes)]}
      };
    });
  }
};

export const bubbleChronological: Invariant = {
  id: 'INV-bubble-chronological',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    return forEachUser(ctx, (args) => {
      const ts = args.bubbles.map((b) => Number(b.dataset.timestamp)).filter((n) => !Number.isNaN(n));
      for(let i = 1; i < ts.length; i++) {
        if(ts[i] < ts[i - 1]) {
          return {
            ok: false,
            message: `bubbles not chronological: idx ${i - 1}=${ts[i - 1]} > idx ${i}=${ts[i]}`,
            evidence: {timestamps: ts}
          };
        }
      }
      return {ok: true};
    });
  }
};

export const noAutoPin: Invariant = {
  id: 'INV-no-auto-pin',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    return forEachUser(ctx, (args) => {
      const pinned = args.bubbles.filter((b) => (b.classList as any as string[]).includes('is-pinned'));
      if(pinned.length === 0) return {ok: true};
      return {
        ok: false,
        message: `found ${pinned.length} pinned bubble(s) without a pin action`,
        evidence: {pinnedMids: pinned.map((b) => b.dataset.mid)}
      };
    });
  }
};

export const sentBubbleVisibleAfterSend: Invariant = {
  id: 'INV-sent-bubble-visible-after-send',
  tier: 'cheap',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    if(!action || action.name !== 'sendText' || action.skipped) return {ok: true};
    const text: string = action.args.text;
    const fromId: 'userA' | 'userB' = action.args.from;
    const user = ctx.users[fromId];
    const found = await user.page.evaluate((needle: string) => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
      for(const b of bubbles) {
        const clone = b.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach((e) => e.remove());
        if((clone.textContent || '').includes(needle)) return true;
      }
      return false;
    }, text);
    if(found) return {ok: true};
    return {
      ok: false,
      message: `sent text "${text.slice(0, 30)}" not visible on sender ${fromId}`,
      evidence: {sender: fromId, text: text.slice(0, 100)}
    };
  }
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/tests/fuzz/invariants/bubbles.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tests/fuzz/invariants/bubbles.ts src/tests/fuzz/invariants/bubbles.test.ts
git commit -m "feat(fuzz): bubble-level invariants (no-dup-mid, chronological, no-auto-pin, sent-visible)"
```

---

## Task 8: INV-delivery-ui-matches-tracker

**Files:**
- Create: `src/tests/fuzz/invariants/delivery.ts`

**Context:** The bubble CSS state classes and `DeliveryTracker.states` map are both live. We read both inside `page.evaluate` and compare. Allow a 2s propagation window after the last send (measured via `action.name === 'sendText'` and `ctx.snapshots`).

- [ ] **Step 1: Create the invariant**

Create `src/tests/fuzz/invariants/delivery.ts`:

```ts
// @ts-nocheck
import type {Invariant, FuzzContext, UserHandle, InvariantResult, Action} from '../types';

const PROPAGATION_MS = 2000;

export const deliveryUiMatchesTracker: Invariant = {
  id: 'INV-delivery-ui-matches-tracker',
  tier: 'cheap',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    // Propagation window: if the last action was a send, give 2s for the tick
    // to settle before we compare.
    if(action?.name === 'sendText') {
      const sentAt = (action.meta?.sentAt as number) || 0;
      if(Date.now() - sentAt < PROPAGATION_MS) return {ok: true};
    }

    for(const id of ['userA', 'userB'] as const) {
      const res = await checkOne(ctx.users[id], id);
      if(!res.ok) return res;
    }
    return {ok: true};
  }
};

async function checkOne(user: UserHandle, id: 'userA' | 'userB'): Promise<InvariantResult> {
  const payload = await user.page.evaluate(() => {
    const tracker = (window as any).__nostraChatAPI?.deliveryTracker;
    const states: Record<string, string> = tracker?.getAllStates
      ? tracker.getAllStates()
      : (tracker?.states ? Object.fromEntries(tracker.states) : {});

    const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid].is-out, .bubbles-inner .bubble[data-mid].is-own'));
    const domStates: Array<{mid: string; cls: string}> = bubbles.map((b) => {
      const el = b as HTMLElement;
      const classes = Array.from(el.classList);
      let cls = 'unknown';
      if(classes.includes('is-read')) cls = 'read';
      else if(classes.includes('is-delivered')) cls = 'delivered';
      else if(classes.includes('is-sent')) cls = 'sent';
      else if(classes.includes('is-sending')) cls = 'sending';
      return {mid: el.dataset.mid || '', cls};
    });

    return {states, domStates};
  });

  for(const d of payload.domStates) {
    const trackerState = payload.states[d.mid];
    if(trackerState === undefined) continue; // tracker unaware — separate invariant
    // Monotonic ordering of states: sending < sent < delivered < read. DOM can
    // be at or ABOVE tracker (DOM is slow); DOM below tracker is the bug.
    const order = ['sending', 'sent', 'delivered', 'read'];
    const di = order.indexOf(d.cls);
    const ti = order.indexOf(trackerState);
    if(di === -1 || ti === -1) continue;
    if(di < ti) {
      return {
        ok: false,
        message: `bubble ${d.mid} DOM state '${d.cls}' below tracker state '${trackerState}' on ${id}`,
        evidence: {mid: d.mid, domState: d.cls, trackerState, user: id}
      };
    }
  }
  return {ok: true};
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tests/fuzz/invariants/delivery.ts
git commit -m "feat(fuzz): INV-delivery-ui-matches-tracker with 2s propagation window"
```

---

## Task 9: INV-avatar-dom-matches-cache

**Files:**
- Create: `src/tests/fuzz/invariants/avatar.ts`

**Context:** Full verification requires `uploadAvatar` action (Phase 2). The Phase 1 version asserts the always-true baseline: if there's a `.chat-info .avatar img[src]`, it matches `loadCachedProfile().picture` OR a dicebear URL. Never matches an empty string. This already catches the "avatar not shown after upload" bug once upload is added.

- [ ] **Step 1: Create the invariant**

Create `src/tests/fuzz/invariants/avatar.ts`:

```ts
// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult, UserHandle} from '../types';

export const avatarDomMatchesCache: Invariant = {
  id: 'INV-avatar-dom-matches-cache',
  tier: 'cheap',
  async check(ctx: FuzzContext): Promise<InvariantResult> {
    for(const id of ['userA', 'userB'] as const) {
      const res = await checkOne(ctx.users[id], id);
      if(!res.ok) return res;
    }
    return {ok: true};
  }
};

async function checkOne(user: UserHandle, id: 'userA' | 'userB'): Promise<InvariantResult> {
  const payload = await user.page.evaluate(() => {
    const img = document.querySelector('.sidebar-header .btn-menu-toggle .avatar img, .sidebar-header .avatar img') as HTMLImageElement | null;
    const domSrc = img?.getAttribute('src') || null;
    let cached: any = null;
    try{
      const raw = localStorage.getItem('nostra-profile-cache');
      if(raw) cached = JSON.parse(raw);
    } catch{}
    return {domSrc, cachedPicture: cached?.profile?.picture ?? null};
  });

  // No image mounted yet — benign (app still booting or no avatar widget on this route).
  if(!payload.domSrc) return {ok: true};

  // Empty string or 'null' src — bug.
  if(payload.domSrc === '' || payload.domSrc === 'null' || payload.domSrc === 'undefined') {
    return {
      ok: false,
      message: `avatar img src is empty/null on ${id}`,
      evidence: {user: id, domSrc: payload.domSrc}
    };
  }

  // If cache has a picture, DOM must match it.
  if(payload.cachedPicture && payload.domSrc !== payload.cachedPicture) {
    // Dicebear fallback is acceptable if cache has no picture.
    const isDicebear = payload.domSrc.includes('dicebear');
    if(!isDicebear) {
      return {
        ok: false,
        message: `avatar DOM src != cache picture on ${id}`,
        evidence: {user: id, domSrc: payload.domSrc, cachedPicture: payload.cachedPicture}
      };
    }
  }
  return {ok: true};
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tests/fuzz/invariants/avatar.ts
git commit -m "feat(fuzz): INV-avatar-dom-matches-cache (catches empty + mismatch)"
```

---

## Task 10: Invariant tier runner

**Files:**
- Create: `src/tests/fuzz/invariants/index.ts`

- [ ] **Step 1: Create the runner**

Create `src/tests/fuzz/invariants/index.ts`:

```ts
// @ts-nocheck
import type {Invariant, InvariantTier, FuzzContext, Action, FailureDetails} from '../types';
import {consoleClean} from './console';
import {noDupMid, bubbleChronological, noAutoPin, sentBubbleVisibleAfterSend} from './bubbles';
import {deliveryUiMatchesTracker} from './delivery';
import {avatarDomMatchesCache} from './avatar';

export const ALL_INVARIANTS: Invariant[] = [
  consoleClean,
  noDupMid,
  bubbleChronological,
  noAutoPin,
  sentBubbleVisibleAfterSend,
  deliveryUiMatchesTracker,
  avatarDomMatchesCache
];

const MEDIUM_EVERY = 10;

export async function runTier(
  tier: InvariantTier,
  ctx: FuzzContext,
  action?: Action
): Promise<FailureDetails | null> {
  if(tier === 'medium' && ctx.actionIndex % MEDIUM_EVERY !== 0) return null;

  for(const inv of ALL_INVARIANTS) {
    if(inv.tier !== tier) continue;
    const result = await inv.check(ctx, action);
    if(!result.ok) {
      return {
        invariantId: inv.id,
        tier: inv.tier,
        message: result.message || 'invariant failed',
        evidence: result.evidence,
        action
      };
    }
  }
  return null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tests/fuzz/invariants/index.ts
git commit -m "feat(fuzz): invariant tier runner"
```

---

## Task 11: Action — sendText

**Files:**
- Create: `src/tests/fuzz/actions/messaging.ts` (partial — sendText only for this task)

**Context:** `sendText` drives the chat input via DOM. Must open the target chat first, clear input (Ctrl+A + Backspace), type, press Enter. Per CLAUDE.md: "Never use `Delete` after `Control+A`".

- [ ] **Step 1: Create messaging.ts with sendText**

Create `src/tests/fuzz/actions/messaging.ts`:

```ts
// @ts-nocheck
import type {ActionSpec, Action, FuzzContext} from '../types';
import * as fc from 'fast-check';

const TEXT_ARB = fc.oneof(
  {weight: 70, arbitrary: fc.string({minLength: 1, maxLength: 120})},
  {weight: 20, arbitrary: fc.constantFrom('hi', 'hello', '👋', 'ok', 'test 123', '🔥🔥🔥', 'see you')},
  {weight: 10, arbitrary: fc.string({minLength: 1, maxLength: 500})}
);

export const sendText: ActionSpec = {
  name: 'sendText',
  weight: 40,
  generateArgs: () => fc.record({
    from: fc.constantFrom('userA', 'userB'),
    text: TEXT_ARB
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.from;
    const to: 'userA' | 'userB' = from === 'userA' ? 'userB' : 'userA';
    const sender = ctx.users[from];
    const recipient = ctx.users[to];

    // Open the chat to the recipient.
    await sender.page.evaluate((peerId: number) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(300);

    // Find the chat input. Following CLAUDE.md: no space inside selectors, no Delete after Ctrl+A.
    const input = sender.page.locator('.chat-input [contenteditable="true"]').first();
    try{
      await input.waitFor({state: 'visible', timeout: 5000});
    } catch{
      action.skipped = true;
      return action;
    }

    await input.focus();
    await sender.page.keyboard.press('Control+A');
    await sender.page.keyboard.press('Backspace');
    await sender.page.keyboard.type(action.args.text);

    const sendBtn = sender.page.locator('.chat-input button.btn-send').first();
    await sendBtn.click().catch(() => {});

    action.meta = {sentAt: Date.now(), fromId: from, toId: to, text: action.args.text};
    return action;
  }
};
```

- [ ] **Step 2: Commit**

```bash
git add src/tests/fuzz/actions/messaging.ts
git commit -m "feat(fuzz): sendText action (DOM driver)"
```

---

## Task 12: Actions — openRandomChat, scrollHistoryUp, waitForPropagation

**Files:**
- Create: `src/tests/fuzz/actions/navigation.ts`

- [ ] **Step 1: Create navigation.ts**

Create `src/tests/fuzz/actions/navigation.ts`:

```ts
// @ts-nocheck
import * as fc from 'fast-check';
import type {ActionSpec, Action, FuzzContext} from '../types';

export const openRandomChat: ActionSpec = {
  name: 'openRandomChat',
  weight: 12,
  generateArgs: () => fc.record({user: fc.constantFrom('userA', 'userB')}),
  async drive(ctx: FuzzContext, action: Action) {
    const user = ctx.users[action.args.user as 'userA' | 'userB'];
    await user.page.evaluate((peerId: number) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, user.remotePeerId);
    await user.page.waitForTimeout(200);
    return action;
  }
};

export const scrollHistoryUp: ActionSpec = {
  name: 'scrollHistoryUp',
  weight: 7,
  generateArgs: () => fc.record({user: fc.constantFrom('userA', 'userB')}),
  async drive(ctx: FuzzContext, action: Action) {
    const user = ctx.users[action.args.user as 'userA' | 'userB'];
    await user.page.evaluate(() => {
      const inner = document.querySelector('.bubbles-inner') as HTMLElement | null;
      if(inner) inner.scrollTop = 0;
    });
    await user.page.waitForTimeout(300);
    return action;
  }
};

export const waitForPropagation: ActionSpec = {
  name: 'waitForPropagation',
  weight: 5,
  generateArgs: () => fc.record({ms: fc.integer({min: 500, max: 3000})}),
  async drive(ctx: FuzzContext, action: Action) {
    await ctx.users.userA.page.waitForTimeout(action.args.ms);
    return action;
  }
};
```

- [ ] **Step 2: Commit**

```bash
git add src/tests/fuzz/actions/navigation.ts
git commit -m "feat(fuzz): navigation actions (openChat, scroll, waitForPropagation)"
```

---

## Task 13: Actions — reply, edit, delete, react

**Files:**
- Modify: `src/tests/fuzz/actions/messaging.ts` (add 4 actions)

- [ ] **Step 1: Append to messaging.ts**

Open `src/tests/fuzz/actions/messaging.ts` and append at the bottom:

```ts
async function pickRandomBubbleMid(
  ctx: FuzzContext,
  user: 'userA' | 'userB',
  ownOnly: boolean
): Promise<string | null> {
  const u = ctx.users[user];
  return u.page.evaluate((own: boolean) => {
    const selector = own
      ? '.bubbles-inner .bubble[data-mid].is-out, .bubbles-inner .bubble[data-mid].is-own'
      : '.bubbles-inner .bubble[data-mid]';
    const bubbles = Array.from(document.querySelectorAll(selector));
    if(bubbles.length === 0) return null;
    const b = bubbles[Math.floor(Math.random() * bubbles.length)] as HTMLElement;
    return b.dataset.mid || null;
  }, ownOnly);
}

export const replyToRandomBubble: ActionSpec = {
  name: 'replyToRandomBubble',
  weight: 15,
  generateArgs: () => fc.record({from: fc.constantFrom('userA', 'userB'), text: TEXT_ARB}),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.from;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(300);

    const mid = await pickRandomBubbleMid(ctx, from, false);
    if(!mid) {action.skipped = true; return action;}

    // Trigger reply via API (context menu is flaky in headless).
    const ok = await sender.page.evaluate((targetMid: string) => {
      const chat = (window as any).appImManager?.chat;
      if(!chat) return false;
      try{
        chat.input.initMessageReply?.({mid: Number(targetMid)});
        return true;
      } catch{ return false; }
    }, mid);
    if(!ok) {action.skipped = true; return action;}

    const input = sender.page.locator('.chat-input [contenteditable="true"]').first();
    await input.focus();
    await sender.page.keyboard.press('Control+A');
    await sender.page.keyboard.press('Backspace');
    await sender.page.keyboard.type(action.args.text);
    await sender.page.locator('.chat-input button.btn-send').first().click().catch(() => {});

    action.meta = {sentAt: Date.now(), replyToMid: mid, text: action.args.text, fromId: from};
    return action;
  }
};

export const editRandomOwnBubble: ActionSpec = {
  name: 'editRandomOwnBubble',
  weight: 8,
  generateArgs: () => fc.record({user: fc.constantFrom('userA', 'userB'), newText: TEXT_ARB}),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(300);

    const mid = await pickRandomBubbleMid(ctx, from, true);
    if(!mid) {action.skipped = true; return action;}

    const started = await sender.page.evaluate((targetMid: string) => {
      const chat = (window as any).appImManager?.chat;
      if(!chat?.input?.initMessageEditing) return false;
      try{
        chat.input.initMessageEditing(Number(targetMid));
        return true;
      } catch{ return false; }
    }, mid);
    if(!started) {action.skipped = true; return action;}

    const input = sender.page.locator('.chat-input [contenteditable="true"]').first();
    await input.focus();
    await sender.page.keyboard.press('Control+A');
    await sender.page.keyboard.press('Backspace');
    await sender.page.keyboard.type(action.args.newText);
    await sender.page.locator('.chat-input button.btn-send').first().click().catch(() => {});

    action.meta = {editedMid: mid, newText: action.args.newText, editedAt: Date.now()};
    return action;
  }
};

export const deleteRandomOwnBubble: ActionSpec = {
  name: 'deleteRandomOwnBubble',
  weight: 5,
  generateArgs: () => fc.record({user: fc.constantFrom('userA', 'userB')}),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(300);

    const mid = await pickRandomBubbleMid(ctx, from, true);
    if(!mid) {action.skipped = true; return action;}

    // Drive via manager — context menu + modal confirmation is too flaky.
    const done = await sender.page.evaluate(async (targetMid: string) => {
      const rs = (window as any).rootScope;
      const peerId = (window as any).appImManager?.chat?.peerId;
      if(!rs?.managers?.appMessagesManager || !peerId) return false;
      try{
        await rs.managers.appMessagesManager.deleteMessages(peerId, [Number(targetMid)], true);
        return true;
      } catch{ return false; }
    }, mid);
    if(!done) {action.skipped = true; return action;}

    action.meta = {deletedMid: mid, deletedAt: Date.now()};
    return action;
  }
};

export const reactToRandomBubble: ActionSpec = {
  name: 'reactToRandomBubble',
  weight: 8,
  generateArgs: () => fc.record({
    user: fc.constantFrom('userA', 'userB'),
    emoji: fc.constantFrom('❤️', '👍', '😂', '🔥', '🤔')
  }),
  async drive(ctx: FuzzContext, action: Action) {
    const from: 'userA' | 'userB' = action.args.user;
    const sender = ctx.users[from];
    await sender.page.evaluate((peerId: number) => {
      (window as any).appImManager?.setPeer?.({peerId});
    }, sender.remotePeerId);
    await sender.page.waitForTimeout(300);

    const mid = await pickRandomBubbleMid(ctx, from, false);
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

    action.meta = {reactedMid: mid, emoji: action.args.emoji};
    return action;
  }
};
```

- [ ] **Step 2: Commit**

```bash
git add src/tests/fuzz/actions/messaging.ts
git commit -m "feat(fuzz): reply/edit/delete/react messaging actions"
```

---

## Task 14: Action registry with weighted generator

**Files:**
- Create: `src/tests/fuzz/actions/index.ts`

- [ ] **Step 1: Create the registry**

Create `src/tests/fuzz/actions/index.ts`:

```ts
// @ts-nocheck
import * as fc from 'fast-check';
import type {ActionSpec, Action} from '../types';
import {sendText, replyToRandomBubble, editRandomOwnBubble, deleteRandomOwnBubble, reactToRandomBubble} from './messaging';
import {openRandomChat, scrollHistoryUp, waitForPropagation} from './navigation';

export const ACTION_REGISTRY: ActionSpec[] = [
  sendText,
  replyToRandomBubble,
  editRandomOwnBubble,
  deleteRandomOwnBubble,
  reactToRandomBubble,
  openRandomChat,
  scrollHistoryUp,
  waitForPropagation
];

export const ACTIONS_BY_NAME: Record<string, ActionSpec> = Object.fromEntries(
  ACTION_REGISTRY.map((a) => [a.name, a])
);

/** fast-check arbitrary that yields a single Action. */
export const actionArb: fc.Arbitrary<Action> = fc.oneof(
  ...ACTION_REGISTRY.map((spec) => ({
    weight: spec.weight,
    arbitrary: spec.generateArgs().map((args) => ({name: spec.name, args}))
  }))
);

export function findAction(name: string): ActionSpec {
  const a = ACTIONS_BY_NAME[name];
  if(!a) throw new Error(`Unknown action: ${name}`);
  return a;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tests/fuzz/actions/index.ts
git commit -m "feat(fuzz): action registry + weighted arbitrary generator"
```

---

## Task 15: Postconditions (sendText, reply, edit, delete, react)

**Files:**
- Create: `src/tests/fuzz/postconditions/messaging.ts`
- Create: `src/tests/fuzz/postconditions/index.ts`

- [ ] **Step 1: Create postconditions/messaging.ts**

Create `src/tests/fuzz/postconditions/messaging.ts`:

```ts
// @ts-nocheck
import type {Postcondition, FuzzContext, Action, InvariantResult} from '../types';

export const POST_sendText_bubble_appears: Postcondition = {
  id: 'POST-sendText-bubble-appears',
  async check(ctx, action: Action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const sender = ctx.users[action.args.from as 'userA' | 'userB'];
    const text: string = action.args.text;
    const deadline = Date.now() + 2500;
    while(Date.now() < deadline) {
      const found = await sender.page.evaluate((needle: string) => {
        const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
        for(const b of bubbles) {
          const clone = b.cloneNode(true) as HTMLElement;
          clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach((e) => e.remove());
          if((clone.textContent || '').includes(needle)) return true;
        }
        return false;
      }, text);
      if(found) return {ok: true};
      await sender.page.waitForTimeout(200);
    }
    return {ok: false, message: `sent bubble with text "${text.slice(0, 40)}" never appeared on sender`};
  }
};

export const POST_sendText_input_cleared: Postcondition = {
  id: 'POST-sendText-input-cleared',
  async check(ctx, action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const sender = ctx.users[action.args.from as 'userA' | 'userB'];
    const text = await sender.page.evaluate(() => {
      const el = document.querySelector('.chat-input [contenteditable="true"]') as HTMLElement | null;
      return (el?.textContent || '').trim();
    });
    if(text.length === 0) return {ok: true};
    return {ok: false, message: `chat input not cleared after send (still contains "${text.slice(0, 40)}")`};
  }
};

export const POST_edit_preserves_mid: Postcondition = {
  id: 'POST-edit-preserves-mid',
  async check(ctx, action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const mid = action.meta?.editedMid;
    if(!mid) return {ok: true};
    const sender = ctx.users[action.args.user as 'userA' | 'userB'];
    const stillPresent = await sender.page.evaluate((m: string) => {
      return !!document.querySelector(`.bubbles-inner .bubble[data-mid="${m}"]`);
    }, mid);
    if(stillPresent) return {ok: true};
    return {ok: false, message: `edited bubble mid=${mid} disappeared after edit`};
  }
};

export const POST_edit_content_updated: Postcondition = {
  id: 'POST-edit-content-updated',
  async check(ctx, action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const mid = action.meta?.editedMid;
    const newText = action.meta?.newText as string;
    if(!mid || !newText) return {ok: true};
    const sender = ctx.users[action.args.user as 'userA' | 'userB'];
    const deadline = Date.now() + 3000;
    while(Date.now() < deadline) {
      const ok = await sender.page.evaluate(({m, t}: any) => {
        const b = document.querySelector(`.bubbles-inner .bubble[data-mid="${m}"]`);
        if(!b) return false;
        const clone = b.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach((e) => e.remove());
        return (clone.textContent || '').includes(t);
      }, {m: mid, t: newText});
      if(ok) return {ok: true};
      await sender.page.waitForTimeout(200);
    }
    return {ok: false, message: `edited bubble mid=${mid} content not updated to "${newText.slice(0, 40)}"`};
  }
};

export const POST_delete_local_bubble_gone: Postcondition = {
  id: 'POST-delete-local-bubble-gone',
  async check(ctx, action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const mid = action.meta?.deletedMid;
    if(!mid) return {ok: true};
    const sender = ctx.users[action.args.user as 'userA' | 'userB'];
    const deadline = Date.now() + 2500;
    while(Date.now() < deadline) {
      const gone = await sender.page.evaluate((m: string) => {
        return !document.querySelector(`.bubbles-inner .bubble[data-mid="${m}"]`);
      }, mid);
      if(gone) return {ok: true};
      await sender.page.waitForTimeout(200);
    }
    return {ok: false, message: `deleted bubble mid=${mid} still present locally`};
  }
};

export const POST_react_emoji_appears: Postcondition = {
  id: 'POST-react-emoji-appears',
  async check(ctx, action): Promise<InvariantResult> {
    if(action.skipped) return {ok: true};
    const mid = action.meta?.reactedMid;
    const emoji = action.meta?.emoji as string;
    if(!mid || !emoji) return {ok: true};
    const sender = ctx.users[action.args.user as 'userA' | 'userB'];
    const deadline = Date.now() + 2500;
    while(Date.now() < deadline) {
      const ok = await sender.page.evaluate(({m, e}: any) => {
        const bubble = document.querySelector(`.bubbles-inner .bubble[data-mid="${m}"]`);
        return !!bubble && !!bubble.querySelector('.reactions') && (bubble.textContent || '').includes(e);
      }, {m: mid, e: emoji});
      if(ok) return {ok: true};
      await sender.page.waitForTimeout(200);
    }
    return {ok: false, message: `reaction ${emoji} not visible on mid=${mid}`};
  }
};
```

- [ ] **Step 2: Create postconditions/index.ts**

Create `src/tests/fuzz/postconditions/index.ts`:

```ts
// @ts-nocheck
import type {Postcondition, Action, FuzzContext, FailureDetails} from '../types';
import {
  POST_sendText_bubble_appears,
  POST_sendText_input_cleared,
  POST_edit_preserves_mid,
  POST_edit_content_updated,
  POST_delete_local_bubble_gone,
  POST_react_emoji_appears
} from './messaging';

export const POSTCONDITIONS: Record<string, Postcondition[]> = {
  sendText: [POST_sendText_bubble_appears, POST_sendText_input_cleared],
  replyToRandomBubble: [POST_sendText_bubble_appears],
  editRandomOwnBubble: [POST_edit_preserves_mid, POST_edit_content_updated],
  deleteRandomOwnBubble: [POST_delete_local_bubble_gone],
  reactToRandomBubble: [POST_react_emoji_appears]
};

export async function runPostconditions(
  ctx: FuzzContext,
  action: Action
): Promise<FailureDetails | null> {
  const list = POSTCONDITIONS[action.name] || [];
  for(const p of list) {
    const r = await p.check(ctx, action);
    if(!r.ok) {
      return {
        invariantId: p.id,
        tier: 'postcondition',
        message: r.message || 'postcondition failed',
        evidence: r.evidence,
        action
      };
    }
  }
  return null;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/tests/fuzz/postconditions/
git commit -m "feat(fuzz): action postconditions for send/reply/edit/delete/react"
```

---

## Task 16: Reporter — signature, dedup, markdown writer

**Files:**
- Create: `src/tests/fuzz/reporter.ts`
- Create: `src/tests/fuzz/reporter.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `src/tests/fuzz/reporter.test.ts`:

```ts
import {describe, it, expect} from 'vitest';
import {computeSignature, parseFindingsMarkdown, renderFindingsMarkdown} from './reporter';
import type {ReportEntry} from './types';

describe('signature', () => {
  it('is stable for same invariant + message + frame', () => {
    const a = computeSignature({invariantId: 'INV-foo', message: 'bar', stackTopFrame: 'at thing:123'});
    const b = computeSignature({invariantId: 'INV-foo', message: 'bar', stackTopFrame: 'at thing:123'});
    expect(a).toBe(b);
  });
  it('differs across invariants', () => {
    const a = computeSignature({invariantId: 'INV-foo', message: 'x'});
    const b = computeSignature({invariantId: 'INV-bar', message: 'x'});
    expect(a).not.toBe(b);
  });
  it('is 8 hex chars', () => {
    const s = computeSignature({invariantId: 'INV-a', message: 'm'});
    expect(s).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('markdown round-trip', () => {
  it('renders + parses an entry', () => {
    const entry: ReportEntry = {
      signature: 'abcd1234',
      invariantId: 'INV-delivery-ui-matches-tracker',
      tier: 'cheap',
      assertion: 'bubble is sent but tracker says delivered',
      occurrences: 42,
      firstSeen: '2026-04-17 22:30',
      lastSeen: '2026-04-17 23:15',
      seed: 1744924508331,
      minimalTrace: [{name: 'sendText', args: {from: 'userA', text: 'hi'}}],
      status: 'open'
    };
    const md = renderFindingsMarkdown([entry]);
    const parsed = parseFindingsMarkdown(md);
    expect(parsed.length).toBe(1);
    expect(parsed[0].signature).toBe('abcd1234');
    expect(parsed[0].occurrences).toBe(42);
    expect(parsed[0].invariantId).toBe('INV-delivery-ui-matches-tracker');
  });
});
```

- [ ] **Step 2: Run the test, see it fail**

Run: `npx vitest run src/tests/fuzz/reporter.test.ts`
Expected: FAIL (missing module).

- [ ] **Step 3: Implement the reporter**

Create `src/tests/fuzz/reporter.ts`:

```ts
// @ts-nocheck
import {createHash} from 'crypto';
import {readFileSync, writeFileSync, existsSync, mkdirSync} from 'fs';
import {join, dirname} from 'path';
import lockfile from 'proper-lockfile';
import type {ReportEntry, FailureDetails, Action, FuzzContext} from './types';

const FINDINGS_PATH = 'docs/FUZZ-FINDINGS.md';
const ARTIFACTS_ROOT = 'docs/fuzz-reports';

export function computeSignature(input: {invariantId: string; message: string; stackTopFrame?: string}): string {
  const h = createHash('sha256');
  h.update(input.invariantId);
  h.update('\0');
  h.update(input.message.slice(0, 200));
  h.update('\0');
  h.update(input.stackTopFrame || '');
  return h.digest('hex').slice(0, 8);
}

export function renderFindingsMarkdown(entries: ReportEntry[]): string {
  const open = entries.filter((e) => e.status === 'open').sort((a, b) => b.occurrences - a.occurrences);
  const fixed = entries.filter((e) => e.status === 'fixed');
  const nowIso = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const lines: string[] = [];
  lines.push('# Fuzz Findings');
  lines.push('');
  lines.push(`Last updated: ${nowIso}`);
  lines.push(`Open bugs: ${open.length} · Fixed: ${fixed.length}`);
  lines.push('');
  lines.push('## Open (sorted by occurrences desc)');
  lines.push('');
  for(const e of open) lines.push(...renderEntry(e));
  if(fixed.length > 0) {
    lines.push('## Fixed');
    lines.push('');
    for(const e of fixed) lines.push(...renderEntry(e));
  }
  return lines.join('\n') + '\n';
}

function renderEntry(e: ReportEntry): string[] {
  const lines: string[] = [];
  lines.push(`### FIND-${e.signature} — ${e.invariantId}`);
  lines.push(`- **Status**: ${e.status}${e.fixedCommit ? ` (commit ${e.fixedCommit})` : ''}`);
  lines.push(`- **Tier**: ${e.tier}`);
  lines.push(`- **Occurrences**: ${e.occurrences}`);
  lines.push(`- **First seen**: ${e.firstSeen}`);
  lines.push(`- **Last seen**: ${e.lastSeen}`);
  lines.push(`- **Seed**: ${e.seed}`);
  lines.push(`- **Assertion**: ${JSON.stringify(e.assertion)}`);
  lines.push(`- **Replay**: \`pnpm fuzz --replay=FIND-${e.signature}\``);
  lines.push(`- **Minimal trace** (${e.minimalTrace.length} actions):`);
  e.minimalTrace.forEach((a, i) => lines.push(`  ${i + 1}. \`${a.name}(${JSON.stringify(a.args)})\``));
  lines.push(`- **Artifacts**: [\`docs/fuzz-reports/FIND-${e.signature}/\`](../fuzz-reports/FIND-${e.signature}/)`);
  lines.push('');
  return lines;
}

const ENTRY_HEADER_RE = /^### FIND-([0-9a-f]{8}) — (.+)$/;

export function parseFindingsMarkdown(md: string): ReportEntry[] {
  const entries: ReportEntry[] = [];
  const lines = md.split('\n');
  let current: Partial<ReportEntry> | null = null;
  const traces: string[] = [];
  for(const line of lines) {
    const m = ENTRY_HEADER_RE.exec(line);
    if(m) {
      if(current && current.signature) {
        current.minimalTrace = parseTrace(traces);
        entries.push(current as ReportEntry);
      }
      current = {signature: m[1], invariantId: m[2], minimalTrace: [], status: 'open', occurrences: 0};
      traces.length = 0;
      continue;
    }
    if(!current) continue;
    if(line.startsWith('- **Status**:')) {
      current.status = line.includes('fixed') ? 'fixed' : 'open';
    } else if(line.startsWith('- **Tier**:')) {
      current.tier = line.split(':')[1].trim() as any;
    } else if(line.startsWith('- **Occurrences**:')) {
      current.occurrences = Number(line.split(':')[1].trim());
    } else if(line.startsWith('- **First seen**:')) {
      current.firstSeen = line.replace('- **First seen**:', '').trim();
    } else if(line.startsWith('- **Last seen**:')) {
      current.lastSeen = line.replace('- **Last seen**:', '').trim();
    } else if(line.startsWith('- **Seed**:')) {
      current.seed = Number(line.split(':')[1].trim());
    } else if(line.startsWith('- **Assertion**:')) {
      current.assertion = JSON.parse(line.replace('- **Assertion**:', '').trim());
    } else if(/^\s+\d+\. /.test(line)) {
      traces.push(line);
    }
  }
  if(current && current.signature) {
    current.minimalTrace = parseTrace(traces);
    entries.push(current as ReportEntry);
  }
  return entries;
}

function parseTrace(lines: string[]): Action[] {
  const out: Action[] = [];
  for(const l of lines) {
    const m = /^\s+\d+\. `([^(]+)\((.+)\)`\s*$/.exec(l);
    if(!m) continue;
    try{ out.push({name: m[1], args: JSON.parse(m[2])}); } catch{}
  }
  return out;
}

export async function recordFinding(
  f: FailureDetails,
  minimalTrace: Action[],
  seed: number,
  ctx?: FuzzContext
): Promise<{signature: string; isNew: boolean}> {
  const signature = computeSignature({
    invariantId: f.invariantId,
    message: f.message,
    stackTopFrame: f.stackTopFrame
  });
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  mkdirSync(dirname(FINDINGS_PATH), {recursive: true});
  if(!existsSync(FINDINGS_PATH)) writeFileSync(FINDINGS_PATH, '# Fuzz Findings\n\n## Open\n\n', 'utf8');

  const release = await lockfile.lock(FINDINGS_PATH, {retries: 5, stale: 10_000});
  try{
    const md = readFileSync(FINDINGS_PATH, 'utf8');
    const entries = parseFindingsMarkdown(md);
    const existing = entries.find((e) => e.signature === signature);
    let isNew = false;
    if(existing) {
      existing.occurrences += 1;
      existing.lastSeen = now;
    } else {
      isNew = true;
      entries.push({
        signature,
        invariantId: f.invariantId,
        tier: f.tier,
        assertion: f.message,
        occurrences: 1,
        firstSeen: now,
        lastSeen: now,
        seed,
        minimalTrace,
        status: 'open'
      });
    }
    writeFileSync(FINDINGS_PATH, renderFindingsMarkdown(entries), 'utf8');
    if(isNew && ctx) await writeArtifacts(signature, f, minimalTrace, seed, ctx);
    return {signature, isNew};
  } finally {
    await release();
  }
}

async function writeArtifacts(
  sig: string,
  f: FailureDetails,
  trace: Action[],
  seed: number,
  ctx: FuzzContext
): Promise<void> {
  const dir = join(ARTIFACTS_ROOT, `FIND-${sig}`);
  mkdirSync(dir, {recursive: true});
  try{
    await ctx.users.userA.page.screenshot({path: join(dir, 'screenshot-A.png'), fullPage: true});
    await ctx.users.userB.page.screenshot({path: join(dir, 'screenshot-B.png'), fullPage: true});
  } catch{}
  try{
    const domA = await ctx.users.userA.page.evaluate(() => document.documentElement.outerHTML);
    const domB = await ctx.users.userB.page.evaluate(() => document.documentElement.outerHTML);
    writeFileSync(join(dir, 'dom-A.html'), domA, 'utf8');
    writeFileSync(join(dir, 'dom-B.html'), domB, 'utf8');
  } catch{}
  writeFileSync(join(dir, 'console.log'),
    `## userA\n${ctx.users.userA.consoleLog.join('\n')}\n\n## userB\n${ctx.users.userB.consoleLog.join('\n')}`,
    'utf8'
  );
  writeFileSync(join(dir, 'trace.json'), JSON.stringify({seed, backend: 'local', commands: trace}, null, 2), 'utf8');
  writeFileSync(join(dir, 'failure.json'), JSON.stringify(f, null, 2), 'utf8');
}
```

- [ ] **Step 4: Run tests to verify**

Run: `npx vitest run src/tests/fuzz/reporter.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tests/fuzz/reporter.ts src/tests/fuzz/reporter.test.ts
git commit -m "feat(fuzz): reporter — signature, dedup, FUZZ-FINDINGS.md write, artifacts"
```

---

## Task 17: Main fuzz loop

**Files:**
- Create: `src/tests/fuzz/fuzz.ts`

- [ ] **Step 1: Create the main loop**

Create `src/tests/fuzz/fuzz.ts`:

```ts
// @ts-nocheck
import * as fc from 'fast-check';
import {parseCli, HELP_TEXT} from './cli';
import {bootHarness} from './harness';
import {actionArb, findAction} from './actions';
import {runTier} from './invariants';
import {runPostconditions} from './postconditions';
import {recordFinding} from './reporter';
import {replayFinding, replayFile} from './replay';
import type {Action, FuzzContext, FailureDetails} from './types';

/**
 * Fast-check shrinks by re-running the property with a smaller input until it
 * finds the minimal failing array. Each re-run discards its FuzzContext (fresh
 * harness) but we still need to surface the LAST failure details + the LAST
 * context for artifact capture. We stash them in module-level refs that the
 * property function updates on every failure, and the outer catch reads.
 */
let lastFailure: FailureDetails | null = null;
let lastContext: FuzzContext | null = null;

async function main() {
  const opts = parseCli(process.argv);
  if(opts.help) {console.log(HELP_TEXT); return;}

  if(opts.backend === 'real' || opts.tor || opts.pairs > 1 || opts.smokeOnly) {
    console.error('[fuzz] Phase 3 flags (--backend=real, --tor, --pairs>1, --smoke-only) are not supported in MVP.');
    process.exit(2);
  }

  if(opts.replay || opts.replayFile) {
    const trace = opts.replay
      ? await replayFinding(opts.replay)
      : await replayFile(opts.replayFile!);
    await runReplay(trace);
    return;
  }

  console.log(`[fuzz] seed=${opts.seed} duration=${opts.durationMs}ms maxCommands=${opts.maxCommands}`);
  const deadline = Date.now() + opts.durationMs;
  let iterations = 0;
  let findings = 0;

  while(Date.now() < deadline) {
    iterations++;
    const iterSeed = opts.seed + iterations;
    console.log(`[fuzz] iteration ${iterations} seed=${iterSeed}`);
    lastFailure = null;
    lastContext = null;

    let counterexample: Action[] | null = null;
    try{
      await fc.assert(
        fc.asyncProperty(
          fc.array(actionArb, {minLength: 1, maxLength: opts.maxCommands}),
          runSequence
        ),
        {seed: iterSeed, numRuns: 1, endOnFailure: false, verbose: false}
      );
    } catch(err: any) {
      counterexample = err?.counterexample?.[0] as Action[] | null;
      if(!lastFailure) {
        console.error('[fuzz] iteration errored without invariant failure:', err?.message || err);
        continue;
      }
    }

    if(lastFailure) {
      findings++;
      const minimalTrace = counterexample || [];
      const {signature, isNew} = await recordFinding(lastFailure, minimalTrace, iterSeed, lastContext || undefined);
      console.log(`[fuzz] FIND-${signature} (${lastFailure.invariantId}) ${isNew ? 'NEW' : 'dup'}`);
    }
  }

  console.log(`[fuzz] done. iterations=${iterations} findings=${findings}`);
}

/**
 * Runs ONE command sequence on a fresh harness. Throws on invariant failure to
 * trigger fast-check shrinking; stashes details in module refs first.
 */
async function runSequence(actions: Action[]): Promise<void> {
  const {ctx, teardown} = await bootHarness();
  try{
    for(let i = 0; i < actions.length; i++) {
      ctx.actionIndex = i;
      const spec = findAction(actions[i].name);
      const executed = await spec.drive(ctx, actions[i]);
      actions[i] = executed;

      const postFail = await runPostconditions(ctx, executed);
      if(postFail) {lastFailure = postFail; lastContext = ctx; throw new Error(postFail.message);}

      const cheap = await runTier('cheap', ctx, executed);
      if(cheap) {lastFailure = cheap; lastContext = ctx; throw new Error(cheap.message);}
    }
  } finally {
    // Teardown only AFTER failure details are captured — keep ctx alive for
    // artifact capture on the final (minimal) run, close at the very end.
    if(!lastFailure || lastContext !== ctx) await teardown();
  }
}

async function runReplay(trace: Action[]): Promise<void> {
  console.log(`[fuzz] REPLAY ${trace.length} actions`);
  const {ctx, teardown} = await bootHarness();
  try{
    for(let i = 0; i < trace.length; i++) {
      ctx.actionIndex = i;
      const spec = findAction(trace[i].name);
      const executed = await spec.drive(ctx, trace[i]);
      trace[i] = executed;
      const postFail = await runPostconditions(ctx, executed);
      if(postFail) {console.error('[replay] POSTCONDITION FAIL:', postFail); return;}
      const cheap = await runTier('cheap', ctx, executed);
      if(cheap) {console.error('[replay] INVARIANT FAIL:', cheap); return;}
    }
    console.log('[replay] all steps passed — bug not reproduced');
  } finally {
    await teardown();
  }
}

main().catch((err) => {
  console.error('[fuzz] fatal:', err);
  process.exit(1);
});
```

**Design note — why module-level `lastFailure`/`lastContext`:** fast-check re-runs the property function with a shrinking input, each run boots a fresh harness. We can't attach data to the thrown error because fast-check only reads `.message` and `.counterexample` off it. Module-level refs are the cleanest channel between the property function and the outer catch. They're scoped per iteration (reset at the top of the while body), so concurrent parallel iterations would break this design — which is fine because Phase 1 is single-pair (`--pairs=1` only; Phase 3 will need per-child-process refs, not shared).

**Why `teardown` is gated in the finally:** on the final (minimal) failing run, we leave `ctx` open so `recordFinding` → `writeArtifacts` can snapshot the browser pages. The outer catch calls `teardown()` implicitly through the iteration loop ending and the next iteration booting a fresh harness; strfry is idempotent about container reuse. For a clean shutdown we rely on process exit. This is acceptable for Phase 1 MVP; Phase 3 should add explicit cleanup on SIGINT.

- [ ] **Step 2: Commit (smoke will reveal bugs; fix iteratively)**

```bash
git add src/tests/fuzz/fuzz.ts
git commit -m "feat(fuzz): main loop — iteration, fc.asyncProperty, per-action invariants"
```

---

## Task 18: Replay module

**Files:**
- Create: `src/tests/fuzz/replay.ts`

- [ ] **Step 1: Create replay.ts**

Create `src/tests/fuzz/replay.ts`:

```ts
// @ts-nocheck
import {readFileSync, existsSync} from 'fs';
import {join} from 'path';
import type {Action} from './types';

const ARTIFACTS_ROOT = 'docs/fuzz-reports';

export async function replayFinding(findId: string): Promise<Action[]> {
  const cleaned = findId.startsWith('FIND-') ? findId : `FIND-${findId}`;
  const path = join(ARTIFACTS_ROOT, cleaned, 'trace.json');
  if(!existsSync(path)) {
    throw new Error(`No trace.json for ${cleaned} at ${path}`);
  }
  return replayFile(path);
}

export async function replayFile(path: string): Promise<Action[]> {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw);
  const commands = Array.isArray(parsed) ? parsed : parsed.commands;
  if(!Array.isArray(commands)) throw new Error(`Trace file does not contain a commands array: ${path}`);
  return commands;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/tests/fuzz/replay.ts
git commit -m "feat(fuzz): replay loader (replayFinding + replayFile)"
```

---

## Task 19: End-to-end smoke test

**Files:**
- None to create; this task is a manual verification that the fuzzer runs and produces output.

- [ ] **Step 1: Start the dev server in a separate terminal**

Run in terminal 1: `pnpm start`
Wait for `VITE v5.x.x ready` and `Local: http://localhost:8080/`.

- [ ] **Step 2: Run a 2-minute smoke fuzz**

Run in terminal 2: `pnpm fuzz --duration=2m --max-commands=20 --seed=1`

Expected console output roughly:
```
[fuzz] seed=1 duration=120000ms maxCommands=20
[fuzz] iteration 1 seed=2
[fuzz] iteration 2 seed=3
...
[fuzz] done. iterations=N findings=M
```

Allowed failure modes (not a bug in our code):
- Strfry container not starting — ensure Docker is running, retry.
- `Create New Identity` button not visible within 30s — Vite cold compile; retry once.
- Iteration throws inside action drive due to DOM instability — counted as finding, continues.

- [ ] **Step 3: Verify output artifacts**

Run: `cat docs/FUZZ-FINDINGS.md | head -30`
Expected: the file exists; if M > 0, it contains at least one `### FIND-<sig>` entry.

Run: `ls docs/fuzz-reports/ 2>&1 | head -5`
Expected: one subdirectory per unique finding signature (only if M > 0).

- [ ] **Step 4: If a finding was recorded, verify replay works**

Pick one signature from `docs/FUZZ-FINDINGS.md`. Run:
`pnpm fuzz --replay=FIND-<sig>`

Expected: boots harness, runs N steps from `trace.json`, either:
- "INVARIANT FAIL" (bug reproduced) or
- "all steps passed — bug not reproduced" (non-deterministic — record reproducibilityScore in future).

- [ ] **Step 5: Commit the first `docs/FUZZ-FINDINGS.md` if any findings were created**

```bash
git add docs/FUZZ-FINDINGS.md docs/fuzz-reports/
git commit -m "chore(fuzz): initial FUZZ-FINDINGS.md from smoke run"
```

If no findings were recorded (perfectly clean app — unlikely but possible), commit only the empty header:

```bash
git add docs/FUZZ-FINDINGS.md
git commit -m "chore(fuzz): initial empty FUZZ-FINDINGS.md"
```

---

## Task 20: Documentation

**Files:**
- Modify: `CLAUDE.md` (add a small Fuzzer section at end of Testing area)

- [ ] **Step 1: Open `CLAUDE.md` and locate the `### Testing P2P Code` heading**

- [ ] **Step 2: Add a new subsection after the `### E2E Testing (Playwright)` section**

Append this block:

```markdown
### Bug Fuzzer (stateful property-based)

`pnpm fuzz` runs a long-running fuzzer that generates random action sequences across 2 Playwright contexts + LocalRelay and verifies cheap-tier invariants after every action. Findings are appended (deduplicated by signature) to `docs/FUZZ-FINDINGS.md`; minimal replay traces live in `docs/fuzz-reports/FIND-<sig>/trace.json`.

- `pnpm fuzz --duration=2h` — overnight run
- `pnpm fuzz --replay=FIND-<sig>` — deterministic replay of a finding
- `pnpm fuzz --headed --slowmo=200` — watch the fuzzer in a real browser
- Spec: `docs/superpowers/specs/2026-04-17-bug-fuzzer-design.md`
- Plan: `docs/superpowers/plans/2026-04-17-bug-fuzzer-phase-1.md`

Adding an invariant = create a file in `src/tests/fuzz/invariants/`, register in `invariants/index.ts`. Adding an action = create a spec in `src/tests/fuzz/actions/`, register in `actions/index.ts`. Allowlist additions to `src/tests/fuzz/allowlist.ts` must cite why the noise is benign.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(fuzz): add fuzzer section to CLAUDE.md"
```

---

## Self-review notes

**Spec coverage:**
- Sections §4 (architecture) → Tasks 4 (harness), 17 (loop).
- §5 (file layout) → matches Task file list.
- §6 (actions — Phase 1 subset only) → Tasks 11, 12, 13, 14.
- §7 (cheap-tier invariants) → Tasks 6, 7, 8, 9, 10.
- §8 (action postconditions — Phase 1 subset) → Task 15.
- §9 (UI contract manifest) → **out of scope for Phase 1** (Phase 3, per spec §17).
- §10 (CLI) → Task 5 (parses all flags, Phase 3 flags fail fast).
- §11 (reporter / FUZZ-FINDINGS.md) → Task 16.
- §12 (replay) → Task 18.
- §13 (deps) → Task 1.
- §17 (phasing) → this is the Phase 1 plan; Phase 2 and 3 plans come after first run.

**No medium-tier or regression-tier invariants** in Phase 1 — deferred to Phase 2 per spec. The tier runner (Task 10) still recognises `medium`/`regression` as valid tiers so later phases plug in additively.

**Known Phase-1 limitations engineer should NOT try to fix:**
- No parallel pairs (`--pairs>1` rejected).
- No Tor / real backend (`--backend=real`, `--tor` rejected).
- No UI contract smoke (`--smoke-only` rejected).
- No `uploadAvatar` / group / lifecycle actions — only messaging core.
- `INV-avatar-dom-matches-cache` is present but only exercises the baseline path (empty-src / cache-match). Full exercise lands when Phase 2 adds `uploadAvatar`.

**Next plan:** after Phase 1 smoke confirms the loop works, write `2026-04-18-bug-fuzzer-phase-2.md` (profile + groups actions, medium- and regression-tier invariants, full postconditions).
