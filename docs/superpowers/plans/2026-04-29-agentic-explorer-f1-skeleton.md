# Agentic Explorer — F1 Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the F1 skeleton of the agentic explorer: a Node Playwright driver subprocess controllable via Unix-socket JSON protocol that can boot two browser contexts (reusing fuzz `bootHarness`), execute 5 catalog intents, capture observations, run Oracle A (hard automatic checks), write FIND-* artifacts, and replay traces deterministically. The slash command `/nostra-explore` and an explorer subagent dispatch one intent and produce a trace.jsonl + report.

**Architecture:** TypeScript Node subprocess (`scripts/explorer/driver.ts`) launched by an explorer subagent (defined in `.claude/agents/nostra-explorer.md`) via Bash. IPC over Unix domain socket using line-delimited JSON. The driver imports `bootHarness` from `src/tests/fuzz/harness.ts` (no duplication). Intents are TypeScript modules in `scripts/explorer/intents/` that wrap fuzz `ActionSpec.drive()` where possible. Oracle A reuses the fuzz `CONSOLE_ALLOWLIST`. F1 is intentionally minimal: no expectation oracle (B), no invariants (D), no triage, no auto-fix, no signature dedup — those land in F2/F3.

**Tech Stack:** TypeScript 5.7, Playwright 1.59, tsx 4.19, Vitest 0.34, Zod (new dep, schema validation for intent params and IPC messages), `node:net` (Unix socket), `node:vm` (placeholder, used in F2 for invariants).

**Phase scope:** F1 only — skeleton. F2 (full explorer) and F3 (fixer pipeline) are separate plans written after F1 ships.

**Verification at end of F1:** Manual run `/nostra-explore "send a message"` produces `docs/explorer-reports/FIND-*/trace.jsonl` (or `docs/explorer-reports/runs/<run-id>/trace.jsonl` if no finding). `pnpm explorer:replay <run-id>` re-executes the trace deterministically without LLM. `pnpm test:explorer` passes.

---

## File Structure

### New files

```
.claude/
├── commands/
│   └── nostra-explore.md          # slash command entry, parses args, dispatches subagent
└── agents/
    └── nostra-explorer.md         # explorer subagent definition (Bash, Read, Write, Glob)

scripts/
└── explorer/
    ├── driver.ts                  # entry: long-running Node, opens 2 ctx, JSON socket server
    ├── ipc.ts                     # protocol types, JSON line framing, socket helpers
    ├── types.ts                   # shared types (Observation, RunState, etc.)
    ├── intents/
    │   ├── types.ts               # IntentDef, IntentResult, AtomicAction
    │   ├── registry.ts            # exports the catalog (5 intents in F1)
    │   ├── messaging.ts           # send_text_message, react_to_message
    │   ├── navigation.ts          # open_settings, open_chat_with, scroll_history_back
    │   └── profile.ts             # edit_profile_field
    ├── oracles/
    │   └── hard.ts                # Oracle A: console_error, unhandled, network 5xx, white_screen
    ├── reporter.ts                # write FIND-*/run-* artifact directories
    ├── replay.ts                  # entry: re-run trace.jsonl pure-Playwright
    └── selector-resolver.ts       # selector_hint → robust selector (used by intents)

docs/
└── explorer-reports/
    └── README.md                  # how to read FIND-*, run replay, customize allowlist

src/tests/
└── explorer/
    ├── ipc.test.ts                # JSON line framing round-trip
    ├── intents.test.ts            # intent registry: each entry has valid Zod schema
    ├── oracle-hard.test.ts        # console error allowlist behavior
    ├── reporter.test.ts           # FIND artifact written with correct shape
    ├── replay.test.ts             # known trace replays end-to-end (driver round-trip)
    └── selector-resolver.test.ts  # fallback chain order
```

### Modified files

```
package.json                       # add zod dep + 4 new scripts (explorer:driver, replay, etc.)
.gitignore                         # add /tmp/exp-*/ pattern (volatile run state)
docs/explorer-reports/.gitkeep     # ensure directory tracked
```

---

## Phase F1: Skeleton

### Task 1: Project skeleton — directories, dependencies, package.json scripts

**Files:**
- Create: `scripts/explorer/.gitkeep`
- Create: `docs/explorer-reports/.gitkeep`
- Create: `docs/explorer-reports/README.md`
- Create: `src/tests/explorer/.gitkeep`
- Modify: `package.json` (add zod, add scripts)
- Modify: `.gitignore` (add `/tmp/exp-*/` — actually local-only, skip; instead add `docs/explorer-reports/runs/` for volatile run state that's not a finding)

- [ ] **Step 1: Create directory structure**

```bash
mkdir -p scripts/explorer/intents scripts/explorer/oracles
mkdir -p docs/explorer-reports
mkdir -p src/tests/explorer
touch scripts/explorer/.gitkeep
touch docs/explorer-reports/.gitkeep
touch src/tests/explorer/.gitkeep
```

- [ ] **Step 2: Install zod dependency**

Run: `pnpm add -D zod@^3.23.8`

Verify: `grep -E '"zod"' package.json` outputs the dep line.

- [ ] **Step 3: Add explorer scripts to package.json**

In `package.json` `scripts` section (after the existing `fuzz` scripts), add:

```json
    "explorer:driver": "tsx scripts/explorer/driver.ts",
    "explorer:replay": "tsx scripts/explorer/replay.ts",
    "test:explorer": "vitest run src/tests/explorer/"
```

- [ ] **Step 4: Write the README for explorer-reports**

Create `docs/explorer-reports/README.md`:

```markdown
# Explorer Reports

This directory contains artifacts produced by the agentic explorer
(`/nostra-explore` slash command). See
`docs/superpowers/specs/2026-04-29-agentic-explorer-design.md` for the design.

## Layout

- `FIND-<8hex>/` — finding artifacts (one per unique signature)
  - `report.md` — human-readable summary
  - `trace.jsonl` — sequence of intents/atomic actions for replay
  - `screenshots/` — pageA + pageB at finding moment
  - `console.log` — captured console output
  - `signature.txt` — finding signature for cross-run dedup
- `runs/<run-id>/` — successful runs without findings (volatile, gitignored)
- `seen-signatures.json` — cross-run signature dedup state (F2)
- `allowlist.ts` — explorer-specific noise patterns (F2, augments fuzz allowlist)

## Replay

Re-run any finding's trace deterministically without LLM:

\`\`\`bash
pnpm explorer:replay FIND-abc12345
\`\`\`

Replay only re-executes the saved atomic Playwright actions. It does NOT
re-call the LLM. The trace.jsonl is the source of truth.
```

- [ ] **Step 5: Add gitignore entry for run state**

Append to `.gitignore`:

```
# Explorer volatile run state (non-finding runs)
docs/explorer-reports/runs/
```

- [ ] **Step 6: Verify build still works**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS (no new files yet, just deps + scripts; should be no-op for lint/tsc).

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml .gitignore scripts/explorer/.gitkeep \
        docs/explorer-reports/.gitkeep docs/explorer-reports/README.md \
        src/tests/explorer/.gitkeep
git commit -m "feat(explorer): scaffold directories, deps, and scripts for F1"
```

---

### Task 2: IPC types and JSON line protocol

**Files:**
- Create: `scripts/explorer/ipc.ts`
- Create: `scripts/explorer/types.ts`
- Test: `src/tests/explorer/ipc.test.ts`

The driver and the explorer subagent communicate over a Unix domain socket using line-delimited JSON. Each line is a complete JSON message. We define request/response types using Zod schemas so the driver can validate incoming commands and produce typed responses.

- [ ] **Step 1: Write the failing test**

Create `src/tests/explorer/ipc.test.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {encodeMessage, decodeMessages, RequestSchema} from '../../../scripts/explorer/ipc';

describe('ipc framing', () => {
  it('encodes a request as a JSON line ending in \\n', () => {
    const line = encodeMessage({id: '1', cmd: 'capture'});
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line.trim())).toEqual({id: '1', cmd: 'capture'});
  });

  it('decodes multiple framed messages from a buffer', () => {
    const buf = encodeMessage({id: '1', cmd: 'capture'}) +
                encodeMessage({id: '2', cmd: 'teardown'});
    const {messages, remainder} = decodeMessages(buf);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({id: '1', cmd: 'capture'});
    expect(messages[1]).toEqual({id: '2', cmd: 'teardown'});
    expect(remainder).toBe('');
  });

  it('keeps a partial trailing message in the remainder buffer', () => {
    const buf = encodeMessage({id: '1', cmd: 'capture'}) + '{"id":"2","cmd":';
    const {messages, remainder} = decodeMessages(buf);
    expect(messages).toHaveLength(1);
    expect(remainder).toBe('{"id":"2","cmd":');
  });

  it('parses a capture request with the Zod schema', () => {
    const parsed = RequestSchema.safeParse({id: '1', cmd: 'capture'});
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown cmd', () => {
    const parsed = RequestSchema.safeParse({id: '1', cmd: 'wat'});
    expect(parsed.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/tests/explorer/ipc.test.ts`
Expected: FAIL with "Cannot find module .../scripts/explorer/ipc".

- [ ] **Step 3: Write the implementation**

Create `scripts/explorer/types.ts`:

```typescript
export type PageId = 'A' | 'B';

export type AtomicAction =
  | {type: 'click'; page: PageId; selector: string}
  | {type: 'fill'; page: PageId; selector: string; value: string}
  | {type: 'press'; page: PageId; key: string}
  | {type: 'navigate'; page: PageId; url: string}
  | {type: 'wait'; ms: number}
  | {type: 'evaluate'; page: PageId; script: string};

export interface Observation {
  page: PageId;
  screenshotPath?: string;
  consoleTail: string[];
  url: string;
  capturedAt: number;
}
```

Create `scripts/explorer/ipc.ts`:

```typescript
import {z} from 'zod';

export const PageIdSchema = z.enum(['A', 'B']);

export const AtomicActionSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('click'), page: PageIdSchema, selector: z.string()}),
  z.object({type: z.literal('fill'), page: PageIdSchema, selector: z.string(), value: z.string()}),
  z.object({type: z.literal('press'), page: PageIdSchema, key: z.string()}),
  z.object({type: z.literal('navigate'), page: PageIdSchema, url: z.string()}),
  z.object({type: z.literal('wait'), ms: z.number().int().nonnegative()}),
  z.object({type: z.literal('evaluate'), page: PageIdSchema, script: z.string()})
]);

export const RequestSchema = z.discriminatedUnion('cmd', [
  z.object({id: z.string(), cmd: z.literal('capture')}),
  z.object({
    id: z.string(),
    cmd: z.literal('intent'),
    intentName: z.string(),
    params: z.record(z.unknown())
  }),
  z.object({
    id: z.string(),
    cmd: z.literal('atomic'),
    actions: z.array(AtomicActionSchema)
  }),
  z.object({id: z.string(), cmd: z.literal('teardown')})
]);

export type Request = z.infer<typeof RequestSchema>;

export const ResponseSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional()
});

export type Response = z.infer<typeof ResponseSchema>;

export function encodeMessage(msg: object): string {
  return JSON.stringify(msg) + '\n';
}

export function decodeMessages(buffer: string): {messages: unknown[]; remainder: string} {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  const messages = lines
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));
  return {messages, remainder};
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/tests/explorer/ipc.test.ts`
Expected: PASS, 5/5.

- [ ] **Step 5: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/explorer/ipc.ts scripts/explorer/types.ts src/tests/explorer/ipc.test.ts
git commit -m "feat(explorer): add IPC types and JSON line framing"
```

---

### Task 3: Driver bootstrap with Unix socket + READY signal

**Files:**
- Create: `scripts/explorer/driver.ts`
- Test: manual smoke (no automated test in F1; a real test would require booting Playwright which is heavyweight; we verify by hand)

The driver is a long-running Node process. It accepts a `--socket=<path>` flag, opens a Unix domain socket server, calls `bootHarness()` from the fuzz, and writes `READY` to stdout once both browser contexts are up. Then it accepts JSON line requests on the socket. F1 implements only the `teardown` command; `capture` and `intent` come in subsequent tasks.

- [ ] **Step 1: Write the driver bootstrap**

Create `scripts/explorer/driver.ts`:

```typescript
import {createServer, type Socket} from 'node:net';
import {unlinkSync, existsSync} from 'node:fs';
import {bootHarness, type FuzzContext} from '../../src/tests/fuzz/harness';
import {decodeMessages, encodeMessage, RequestSchema, type Request, type Response} from './ipc';

interface DriverState {
  ctx: FuzzContext;
  teardown: () => Promise<void>;
}

async function main() {
  const socketArg = process.argv.find((a) => a.startsWith('--socket='));
  if(!socketArg) {
    console.error('[driver] --socket=<path> is required');
    process.exit(2);
  }
  const socketPath = socketArg.slice('--socket='.length);
  if(existsSync(socketPath)) {
    try{unlinkSync(socketPath);} catch{}
  }

  const harness = await bootHarness({headed: false});
  const state: DriverState = {ctx: harness.ctx, teardown: harness.teardown};
  console.log('[driver] READY');

  const server = createServer((socket: Socket) => handleClient(socket, state));
  server.listen(socketPath, () => {
    console.log(`[driver] listening on ${socketPath}`);
  });

  // Idle timeout: shut down if no client connects within 10 minutes.
  const idleTimer = setTimeout(async () => {
    console.error('[driver] idle timeout, shutting down');
    await state.teardown();
    server.close();
    process.exit(0);
  }, 10 * 60 * 1000);
  server.once('connection', () => clearTimeout(idleTimer));
}

async function handleClient(socket: Socket, state: DriverState) {
  let buffer = '';
  socket.on('data', async (chunk) => {
    buffer += chunk.toString('utf8');
    const {messages, remainder} = decodeMessages(buffer);
    buffer = remainder;
    for(const raw of messages) {
      const parsed = RequestSchema.safeParse(raw);
      if(!parsed.success) {
        socket.write(encodeMessage(<Response>{
          id: (raw as any)?.id ?? 'unknown',
          ok: false,
          error: `invalid request: ${parsed.error.message}`
        }));
        continue;
      }
      const response = await dispatch(parsed.data, state);
      socket.write(encodeMessage(response));
    }
  });
  socket.on('error', (err) => console.error('[driver] socket error:', err.message));
}

async function dispatch(req: Request, state: DriverState): Promise<Response> {
  switch(req.cmd) {
    case 'teardown':
      await state.teardown();
      setTimeout(() => process.exit(0), 50);
      return {id: req.id, ok: true};
    case 'capture':
    case 'intent':
    case 'atomic':
      return {id: req.id, ok: false, error: `cmd ${req.cmd} not implemented in F1 yet`};
  }
}

main().catch((err) => {
  console.error('[driver] fatal:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Manual smoke — start the driver and tear it down**

Run in one terminal:
```bash
pnpm start &
sleep 5  # wait for dev server
pnpm explorer:driver --socket=/tmp/exp-test.sock
```

Expected: log lines `[harness] boot:`, `[harness] boot done`, `[driver] READY`, `[driver] listening on /tmp/exp-test.sock`.

In another terminal:
```bash
echo '{"id":"1","cmd":"teardown"}' | nc -U /tmp/exp-test.sock
```

Expected: response `{"id":"1","ok":true}`, driver exits.

- [ ] **Step 3: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/explorer/driver.ts
git commit -m "feat(explorer): driver bootstrap with Unix socket and teardown"
```

---

### Task 4: Driver `capture` command (screenshot, console tail, URL)

**Files:**
- Modify: `scripts/explorer/driver.ts` (add capture handler)
- Test: `src/tests/explorer/capture.test.ts` (driver round-trip via subprocess)

`capture` snapshots both pages: takes a screenshot to disk, returns the recent console tail (last 50 lines) and the current URL. Network and ax-tree captures land in F2.

- [ ] **Step 1: Write the failing test**

Create `src/tests/explorer/capture.test.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {decodeMessages, encodeMessage} from '../../../scripts/explorer/ipc';
import {randomUUID} from 'node:crypto';

const SOCKET = `/tmp/exp-test-${randomUUID().slice(0, 8)}.sock`;

describe('driver capture', () => {
  it('returns observations for both pages', async () => {
    const driver = spawn('pnpm', ['explorer:driver', `--socket=${SOCKET}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Wait for READY on stdout.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('driver did not READY in 90s')), 90_000);
      driver.stdout!.on('data', (b) => {
        if(b.toString('utf8').includes('[driver] listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    const sock = createConnection(SOCKET);
    let buf = '';
    const responses: any[] = [];
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const {messages, remainder} = decodeMessages(buf);
      buf = remainder;
      responses.push(...messages);
    });

    sock.write(encodeMessage({id: '1', cmd: 'capture'}));
    await new Promise((r) => setTimeout(r, 3000));

    expect(responses[0]).toMatchObject({id: '1', ok: true});
    expect(responses[0].data).toHaveProperty('A');
    expect(responses[0].data).toHaveProperty('B');
    expect(responses[0].data.A).toHaveProperty('url');
    expect(responses[0].data.A).toHaveProperty('screenshotPath');
    expect(responses[0].data.A).toHaveProperty('consoleTail');

    sock.write(encodeMessage({id: '2', cmd: 'teardown'}));
    await new Promise((r) => setTimeout(r, 1000));
    sock.end();
  }, 120_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/tests/explorer/capture.test.ts`
Expected: FAIL with `cmd capture not implemented in F1 yet` in response.error.

- [ ] **Step 3: Implement capture**

In `scripts/explorer/driver.ts`, replace the `case 'capture':` arm in `dispatch()` and add a helper:

```typescript
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';

async function captureObservations(state: DriverState): Promise<Record<'A'|'B', any>> {
  const out: Record<'A'|'B', any> = {} as any;
  const dir = `/tmp/exp-capture-${process.pid}-${Date.now()}`;
  mkdirSync(dir, {recursive: true});
  for(const userId of ['userA', 'userB'] as const) {
    const u = state.ctx.users[userId];
    const pageId = userId === 'userA' ? 'A' : 'B';
    const screenshotPath = join(dir, `${pageId}.png`);
    await u.page.screenshot({path: screenshotPath, fullPage: false}).catch(() => {});
    out[pageId] = {
      page: pageId,
      url: u.page.url(),
      screenshotPath,
      consoleTail: u.consoleLog.slice(-50),
      capturedAt: Date.now()
    };
  }
  return out;
}
```

Update the `dispatch` function:

```typescript
async function dispatch(req: Request, state: DriverState): Promise<Response> {
  switch(req.cmd) {
    case 'capture': {
      const data = await captureObservations(state);
      return {id: req.id, ok: true, data};
    }
    case 'teardown':
      await state.teardown();
      setTimeout(() => process.exit(0), 50);
      return {id: req.id, ok: true};
    case 'intent':
    case 'atomic':
      return {id: req.id, ok: false, error: `cmd ${req.cmd} not implemented in F1 yet`};
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/tests/explorer/capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/explorer/driver.ts src/tests/explorer/capture.test.ts
git commit -m "feat(explorer): driver capture command with screenshots and console tail"
```

---

### Task 5: Intent registry types and selector resolver

**Files:**
- Create: `scripts/explorer/intents/types.ts`
- Create: `scripts/explorer/intents/registry.ts`
- Create: `scripts/explorer/selector-resolver.ts`
- Test: `src/tests/explorer/intents.test.ts`
- Test: `src/tests/explorer/selector-resolver.test.ts`

The registry holds every IntentDef. `selector-resolver.ts` implements the `selector_hint → robust selector` fallback chain documented in the spec §4: data-testid → ARIA role + name → visible text → aria-label → CSS class. We implement it as a function that returns a Playwright `Locator` and resolves the first matching strategy.

- [ ] **Step 1: Write the failing test for intent types and registry**

Create `src/tests/explorer/intents.test.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {z} from 'zod';
import {registry} from '../../../scripts/explorer/intents/registry';

describe('intent registry', () => {
  it('exposes a non-empty catalog', () => {
    expect(Object.keys(registry).length).toBeGreaterThan(0);
  });

  it('every intent has name, area, paramsSchema, description, exec', () => {
    for(const [name, def] of Object.entries(registry)) {
      expect(def.name).toBe(name);
      expect(def.area).toMatch(/^(messaging|profile|media|navigation|settings|network|edge)$/);
      expect(def.paramsSchema).toBeInstanceOf(z.ZodType);
      expect(typeof def.description).toBe('string');
      expect(def.description.length).toBeGreaterThan(10);
      expect(typeof def.exec).toBe('function');
    }
  });
});
```

- [ ] **Step 2: Write the failing test for selector resolver**

Create `src/tests/explorer/selector-resolver.test.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {buildSelectorCandidates} from '../../../scripts/explorer/selector-resolver';

describe('buildSelectorCandidates', () => {
  it('emits candidates in priority order: data-testid, role+name, text, aria-label, class', () => {
    const cands = buildSelectorCandidates('settings panel');
    expect(cands.length).toBeGreaterThanOrEqual(3);
    // First strategy should be data-testid lookup
    expect(cands[0].kind).toBe('testid');
    // Subsequent strategies should include role and text
    const kinds = cands.map((c) => c.kind);
    expect(kinds).toContain('role');
    expect(kinds).toContain('text');
    expect(kinds).toContain('aria');
    expect(kinds).toContain('class');
  });

  it('handles empty hint by returning empty candidate list', () => {
    expect(buildSelectorCandidates('')).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm exec vitest run src/tests/explorer/intents.test.ts src/tests/explorer/selector-resolver.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement intent types**

Create `scripts/explorer/intents/types.ts`:

```typescript
import type {z} from 'zod';
import type {FuzzContext} from '../../../src/tests/fuzz/types';
import type {AtomicAction, Observation} from '../types';

export type IntentArea =
  | 'messaging' | 'profile' | 'media' | 'navigation'
  | 'settings' | 'network' | 'edge';

export interface IntentResult {
  ok: boolean;
  atomic_trace: AtomicAction[];
  observations: Observation[];
  error?: string;
}

export interface IntentDef<P = Record<string, unknown>> {
  name: string;
  area: IntentArea;
  paramsSchema: z.ZodType<P>;
  description: string;
  exec: (params: P, ctx: FuzzContext) => Promise<IntentResult>;
}
```

Create `scripts/explorer/intents/registry.ts`:

```typescript
import type {IntentDef} from './types';
import {messagingIntents} from './messaging';
import {navigationIntents} from './navigation';
import {profileIntents} from './profile';

export const registry: Record<string, IntentDef<any>> = {
  ...messagingIntents,
  ...navigationIntents,
  ...profileIntents
};
```

(Tasks 6, 7, 8 will create the per-area files. For now, we stub them.)

Create stub `scripts/explorer/intents/messaging.ts`:

```typescript
import type {IntentDef} from './types';
export const messagingIntents: Record<string, IntentDef<any>> = {};
```

Create stub `scripts/explorer/intents/navigation.ts`:

```typescript
import type {IntentDef} from './types';
export const navigationIntents: Record<string, IntentDef<any>> = {};
```

Create stub `scripts/explorer/intents/profile.ts`:

```typescript
import type {IntentDef} from './types';
export const profileIntents: Record<string, IntentDef<any>> = {};
```

Note: the `intents.test.ts` "non-empty catalog" assertion will still fail until tasks 6-8 land. We accept that and let those tasks unblock it. To avoid red-CI in the meantime, change the assertion in step 1 to `>= 0` (we'll tighten it once the catalog has content).

Actually: REPLACE the assertion in `src/tests/explorer/intents.test.ts` step 1 with:

```typescript
  it('returns an object (catalog grows in subsequent tasks)', () => {
    expect(typeof registry).toBe('object');
  });
```

The "every intent has fields" assertion stays — it iterates an empty object harmlessly until tasks 6-8 populate it.

- [ ] **Step 5: Implement selector resolver**

Create `scripts/explorer/selector-resolver.ts`:

```typescript
import type {Page, Locator} from 'playwright';

export type SelectorCandidate =
  | {kind: 'testid'; value: string}
  | {kind: 'role'; role: string; name: string}
  | {kind: 'text'; value: string}
  | {kind: 'aria'; value: string}
  | {kind: 'class'; value: string};

/**
 * Build candidate selectors from a free-text hint, in priority order:
 * 1. data-testid exact
 * 2. ARIA role + accessible name
 * 3. visible text contains
 * 4. aria-label exact
 * 5. CSS class match
 *
 * Returns [] for empty hint.
 */
export function buildSelectorCandidates(hint: string): SelectorCandidate[] {
  if(!hint || hint.trim().length === 0) return [];
  const trimmed = hint.trim();
  // Heuristic: if hint contains "button"/"link"/"input", emit role candidate.
  const roleMatch = /\b(button|link|textbox|input|menuitem|tab|checkbox)\b/i.exec(trimmed);
  const candidates: SelectorCandidate[] = [
    {kind: 'testid', value: trimmed}
  ];
  if(roleMatch) {
    const role = roleMatch[1].toLowerCase().replace('input', 'textbox');
    const name = trimmed.replace(roleMatch[0], '').trim();
    if(name) candidates.push({kind: 'role', role, name});
  } else {
    candidates.push({kind: 'role', role: 'generic', name: trimmed});
  }
  candidates.push({kind: 'text', value: trimmed});
  candidates.push({kind: 'aria', value: trimmed});
  candidates.push({kind: 'class', value: trimmed});
  return candidates;
}

/**
 * Given a page and a hint, return the first Locator that matches the priority
 * chain. Returns null if nothing resolves.
 */
export async function resolveSelector(page: Page, hint: string): Promise<Locator | null> {
  const candidates = buildSelectorCandidates(hint);
  for(const c of candidates) {
    let loc: Locator;
    switch(c.kind) {
      case 'testid':
        loc = page.locator(`[data-testid="${cssEscape(c.value)}"]`).first();
        break;
      case 'role':
        loc = page.getByRole(c.role as any, {name: c.name}).first();
        break;
      case 'text':
        loc = page.getByText(c.value, {exact: false}).first();
        break;
      case 'aria':
        loc = page.locator(`[aria-label="${cssEscape(c.value)}"]`).first();
        break;
      case 'class':
        loc = page.locator(`.${cssEscape(c.value).replace(/ /g, '.')}`).first();
        break;
    }
    const count = await loc.count().catch(() => 0);
    if(count > 0) return loc;
  }
  return null;
}

function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run src/tests/explorer/intents.test.ts src/tests/explorer/selector-resolver.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/explorer/intents/ scripts/explorer/selector-resolver.ts \
        src/tests/explorer/intents.test.ts src/tests/explorer/selector-resolver.test.ts
git commit -m "feat(explorer): intent registry types and selector resolver"
```

---

### Task 6: Messaging intents — `send_text_message`, `react_to_message`

**Files:**
- Modify: `scripts/explorer/intents/messaging.ts`

These wrap existing fuzz `ActionSpec.drive()` functions. We do NOT duplicate the logic — we adapt the call signature and capture an atomic_trace (a synthetic record describing what the underlying fuzz action did). For F1 the atomic_trace records intent-level facts (no fine-grained Playwright steps yet); F2 will instrument the fuzz action implementations to emit fine-grained traces.

- [ ] **Step 1: Implement messaging intents**

Replace the stub `scripts/explorer/intents/messaging.ts` with:

```typescript
import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext, Action} from '../../../src/tests/fuzz/types';
import {sendText} from '../../../src/tests/fuzz/actions/messaging';
import {reactViaUI} from '../../../src/tests/fuzz/actions/reactions';

const SendTextParams = z.object({
  from: z.enum(['userA', 'userB']),
  text: z.string().min(1).max(5000)
});

const ReactToMessageParams = z.object({
  from: z.enum(['userA', 'userB']),
  emoji: z.string().min(1).max(8)
});

export const send_text_message: IntentDef<z.infer<typeof SendTextParams>> = {
  name: 'send_text_message',
  area: 'messaging',
  paramsSchema: SendTextParams,
  description: 'Send a text message from one user to the other peer.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const action: Action = {name: 'sendText', args: params};
    const synthetic: AtomicAction[] = [
      {type: 'click', page: params.from === 'userA' ? 'A' : 'B', selector: '.chat-list peer'},
      {type: 'fill', page: params.from === 'userA' ? 'A' : 'B', selector: '.chat-input [contenteditable="true"]', value: params.text},
      {type: 'click', page: params.from === 'userA' ? 'A' : 'B', selector: '.chat-input button.btn-send'}
    ];
    try{
      await sendText.drive(ctx, action);
      return {ok: !action.skipped, atomic_trace: synthetic, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: synthetic, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const react_to_message: IntentDef<z.infer<typeof ReactToMessageParams>> = {
  name: 'react_to_message',
  area: 'messaging',
  paramsSchema: ReactToMessageParams,
  description: 'Add a reaction emoji to the most recent message in the open chat.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const action: Action = {name: 'reactViaUI', args: params};
    const synthetic: AtomicAction[] = [
      {type: 'click', page: params.from === 'userA' ? 'A' : 'B', selector: '.bubble:last-child'},
      {type: 'click', page: params.from === 'userA' ? 'A' : 'B', selector: '.reactions-menu'},
      {type: 'click', page: params.from === 'userA' ? 'A' : 'B', selector: `.reactions-menu emoji[value="${params.emoji}"]`}
    ];
    try{
      await reactViaUI.drive(ctx, action);
      return {ok: !action.skipped, atomic_trace: synthetic, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: synthetic, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const messagingIntents: Record<string, IntentDef<any>> = {
  send_text_message: send_text_message as IntentDef<any>,
  react_to_message: react_to_message as IntentDef<any>
};
```

Both imports (`sendText` from `messaging.ts`, `reactViaUI` from `reactions.ts`) are verified correct as of plan-write time.

- [ ] **Step 2: Verify the existing intents.test.ts still passes**

Run: `pnpm exec vitest run src/tests/explorer/intents.test.ts`
Expected: PASS — the field-shape assertion now iterates 2 intents.

- [ ] **Step 3: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/explorer/intents/messaging.ts
git commit -m "feat(explorer): messaging intents (send_text_message, react_to_message)"
```

---

### Task 7: Navigation intents — `open_settings`, `open_chat_with`, `scroll_history_back`

**Files:**
- Modify: `scripts/explorer/intents/navigation.ts`

Navigation intents click the relevant UI areas. They do NOT have fuzz-action equivalents — implemented from scratch using the `selector-resolver`.

- [ ] **Step 1: Implement navigation intents**

Replace `scripts/explorer/intents/navigation.ts`:

```typescript
import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext} from '../../../src/tests/fuzz/types';

const OpenSettingsParams = z.object({page: z.enum(['userA', 'userB'])});
const OpenChatWithParams = z.object({
  page: z.enum(['userA', 'userB']),
  peer: z.enum(['userA', 'userB'])
});
const ScrollHistoryBackParams = z.object({
  page: z.enum(['userA', 'userB']),
  messageCount: z.number().int().min(1).max(200)
});

const pageOf = (u: 'userA'|'userB') => u === 'userA' ? 'A' : 'B' as const;

export const open_settings: IntentDef<z.infer<typeof OpenSettingsParams>> = {
  name: 'open_settings',
  area: 'navigation',
  paramsSchema: OpenSettingsParams,
  description: 'Open the settings panel on the given user.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.page];
    const trace: AtomicAction[] = [];
    try{
      const menuBtn = u.page.locator('.sidebar-header .btn-menu-toggle, [data-testid="settings-button"]').first();
      trace.push({type: 'click', page: pageOf(params.page), selector: '.sidebar-header button[name="menu-toggle"]'});
      await menuBtn.click({timeout: 3000});
      const settingsItem = u.page.getByText('Settings', {exact: false}).first();
      trace.push({type: 'click', page: pageOf(params.page), selector: 'menu Settings item'});
      await settingsItem.click({timeout: 3000});
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const open_chat_with: IntentDef<z.infer<typeof OpenChatWithParams>> = {
  name: 'open_chat_with',
  area: 'navigation',
  paramsSchema: OpenChatWithParams,
  description: 'Open the chat with a specific peer from the chat list.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.page];
    const trace: AtomicAction[] = [];
    try{
      const peerHandle = ctx.users[params.peer];
      trace.push({type: 'evaluate', page: pageOf(params.page),
        script: `appImManager.setPeer({peerId: ${u.remotePeerId}})`});
      await u.page.evaluate((peerId: number) => {
        (window as any).appImManager?.setPeer?.({peerId});
      }, u.remotePeerId);
      await u.page.waitForTimeout(300);
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const scroll_history_back: IntentDef<z.infer<typeof ScrollHistoryBackParams>> = {
  name: 'scroll_history_back',
  area: 'navigation',
  paramsSchema: ScrollHistoryBackParams,
  description: 'Scroll the open chat backwards by approximately N messages worth.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const u = ctx.users[params.page];
    const trace: AtomicAction[] = [];
    try{
      const container = u.page.locator('.bubbles-inner, .chat-bubbles').first();
      const scrolls = Math.min(params.messageCount, 50);
      for(let i = 0; i < scrolls; i++) {
        trace.push({type: 'evaluate', page: pageOf(params.page),
          script: 'el.scrollTop -= 800'});
        await container.evaluate((el) => {(el as HTMLElement).scrollTop -= 800;});
        await u.page.waitForTimeout(80);
      }
      return {ok: true, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const navigationIntents: Record<string, IntentDef<any>> = {
  open_settings: open_settings as IntentDef<any>,
  open_chat_with: open_chat_with as IntentDef<any>,
  scroll_history_back: scroll_history_back as IntentDef<any>
};
```

- [ ] **Step 2: Verify intents.test.ts still passes**

Run: `pnpm exec vitest run src/tests/explorer/intents.test.ts`
Expected: PASS — 5 intents now in registry, all match the field shape.

- [ ] **Step 3: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/explorer/intents/navigation.ts
git commit -m "feat(explorer): navigation intents (open_settings, open_chat_with, scroll_history_back)"
```

---

### Task 8: Profile intent — `edit_profile_field`

**Files:**
- Modify: `scripts/explorer/intents/profile.ts`

`edit_profile_field` dispatches to one of three existing fuzz actions based on the requested field: `editNameAction`, `editBioAction`, or `setNip05Action`. The actual export names in `src/tests/fuzz/actions/profile.ts` are these three (verified at plan-write time). The `field` enum in the intent params maps 1:1 to which action to call.

- [ ] **Step 1: Implement profile intent**

Replace `scripts/explorer/intents/profile.ts`:

```typescript
import {z} from 'zod';
import type {IntentDef, IntentResult} from './types';
import type {AtomicAction} from '../types';
import type {FuzzContext, Action, ActionSpec} from '../../../src/tests/fuzz/types';
import {editNameAction, editBioAction, setNip05Action} from '../../../src/tests/fuzz/actions/profile';

const EditProfileFieldParams = z.object({
  user: z.enum(['userA', 'userB']),
  field: z.enum(['displayName', 'bio', 'nip05']),
  value: z.string().max(500)
});

const pageOf = (u: 'userA'|'userB') => u === 'userA' ? 'A' : 'B' as const;

const fieldToAction: Record<'displayName'|'bio'|'nip05', ActionSpec> = {
  displayName: editNameAction,
  bio: editBioAction,
  nip05: setNip05Action
};

export const edit_profile_field: IntentDef<z.infer<typeof EditProfileFieldParams>> = {
  name: 'edit_profile_field',
  area: 'profile',
  paramsSchema: EditProfileFieldParams,
  description: 'Open settings → profile editor → set the given field (displayName | bio | nip05) to the given value → save. Dispatches to the corresponding fuzz action.',
  async exec(params, ctx: FuzzContext): Promise<IntentResult> {
    const spec = fieldToAction[params.field];
    // Fuzz actions take args via Action.args. The exact arg shape depends on the
    // action — editNameAction expects {user, name}, editBioAction expects {user, bio},
    // setNip05Action expects {user, nip05}. Build the action accordingly.
    const argKey = params.field === 'displayName' ? 'name' :
                   params.field === 'bio' ? 'bio' : 'nip05';
    const action: Action = {name: spec.name, args: {user: params.user, [argKey]: params.value}};
    const trace: AtomicAction[] = [
      {type: 'click', page: pageOf(params.user), selector: '.sidebar-header .btn-menu-toggle'},
      {type: 'click', page: pageOf(params.user), selector: 'menu Settings'},
      {type: 'click', page: pageOf(params.user), selector: 'profile-editor'},
      {type: 'fill', page: pageOf(params.user), selector: `[data-field="${params.field}"]`, value: params.value},
      {type: 'click', page: pageOf(params.user), selector: 'button.btn-save-profile'}
    ];
    try{
      await spec.drive(ctx, action);
      return {ok: !action.skipped, atomic_trace: trace, observations: []};
    } catch(err: any) {
      return {ok: false, atomic_trace: trace, observations: [], error: err?.message ?? String(err)};
    }
  }
};

export const profileIntents: Record<string, IntentDef<any>> = {
  edit_profile_field: edit_profile_field as IntentDef<any>
};
```

Implementation note for the engineer: open `src/tests/fuzz/actions/profile.ts` and inspect `editNameAction.drive` to confirm the expected `args` shape. The mapping `displayName→name`, `bio→bio`, `nip05→nip05` is the documented assumption — if any of those actions consume a different arg key, adjust the `argKey` switch above to match. This is the only place the intent-to-fuzz-action arg mapping lives.

- [ ] **Step 2: Verify intents.test.ts still passes**

Run: `pnpm exec vitest run src/tests/explorer/intents.test.ts`
Expected: PASS — 6 intents in registry.

- [ ] **Step 3: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/explorer/intents/profile.ts
git commit -m "feat(explorer): profile intent (edit_profile_field)"
```

---

### Task 9: Driver `intent` and `atomic` dispatch

**Files:**
- Modify: `scripts/explorer/driver.ts`
- Test: `src/tests/explorer/driver-intent.test.ts`

Wire the driver to look up the intent by name in the registry, validate params via the Zod schema, run `exec`, and return the result. The `atomic` command runs raw atomic actions in sequence.

- [ ] **Step 1: Write the failing test**

Create `src/tests/explorer/driver-intent.test.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {decodeMessages, encodeMessage} from '../../../scripts/explorer/ipc';
import {randomUUID} from 'node:crypto';

const SOCKET = `/tmp/exp-test-${randomUUID().slice(0, 8)}.sock`;

describe('driver intent dispatch', () => {
  it('runs send_text_message intent and returns ok=true with atomic_trace', async () => {
    const driver = spawn('pnpm', ['explorer:driver', `--socket=${SOCKET}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('driver did not READY in 90s')), 90_000);
      driver.stdout!.on('data', (b) => {
        if(b.toString('utf8').includes('[driver] listening')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    const sock = createConnection(SOCKET);
    let buf = '';
    const responses: any[] = [];
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const {messages, remainder} = decodeMessages(buf);
      buf = remainder;
      responses.push(...messages);
    });

    sock.write(encodeMessage({
      id: '1',
      cmd: 'intent',
      intentName: 'send_text_message',
      params: {from: 'userA', text: 'hello explorer'}
    }));
    await new Promise((r) => setTimeout(r, 8000));

    expect(responses[0]).toMatchObject({id: '1', ok: true});
    expect(responses[0].data.atomic_trace).toBeInstanceOf(Array);
    expect(responses[0].data.atomic_trace.length).toBeGreaterThan(0);

    sock.write(encodeMessage({id: '2', cmd: 'teardown'}));
    await new Promise((r) => setTimeout(r, 1000));
    sock.end();
  }, 180_000);

  it('returns ok=false with error for unknown intent', async () => {
    // (Reuses pattern above; abbreviated here — copy the harness)
    const sock2 = `/tmp/exp-test-${randomUUID().slice(0, 8)}.sock`;
    const driver = spawn('pnpm', ['explorer:driver', `--socket=${sock2}`], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('driver did not READY in 90s')), 90_000);
      driver.stdout!.on('data', (b) => {
        if(b.toString('utf8').includes('[driver] listening')) {clearTimeout(timeout); resolve();}
      });
    });
    const sock = createConnection(sock2);
    let buf = '';
    const responses: any[] = [];
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const {messages, remainder} = decodeMessages(buf);
      buf = remainder;
      responses.push(...messages);
    });
    sock.write(encodeMessage({id: '1', cmd: 'intent', intentName: 'nope_does_not_exist', params: {}}));
    await new Promise((r) => setTimeout(r, 2000));
    expect(responses[0]).toMatchObject({id: '1', ok: false});
    expect(responses[0].error).toContain('unknown intent');
    sock.write(encodeMessage({id: '2', cmd: 'teardown'}));
    await new Promise((r) => setTimeout(r, 1000));
    sock.end();
  }, 180_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/tests/explorer/driver-intent.test.ts`
Expected: FAIL — `cmd intent not implemented in F1 yet`.

- [ ] **Step 3: Implement intent dispatch in the driver**

In `scripts/explorer/driver.ts`, import the registry and update `dispatch`:

```typescript
import {registry} from './intents/registry';

async function dispatch(req: Request, state: DriverState): Promise<Response> {
  switch(req.cmd) {
    case 'capture': {
      const data = await captureObservations(state);
      return {id: req.id, ok: true, data};
    }
    case 'intent': {
      const def = registry[req.intentName];
      if(!def) {
        return {id: req.id, ok: false, error: `unknown intent: ${req.intentName}`};
      }
      const parsed = def.paramsSchema.safeParse(req.params);
      if(!parsed.success) {
        return {id: req.id, ok: false, error: `invalid params: ${parsed.error.message}`};
      }
      try{
        const result = await def.exec(parsed.data, state.ctx);
        return {id: req.id, ok: result.ok, data: result, error: result.error};
      } catch(err: any) {
        return {id: req.id, ok: false, error: `intent threw: ${err?.message ?? String(err)}`};
      }
    }
    case 'atomic': {
      // Stub for now; F1 doesn't exercise atomic_actions fallback path beyond dispatch.
      return {id: req.id, ok: false, error: 'atomic dispatch not implemented in F1'};
    }
    case 'teardown':
      await state.teardown();
      setTimeout(() => process.exit(0), 50);
      return {id: req.id, ok: true};
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/tests/explorer/driver-intent.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/explorer/driver.ts src/tests/explorer/driver-intent.test.ts
git commit -m "feat(explorer): driver intent dispatch with Zod param validation"
```

---

### Task 10: Oracle A — hard automatic checks

**Files:**
- Create: `scripts/explorer/oracles/hard.ts`
- Test: `src/tests/explorer/oracle-hard.test.ts`
- Modify: `scripts/explorer/driver.ts` (run Oracle A after each intent, attach to response)

Oracle A inspects the captured console (post-intent) and the `consoleLog` ring buffer on the UserHandle for: console errors, unhandled rejections, network 5xx, white-screen heuristic. F1 wires the easiest two: `console_error` (filtered through fuzz allowlist) and `unhandled_rejection` (filtered through fuzz allowlist). Network and white-screen ship in F2.

- [ ] **Step 1: Write the failing test**

Create `src/tests/explorer/oracle-hard.test.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {checkHard, type HardOracleInput} from '../../../scripts/explorer/oracles/hard';

describe('Oracle A — hard checks', () => {
  it('flags console error not in allowlist', () => {
    const input: HardOracleInput = {
      pageA: {consoleSinceStart: ['[ERROR] Uncaught TypeError: foo is undefined']},
      pageB: {consoleSinceStart: []}
    };
    const findings = checkHard(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].oracle).toBe('console_error');
    expect(findings[0].page).toBe('A');
  });

  it('does NOT flag a console error matching the fuzz allowlist', () => {
    const input: HardOracleInput = {
      pageA: {consoleSinceStart: ['[vite] connected']},
      pageB: {consoleSinceStart: []}
    };
    expect(checkHard(input)).toHaveLength(0);
  });

  it('flags unhandled rejection', () => {
    const input: HardOracleInput = {
      pageA: {consoleSinceStart: []},
      pageB: {consoleSinceStart: ['[PAGEERROR] Unhandled promise rejection: bad thing']}
    };
    const findings = checkHard(input);
    expect(findings).toHaveLength(1);
    expect(findings[0].oracle).toBe('unhandled_rejection');
    expect(findings[0].page).toBe('B');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/tests/explorer/oracle-hard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Oracle A**

Create `scripts/explorer/oracles/hard.ts`:

```typescript
import {CONSOLE_ALLOWLIST} from '../../../src/tests/fuzz/allowlist';
import type {PageId} from '../types';

export type HardOracleKind = 'console_error' | 'unhandled_rejection' | 'network_5xx' | 'white_screen';

export interface HardFinding {
  oracle: HardOracleKind;
  page: PageId;
  message: string;
  hash: string;
}

export interface HardOracleInput {
  pageA: {consoleSinceStart: string[]};
  pageB: {consoleSinceStart: string[]};
}

export function checkHard(input: HardOracleInput): HardFinding[] {
  const findings: HardFinding[] = [];
  for(const [pageId, capture] of [['A', input.pageA], ['B', input.pageB]] as const) {
    for(const line of capture.consoleSinceStart) {
      if(isAllowlisted(line)) continue;
      if(line.includes('[ERROR]') || /\bUncaught\b/.test(line)) {
        findings.push({oracle: 'console_error', page: pageId, message: line, hash: shortHash(line)});
      }
      if(line.includes('[PAGEERROR]') || /Unhandled promise rejection/i.test(line)) {
        findings.push({oracle: 'unhandled_rejection', page: pageId, message: line, hash: shortHash(line)});
      }
    }
  }
  return findings;
}

function isAllowlisted(line: string): boolean {
  return CONSOLE_ALLOWLIST.some((re) => re.test(line));
}

function shortHash(s: string): string {
  let h = 0;
  for(let i = 0; i < Math.min(s.length, 200); i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/tests/explorer/oracle-hard.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Wire Oracle A into the driver `intent` response**

In `scripts/explorer/driver.ts`, add this static import at the top alongside the other imports:

```typescript
import {checkHard} from './oracles/hard';
```

Then replace the `case 'intent':` body in `dispatch()`:

```typescript
case 'intent': {
  const def = registry[req.intentName];
  if(!def) {
    return {id: req.id, ok: false, error: `unknown intent: ${req.intentName}`};
  }
  const parsed = def.paramsSchema.safeParse(req.params);
  if(!parsed.success) {
    return {id: req.id, ok: false, error: `invalid params: ${parsed.error.message}`};
  }
  try{
    const result = await def.exec(parsed.data, state.ctx);
    const hardFindings = checkHard({
      pageA: {consoleSinceStart: state.ctx.users.userA.consoleLog},
      pageB: {consoleSinceStart: state.ctx.users.userB.consoleLog}
    });
    return {
      id: req.id,
      ok: result.ok && hardFindings.length === 0,
      data: {...result, hard_findings: hardFindings},
      error: result.error
    };
  } catch(err: any) {
    return {id: req.id, ok: false, error: `intent threw: ${err?.message ?? String(err)}`};
  }
}
```

- [ ] **Step 6: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/explorer/oracles/hard.ts src/tests/explorer/oracle-hard.test.ts scripts/explorer/driver.ts
git commit -m "feat(explorer): Oracle A hard checks (console_error, unhandled_rejection)"
```

---

### Task 11: Reporter — write FIND-* and run-* artifacts

**Files:**
- Create: `scripts/explorer/reporter.ts`
- Test: `src/tests/explorer/reporter.test.ts`

The reporter writes either `docs/explorer-reports/FIND-<8hex>/` (if a finding fired) or `docs/explorer-reports/runs/<run-id>/` (if no finding) with the trace, the report markdown, the captured screenshots (copy from /tmp), and a signature placeholder. F1's signature is just the hard finding hash; F2 introduces the structured signature scheme.

- [ ] **Step 1: Write the failing test**

Create `src/tests/explorer/reporter.test.ts`:

```typescript
import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeReport, type ReportInput} from '../../../scripts/explorer/reporter';

describe('explorer reporter', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exp-reporter-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, {recursive: true, force: true});
  });

  it('writes a FIND-<id>/ directory with trace.jsonl, report.md, signature.txt', async () => {
    const input: ReportInput = {
      reportRoot: tmpRoot,
      kind: 'finding',
      goal: 'send a message',
      trace: [
        {step: 1, intent: 'send_text_message', params: {from: 'userA', text: 'hi'},
         atomic_trace: [{type: 'click', page: 'A', selector: '.send'}]}
      ],
      finding: {
        oracle: 'console_error',
        page: 'A',
        message: '[ERROR] something broke',
        hash: 'deadbeef'
      },
      screenshots: []
    };
    const dir = await writeReport(input);
    expect(dir).toMatch(/FIND-[0-9a-f]{8}$/);
    expect(existsSync(join(dir, 'trace.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'report.md'))).toBe(true);
    expect(existsSync(join(dir, 'signature.txt'))).toBe(true);
    expect(readFileSync(join(dir, 'signature.txt'), 'utf8')).toContain('console_error');
  });

  it('writes a runs/<run-id>/ directory when kind=run (no finding)', async () => {
    const input: ReportInput = {
      reportRoot: tmpRoot,
      kind: 'run',
      goal: 'send a message',
      trace: [{step: 1, intent: 'send_text_message', params: {from: 'userA', text: 'hi'}, atomic_trace: []}],
      finding: null,
      screenshots: []
    };
    const dir = await writeReport(input);
    expect(dir).toMatch(/runs\/[0-9a-f-]+$/);
    expect(existsSync(join(dir, 'trace.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'report.md'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/tests/explorer/reporter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the reporter**

Create `scripts/explorer/reporter.ts`:

```typescript
import {mkdirSync, writeFileSync, copyFileSync, existsSync} from 'node:fs';
import {join, basename} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import type {AtomicAction} from './types';
import type {HardFinding} from './oracles/hard';

export interface TraceStep {
  step: number;
  intent: string;
  params: Record<string, unknown>;
  atomic_trace: AtomicAction[];
}

export interface ReportInput {
  reportRoot: string;
  kind: 'finding' | 'run';
  goal: string;
  trace: TraceStep[];
  finding: HardFinding | null;
  screenshots: {pathOnDisk: string; label: string}[];
}

export async function writeReport(input: ReportInput): Promise<string> {
  let dir: string;
  if(input.kind === 'finding') {
    if(!input.finding) throw new Error('writeReport: kind=finding requires finding');
    const sigInput = `${input.finding.oracle}:${input.finding.page}:${input.finding.hash}`;
    const findId = createHash('sha1').update(sigInput).digest('hex').slice(0, 8);
    dir = join(input.reportRoot, `FIND-${findId}`);
  } else {
    const runId = randomUUID();
    dir = join(input.reportRoot, 'runs', runId);
  }
  mkdirSync(dir, {recursive: true});
  mkdirSync(join(dir, 'screenshots'), {recursive: true});

  // trace.jsonl
  writeFileSync(
    join(dir, 'trace.jsonl'),
    input.trace.map((s) => JSON.stringify(s)).join('\n') + '\n',
    'utf8'
  );

  // signature.txt (only for findings)
  if(input.finding) {
    writeFileSync(
      join(dir, 'signature.txt'),
      `${input.finding.oracle}:${input.finding.page}:${input.finding.hash}\n`,
      'utf8'
    );
  }

  // report.md
  writeFileSync(join(dir, 'report.md'), renderMarkdown(input), 'utf8');

  // screenshots
  for(const s of input.screenshots) {
    if(!existsSync(s.pathOnDisk)) continue;
    copyFileSync(s.pathOnDisk, join(dir, 'screenshots', `${s.label}-${basename(s.pathOnDisk)}`));
  }

  return dir;
}

function renderMarkdown(input: ReportInput): string {
  const head = input.kind === 'finding'
    ? `# Finding\n\n**Goal**: ${input.goal}\n**Oracle**: ${input.finding!.oracle}\n**Page**: ${input.finding!.page}\n**Message**: \`${input.finding!.message.slice(0, 200)}\`\n`
    : `# Run\n\n**Goal**: ${input.goal}\n**Status**: completed without findings\n`;
  const traceMd = input.trace.map((s) => `${s.step}. \`${s.intent}\` ${JSON.stringify(s.params)}`).join('\n');
  return `${head}\n## Trace\n\n${traceMd}\n`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/tests/explorer/reporter.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/explorer/reporter.ts src/tests/explorer/reporter.test.ts
git commit -m "feat(explorer): reporter writes FIND-* and runs/* artifacts"
```

---

### Task 12: Replay command (pure-Playwright re-execution)

**Files:**
- Create: `scripts/explorer/replay.ts`
- Test: `src/tests/explorer/replay.test.ts`

Replay reads `trace.jsonl` from a FIND or run directory, spins up `bootHarness`, and re-executes each step's `intent` (NOT atomic_trace — atomic_trace is descriptive only in F1; intents are the canonical re-execution path because they wrap fuzz actions which are deterministic relative to harness state). The replay never calls an LLM. F1 supports replay only for the 5 catalog intents.

- [ ] **Step 1: Write the failing test**

Create `src/tests/explorer/replay.test.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {parseTraceFile} from '../../../scripts/explorer/replay';
import {writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

describe('replay parser', () => {
  it('parses a 2-step trace file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'replay-'));
    const trace = [
      {step: 1, intent: 'send_text_message', params: {from: 'userA', text: 'a'}, atomic_trace: []},
      {step: 2, intent: 'react_to_message', params: {from: 'userB', emoji: '🔥'}, atomic_trace: []}
    ];
    writeFileSync(join(tmp, 'trace.jsonl'), trace.map((s) => JSON.stringify(s)).join('\n') + '\n');
    const parsed = parseTraceFile(join(tmp, 'trace.jsonl'));
    expect(parsed).toHaveLength(2);
    expect(parsed[0].intent).toBe('send_text_message');
    rmSync(tmp, {recursive: true, force: true});
  });

  it('throws on malformed JSON', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'replay-'));
    writeFileSync(join(tmp, 'trace.jsonl'), 'not json\n');
    expect(() => parseTraceFile(join(tmp, 'trace.jsonl'))).toThrow();
    rmSync(tmp, {recursive: true, force: true});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/tests/explorer/replay.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement replay**

Create `scripts/explorer/replay.ts`:

```typescript
import {readFileSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {bootHarness} from '../../src/tests/fuzz/harness';
import {registry} from './intents/registry';
import type {TraceStep} from './reporter';

export function parseTraceFile(path: string): TraceStep[] {
  const raw = readFileSync(path, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TraceStep);
}

async function main() {
  const target = process.argv[2];
  if(!target) {
    console.error('Usage: pnpm explorer:replay <FIND-id-or-run-id-or-trace-path>');
    process.exit(2);
  }

  let tracePath: string;
  if(existsSync(target)) {
    tracePath = target;
  } else {
    const findDir = join('docs/explorer-reports', target);
    const runDir = join('docs/explorer-reports/runs', target);
    if(existsSync(join(findDir, 'trace.jsonl'))) tracePath = join(findDir, 'trace.jsonl');
    else if(existsSync(join(runDir, 'trace.jsonl'))) tracePath = join(runDir, 'trace.jsonl');
    else {
      console.error(`could not find trace.jsonl at ${findDir} or ${runDir}`);
      process.exit(2);
    }
  }

  const steps = parseTraceFile(tracePath);
  console.log(`[replay] ${steps.length} step(s) from ${tracePath}`);

  const harness = await bootHarness({headed: false});
  try{
    for(const step of steps) {
      console.log(`[replay] step ${step.step}: ${step.intent} ${JSON.stringify(step.params)}`);
      const def = registry[step.intent];
      if(!def) {
        console.error(`[replay] unknown intent ${step.intent}, aborting`);
        process.exit(3);
      }
      const parsed = def.paramsSchema.safeParse(step.params);
      if(!parsed.success) {
        console.error(`[replay] invalid params for ${step.intent}: ${parsed.error.message}`);
        process.exit(3);
      }
      const result = await def.exec(parsed.data, harness.ctx);
      if(!result.ok) {
        console.error(`[replay] step ${step.step} failed: ${result.error ?? 'no error message'}`);
        process.exit(4);
      }
    }
    console.log('[replay] all steps replayed successfully');
  } finally {
    await harness.teardown();
  }
}

if(require.main === module) {
  main().catch((err) => {console.error('[replay] fatal:', err); process.exit(1);});
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/tests/explorer/replay.test.ts`
Expected: PASS, 2/2.

- [ ] **Step 5: Verify lint + tsc**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/explorer/replay.ts src/tests/explorer/replay.test.ts
git commit -m "feat(explorer): replay command for pure-Playwright re-execution"
```

---

### Task 13: Slash command and explorer subagent definition + F1 smoke

**Files:**
- Create: `.claude/commands/nostra-explore.md`
- Create: `.claude/agents/nostra-explorer.md`

The slash command parses the optional goal argument, then dispatches the explorer subagent. The explorer subagent (in F1) follows a minimal hardcoded loop: it picks an intent based on the goal (or a default `send_text_message` if no goal), tells the driver to execute it, captures the result, runs Oracle A on the response, and writes either a FIND or a run report. F1 does NOT include autonomous LLM-driven exploration — that is F2. F1 is a "single-intent dry run" of the whole pipeline.

- [ ] **Step 1: Create the explorer subagent definition**

Create `.claude/agents/nostra-explorer.md`:

```markdown
---
name: nostra-explorer
description: Drives the agentic explorer for nostra.chat. Spawns the Node Playwright driver subprocess, sends a single intent based on the user's goal, captures the result, runs Oracle A, and writes a FIND-* or runs/* artifact.
tools: Bash, Read, Write, Glob, Grep
---

You are the **nostra-explorer subagent** — F1 skeleton mode. Your job is to:

1. Read the priming pack:
   - `docs/superpowers/specs/2026-04-29-agentic-explorer-design.md` (full design)
   - `docs/FEATURES.md` (what nostra.chat does)
   - `docs/explorer-reports/README.md` (output layout)
2. Parse the user's goal from the prompt.
3. Spawn the driver: `pnpm explorer:driver --socket=/tmp/exp-$(date +%s).sock` in background via Bash with `run_in_background: true`. Wait for `[driver] listening` log line.
4. Send a single intent based on the goal:
   - "send a message" → `send_text_message` with `{from: "userA", text: "hello explorer"}`
   - "react to a message" → first `send_text_message`, then `react_to_message` with `{from: "userB", emoji: "🔥"}`
   - "edit profile" → `edit_profile_field` with `{user: "userA", field: "bio", value: "Updated by explorer F1"}`
   - "open settings" → `open_settings` with `{page: "userA"}`
   - "scroll history" → first send 10 messages, then `scroll_history_back` with `{page: "userA", messageCount: 5}`
   - Anything else → default to `send_text_message` and note in the report that the goal was unrecognized.
5. Send the request as JSON line to the socket via `nc -U <socket>`. Read the response.
6. If `response.data.hard_findings` is non-empty, the run produced a finding. Otherwise it's a clean run.
7. Use the reporter directly via a small inline TypeScript script (or pre-built helper) to write the FIND-* or runs/* artifact. For F1 you can shell out to a tiny invocation:
   ```bash
   pnpm exec tsx -e "import('./scripts/explorer/reporter').then(m => m.writeReport({...}))"
   ```
   Pass: `reportRoot: 'docs/explorer-reports'`, `kind: 'finding'|'run'`, `goal`, `trace`, `finding`, `screenshots`.
8. Send `{cmd: "teardown"}` to the driver socket.
9. Emit a final summary: the path to the artifact directory, the goal, and either "FINDING: <oracle>" or "CLEAN".

**Constraints**:
- You CANNOT Edit files under `src/` — only Read + Write under `docs/explorer-reports/` + Bash for orchestration.
- F1 does NOT support autonomous loops, expectation oracles, or invariants. Stay within the single-intent flow above.
- If the driver fails to start within 90 seconds, report the error and exit cleanly.
```

- [ ] **Step 2: Create the slash command**

Create `.claude/commands/nostra-explore.md`:

```markdown
---
description: Run the agentic explorer for nostra.chat (F1: single intent based on goal)
---

You're the orchestrator for `/nostra-explore`. The user invoked it with the following arguments: `$ARGUMENTS`.

**F1 behavior (skeleton phase)**:

1. Parse `$ARGUMENTS` as the goal. If empty, default goal is "send a message".
2. Verify the dev server is running: `curl -sI http://localhost:8080 | head -1`. If not 200, instruct the user to run `pnpm preview` (production build) or `pnpm start` first.
3. Dispatch the `nostra-explorer` subagent via the Agent tool with:
   - `subagent_type: "nostra-explorer"` (custom subagent defined in `.claude/agents/nostra-explorer.md`)
   - prompt: full instructions from the subagent's frontmatter applied to the parsed goal
4. Relay the subagent's summary to the user (artifact directory, goal, finding/clean).
5. If the subagent reported a finding, suggest replay: `pnpm explorer:replay <FIND-id>`.

**F1 limitations to communicate to the user**:
- Single intent per run (no autonomous loop)
- Oracle A only (no expectation/invariant)
- No auto-fix
- Manual report-only

These are designed limitations of F1 — F2/F3 will lift them. See `docs/superpowers/specs/2026-04-29-agentic-explorer-design.md` §6 for the phasing plan.
```

- [ ] **Step 3: Run all explorer tests**

Run: `pnpm test:explorer`
Expected: PASS — all unit tests from tasks 2, 5, 9, 10, 11, 12 green.

- [ ] **Step 4: Run lint and tsc**

Run: `pnpm lint && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Manual smoke (optional but recommended)**

Start the dev server in another terminal: `pnpm preview`. Then invoke `/nostra-explore "send a message"` in Claude Code. Verify:
- Driver spawns, two browser contexts open (briefly visible if you run with `--headed=true` env)
- Subagent sends `send_text_message` intent
- Driver returns `ok: true` with `data.atomic_trace.length > 0`
- A directory `docs/explorer-reports/runs/<uuid>/` is created with `trace.jsonl` + `report.md`
- No `FIND-*` directory unless a real console error fired (which would indicate a real bug, not a test artifact)

- [ ] **Step 6: F1 milestone commit**

```bash
git add .claude/commands/nostra-explore.md .claude/agents/nostra-explorer.md
git commit -m "feat(explorer): F1 slash command and explorer subagent definition

F1 skeleton complete:
- Driver subprocess with Unix socket IPC
- 5 catalog intents (send_text_message, react_to_message, open_settings,
  open_chat_with, scroll_history_back, edit_profile_field)
- Oracle A (console_error, unhandled_rejection) wired into intent dispatch
- Reporter writes FIND-* and runs/* artifacts
- Replay command for pure-Playwright re-execution
- Slash command + explorer subagent for single-intent runs

Verified: pnpm test:explorer green, manual smoke against pnpm preview.
F2 (full explorer) and F3 (fixer pipeline) follow as separate plans."
```

---

## Self-Review Checklist (run after writing the plan)

Run yourself after completing all tasks above:

1. **Spec coverage (F1 portion only)**:
   - [x] §6 F1 line "driver + IPC + 5 intents + oracle A + replay" → Tasks 3, 4, 5, 6, 7, 8, 9, 10, 12
   - [x] §6 F1 verifiable: "Manual run /nostra-explore 'send a message' produces trace.jsonl + deterministic replay" → Tasks 11, 12, 13
   - [x] §2 isolation: explorer subagent NO Edit on src/ → tools list in agent definition (Task 13)
   - [x] §4 reuse fuzz allowlist → import in oracles/hard.ts (Task 10)
   - [x] §3 idle timeout on driver → 10-min timer in driver (Task 3)
2. **Placeholder scan**: no "TBD"/"TODO" — verified.
3. **Type consistency**:
   - `IntentDef.exec(params, ctx) → Promise<IntentResult>` consistent across tasks 5, 6, 7, 8, 9
   - `AtomicAction` used uniformly in `types.ts`, `ipc.ts`, `intents/types.ts`
   - `TraceStep` used in `reporter.ts` and `replay.ts`
   - `HardFinding` produced in `oracles/hard.ts`, consumed in `reporter.ts`
4. **Out of F1 scope (deferred to F2/F3)**: Oracle B (expectation), Oracle D (invariants), triage, signature dedup, allowlist override, autonomous loop, fixer pipeline. Documented in plan header and in §6 of the spec.

---

## Out of scope for F1 (explicit)

- Oracle B (typed expectation verifier) — F2
- Oracle D (LLM-generated invariants in vm sandbox) — F2
- Second-pass triage subagent — F2
- Cross-run signature dedup (`seen-signatures.json`) — F2
- Goal selection autonomous mode (D) — F2
- Full intent catalog beyond 5 — F2
- Auto-fix pipeline — F3
- Worktree management — F3
- gh CLI / PR creation — F3
- Network/Tor/offline simulation — F3+

These are tracked explicitly in the spec at §6 and will become separate plans named:
- `2026-04-29-agentic-explorer-f2-full-explorer.md` (after F1 ships)
- `2026-04-29-agentic-explorer-f3-fixer-pipeline.md` (after F2 ships)
