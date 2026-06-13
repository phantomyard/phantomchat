# Agentic Explorer — F2a Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the foundation extensions that F2c (autonomous loop) will need: a robust Node socket client (replacing the `nc -U` improvisation that dropped responses during F1 smoke), a typed expectation verifier (Oracle B), cross-run signature deduplication, an `error` artifact kind for boot-time crashes, and the triage subagent definition. F2a does NOT change the user-visible single-intent flow yet — it lays the rails for F2b (catalog expansion) and F2c (autonomous LLM loop).

**Architecture:** Build on top of F1's existing skeleton (driver subprocess + intents + Oracle A + reporter). Add new modules `scripts/explorer/socket-client.ts`, `scripts/explorer/oracles/expectations.ts`, `scripts/explorer/signature.ts`, plus a new subagent definition `.claude/agents/nostra-explorer-triage.md`. Modify `scripts/explorer/reporter.ts` to support `kind: 'error'`, and patch `.claude/commands/nostra-explore.md` to use `pnpm start`.

**Tech Stack:** TypeScript 5.7, Playwright 1.59, Vitest 0.34, Zod 3.23 (already installed). No new runtime dependencies.

**Phase scope:** F2a only. F2b (catalog expansion: media, edge messaging, network/offline, settings intents) and F2c (autonomous loop, Oracle D invariants, triage wired into loop) are separate plans, written after F2a ships and is validated.

**Verification at end of F2a:**
- `/nostra-explore "send a message"` still produces a `runs/<uuid>/` artifact (no regression)
- The subagent uses the new Node socket client (no `nc -U` in the agent prompt)
- A new test exercises Oracle B typed expectation verification against synthetic page input
- `seen-signatures.json` records signatures across multiple runs (manual smoke: run twice with same goal → second run shows `occurrences: 2`)
- Triage subagent file is loadable (Claude Code recognises it via `.claude/agents/`)
- All explorer unit tests green; pre-existing F1 unit tests unaffected

---

## Recap: F1 baseline (already shipped, do not modify)

```
.claude/agents/nostra-explorer.md          # F1 subagent — modify in F2c, NOT here
.claude/commands/nostra-explore.md         # F1 slash command — F2a tweaks dev-server hint only
scripts/explorer/
├── driver.ts                              # F1 — F2a does NOT modify
├── ipc.ts                                 # F1 — F2a does NOT modify
├── types.ts                               # F1 — F2a does NOT modify
├── intents/                               # F1 catalog (6 intents) — F2a does NOT modify
├── oracles/hard.ts                        # F1 Oracle A — F2a does NOT modify
├── reporter.ts                            # F1 — F2a EXTENDS with kind: 'error'
├── replay.ts                              # F1 — F2a does NOT modify
└── selector-resolver.ts                   # F1 — F2a does NOT modify

src/tests/explorer/                         # F1 tests + new F2a tests
docs/explorer-reports/                     # F1 layout + new seen-signatures.json
```

## File structure (F2a)

### New files

```
scripts/explorer/
├── socket-client.ts                       # Node Unix socket JSON-RPC client (replaces nc -U)
├── signature.ts                           # computeSignature + dedup state I/O
└── oracles/
    └── expectations.ts                    # Typed Expectation schema + driver-side verifier

.claude/agents/
└── nostra-explorer-triage.md              # Triage subagent definition (not yet wired in loop)

src/tests/explorer/
├── socket-client.test.ts                  # round-trip with a fake echo server
├── signature.test.ts                      # dedup behavior, status transitions
├── expectations.test.ts                   # verifier resolves synthetic locators correctly
└── reporter-error.test.ts                 # error-kind artifact written correctly

docs/explorer-reports/
└── seen-signatures.json                   # initially empty {} — created by reporter on first finding
```

### Modified files

```
scripts/explorer/reporter.ts               # add kind: 'error' branch + integrate signature
.claude/commands/nostra-explore.md         # change "pnpm preview" → "pnpm start" guidance
package.json                               # no new deps, no new scripts
```

---

## Phase F2a: Foundation Extensions

### Task 1: Node socket client helper

**Why:** During F1 smoke, the subagent improvised a `node -e` helper after `nc -U` silently dropped responses. F2a ships this as a proper module so the subagent prompt can use a stable command.

**Files:**
- Create: `scripts/explorer/socket-client.ts`
- Create: `src/tests/explorer/socket-client.test.ts`

The client opens a Unix domain socket, sends a single JSON line request, awaits a single JSON line response, and exits. Standalone executable via `pnpm exec tsx scripts/explorer/socket-client.ts <socketPath> <jsonRequest>`. Returns the response on stdout (one JSON line, no extra logging on success path).

- [ ] **Step 1: Write the failing test**

Create `src/tests/explorer/socket-client.test.ts`:

```typescript
import {describe, expect, it} from 'vitest';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {sendOnce} from '../../../scripts/explorer/socket-client';
import {encodeMessage, decodeMessages} from '../../../scripts/explorer/ipc';
import {unlinkSync, existsSync} from 'node:fs';

describe('sendOnce — Unix socket JSON-RPC client', () => {
  it('sends one request and returns the parsed response', async() => {
    const sockPath = `/tmp/exp-test-sc-${randomUUID().slice(0, 8)}.sock`;
    if(existsSync(sockPath)) unlinkSync(sockPath);

    const server = createServer((sock) => {
      let buf = '';
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const {messages, remainder} = decodeMessages(buf);
        buf = remainder;
        for(const raw of messages) {
          const r = raw as {id: string; cmd: string};
          sock.write(encodeMessage({id: r.id, ok: true, data: {echoed: r.cmd}}));
        }
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));

    try {
      const response = await sendOnce(sockPath, {id: '1', cmd: 'capture'}, 5000);
      expect(response).toEqual({id: '1', ok: true, data: {echoed: 'capture'}});
    } finally {
      server.close();
      if(existsSync(sockPath)) unlinkSync(sockPath);
    }
  });

  it('rejects on timeout if the server never responds', async() => {
    const sockPath = `/tmp/exp-test-sc-${randomUUID().slice(0, 8)}.sock`;
    if(existsSync(sockPath)) unlinkSync(sockPath);
    const server = createServer(() => { /* never write a response */ });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));

    try {
      await expect(sendOnce(sockPath, {id: '1', cmd: 'capture'}, 200)).rejects.toThrow(/timeout/i);
    } finally {
      server.close();
      if(existsSync(sockPath)) unlinkSync(sockPath);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it FAILS** — module not found.

`pnpm exec vitest run src/tests/explorer/socket-client.test.ts`

- [ ] **Step 3: Implement `scripts/explorer/socket-client.ts`**

```typescript
import {createConnection} from 'node:net';
import {decodeMessages, encodeMessage} from './ipc';

/**
 * Send one JSON-line request to a Unix domain socket and resolve with the
 * first JSON-line response. Rejects on timeout or socket error.
 */
export function sendOnce(
  socketPath: string,
  request: {id: string; [k: string]: unknown},
  timeoutMs: number = 30_000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    let buf = '';
    let settled = false;
    const finish = (err: Error | null, value?: unknown) => {
      if(settled) return;
      settled = true;
      try {sock.end();} catch{}
      if(err) reject(err); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`sendOnce timeout after ${timeoutMs}ms`)), timeoutMs);

    sock.on('connect', () => {
      sock.write(encodeMessage(request));
    });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const {messages, remainder} = decodeMessages(buf);
      buf = remainder;
      if(messages.length > 0) {
        clearTimeout(timer);
        finish(null, messages[0]);
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      finish(err);
    });
  });
}

async function main() {
  const [sockPath, jsonReq] = process.argv.slice(2);
  if(!sockPath || !jsonReq) {
    console.error('Usage: tsx scripts/explorer/socket-client.ts <socketPath> <jsonRequest>');
    process.exit(2);
  }
  let req: {id: string; [k: string]: unknown};
  try {
    req = JSON.parse(jsonReq);
  } catch(err: any) {
    console.error(`invalid JSON request: ${err?.message ?? String(err)}`);
    process.exit(2);
  }
  if(!req.id) req.id = String(Date.now());
  try {
    const resp = await sendOnce(sockPath, req);
    console.log(JSON.stringify(resp));
  } catch(err: any) {
    console.error(`sendOnce failed: ${err?.message ?? String(err)}`);
    process.exit(3);
  }
}

if(process.argv[1] && process.argv[1].endsWith('socket-client.ts')) {
  main();
}
```

- [ ] **Step 4: Run test to verify it PASSES** — 2/2.

- [ ] **Step 5: Verify lint clean**

```bash
cd /home/raider/Repository/nostra.chat-wt/explorer-f2a && npx eslint scripts/explorer/socket-client.ts src/tests/explorer/socket-client.test.ts
```
Expected: 0 errors. Note: the project's `pnpm lint` only globs `src/**/*.{ts,tsx}` — the `scripts/` directory is NOT covered, so direct `npx eslint` is required.

- [ ] **Step 6: Commit**

```bash
git add scripts/explorer/socket-client.ts src/tests/explorer/socket-client.test.ts
git commit -m "$(cat <<'EOF'
feat(explorer): Node socket client helper (replaces nc -U)

During F1 smoke, nc -U silently dropped the response on the user's box —
the subagent had to improvise a node -e helper. This ships sendOnce()
as a proper module with timeout + error handling, plus a CLI entrypoint
so the subagent prompt can use a stable command.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Slash command doc fix — `pnpm start` not `pnpm preview`

**Why:** F1 smoke confirmed `pnpm preview` (prod build) does NOT serve the harness's dynamic TS imports correctly — Vite preview's SPA fallback returns `index.html` for any URL, hiding module-graph issues. The harness only works with `pnpm start` (vite dev). Doc lies → user confusion.

**Files:**
- Modify: `.claude/commands/nostra-explore.md`

- [ ] **Step 1: Patch the slash command doc**

In `.claude/commands/nostra-explore.md`, find the line:

```markdown
2. Verify the dev server is running: `curl -sI http://localhost:8080 | head -1`. If not 200, instruct the user to run `pnpm preview` (production build) or `pnpm start` first.
```

Replace with:

```markdown
2. Verify the dev server is running: `curl -sI http://localhost:8080 | head -1`. If not 200, instruct the user to run `pnpm start` first. Do NOT suggest `pnpm preview` — preview's SPA fallback returns index.html for any unmatched URL, including the dynamic TS imports the harness needs, so the explorer driver will fail to initialize against a preview server. The dev server (`pnpm start`) is the only mode currently supported by the F1/F2a harness.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/commands/nostra-explore.md
git commit -m "$(cat <<'EOF'
docs(explorer): fix nostra-explore.md to require pnpm start (not preview)

F1 smoke confirmed pnpm preview's SPA fallback breaks the harness's
dynamic TS imports. Only pnpm start (vite dev) is supported.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Cross-run signature dedup machinery

**Files:**
- Create: `scripts/explorer/signature.ts`
- Create: `src/tests/explorer/signature.test.ts`
- Modify: `scripts/explorer/reporter.ts` to call into signature module

The signature module computes a stable signature for a finding (`area:intent:oracle:hash`), and persists / loads `docs/explorer-reports/seen-signatures.json` with status (`open` | `fixed` | `allowlisted`) and `occurrences`. New findings increment occurrences if the signature already exists.

- [ ] **Step 1: Write the failing test**

Create `src/tests/explorer/signature.test.ts`:

```typescript
import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import {mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {computeSignature, recordSighting, loadStore, type Sighting} from '../../../scripts/explorer/signature';

describe('explorer signature', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exp-sig-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, {recursive: true, force: true});
  });

  it('computeSignature returns a stable string for identical inputs', () => {
    const sig1 = computeSignature({area: 'messaging', intent: 'send_text_message', oracle: 'A:console_error', hash: 'deadbeef'});
    const sig2 = computeSignature({area: 'messaging', intent: 'send_text_message', oracle: 'A:console_error', hash: 'deadbeef'});
    expect(sig1).toBe(sig2);
    expect(sig1).toBe('messaging:send_text_message:A:console_error:deadbeef');
  });

  it('recordSighting creates the store on first call', async() => {
    const storePath = join(tmpRoot, 'seen-signatures.json');
    const sighting: Sighting = {
      signature: 'messaging:send_text_message:A:console_error:abc12345',
      findId: 'FIND-12345678',
      timestamp: '2026-04-29T14:00:00Z'
    };
    const result = await recordSighting(storePath, sighting);
    expect(result.isNew).toBe(true);
    expect(result.entry.occurrences).toBe(1);
    expect(existsSync(storePath)).toBe(true);
    const parsed = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(parsed[sighting.signature]).toMatchObject({
      find_id: 'FIND-12345678',
      occurrences: 1,
      status: 'open'
    });
  });

  it('recordSighting bumps occurrences on duplicate signature', async() => {
    const storePath = join(tmpRoot, 'seen-signatures.json');
    const sig = 'messaging:send_text_message:A:console_error:abc12345';
    await recordSighting(storePath, {signature: sig, findId: 'FIND-1', timestamp: '2026-04-29T14:00:00Z'});
    const result = await recordSighting(storePath, {signature: sig, findId: 'FIND-2', timestamp: '2026-04-29T14:05:00Z'});
    expect(result.isNew).toBe(false);
    expect(result.entry.occurrences).toBe(2);
    expect(result.entry.first_seen).toBe('2026-04-29T14:00:00Z');
    expect(result.entry.last_seen).toBe('2026-04-29T14:05:00Z');
  });

  it('loadStore returns {} when the file does not exist', async() => {
    const storePath = join(tmpRoot, 'missing.json');
    const store = await loadStore(storePath);
    expect(store).toEqual({});
  });

  it('recordSighting flags REGRESSION when signature has status=fixed', async() => {
    const storePath = join(tmpRoot, 'seen-signatures.json');
    const sig = 'messaging:send_text_message:A:console_error:abc12345';
    writeFileSync(storePath, JSON.stringify({
      [sig]: {find_id: 'FIND-old', occurrences: 1, first_seen: 't0', last_seen: 't0', status: 'fixed'}
    }));
    const result = await recordSighting(storePath, {signature: sig, findId: 'FIND-new', timestamp: 't1'});
    expect(result.isNew).toBe(false);
    expect(result.regression).toBe(true);
    expect(result.entry.status).toBe('fixed'); // status preserved; caller decides what to do
  });
});
```

- [ ] **Step 2: Run test to verify it FAILS** — module not found.

- [ ] **Step 3: Implement `scripts/explorer/signature.ts`**

```typescript
import {existsSync, readFileSync, writeFileSync} from 'node:fs';

export interface SignatureKey {
  area: string;
  intent: string;     // 'atomic' if no intent
  oracle: string;     // e.g. 'A:console_error', 'B:element_appears'
  hash: string;       // truncated content hash
}

export interface SeenEntry {
  find_id: string;
  occurrences: number;
  first_seen: string;
  last_seen: string;
  status: 'open' | 'fixed' | 'allowlisted';
  fix_pr?: string;
  fix_branch?: string;
}

export type SeenStore = Record<string, SeenEntry>;

export interface Sighting {
  signature: string;
  findId: string;
  timestamp: string;
}

export interface RecordResult {
  isNew: boolean;
  regression: boolean;
  entry: SeenEntry;
}

export function computeSignature(key: SignatureKey): string {
  return `${key.area}:${key.intent}:${key.oracle}:${key.hash}`;
}

export async function loadStore(storePath: string): Promise<SeenStore> {
  if(!existsSync(storePath)) return {};
  const raw = readFileSync(storePath, 'utf8');
  if(!raw.trim()) return {};
  return JSON.parse(raw) as SeenStore;
}

export async function recordSighting(storePath: string, s: Sighting): Promise<RecordResult> {
  const store = await loadStore(storePath);
  const existing = store[s.signature];
  if(!existing) {
    const entry: SeenEntry = {
      find_id: s.findId,
      occurrences: 1,
      first_seen: s.timestamp,
      last_seen: s.timestamp,
      status: 'open'
    };
    store[s.signature] = entry;
    writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
    return {isNew: true, regression: false, entry};
  }
  const regression = existing.status === 'fixed';
  existing.occurrences += 1;
  existing.last_seen = s.timestamp;
  // Preserve status, find_id, first_seen, fix_pr, fix_branch from the existing entry.
  writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return {isNew: false, regression, entry: existing};
}
```

- [ ] **Step 4: Run test to verify it PASSES** — 5/5.

- [ ] **Step 5: Verify lint clean**

```bash
npx eslint scripts/explorer/signature.ts src/tests/explorer/signature.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add scripts/explorer/signature.ts src/tests/explorer/signature.test.ts
git commit -m "$(cat <<'EOF'
feat(explorer): cross-run signature dedup with regression detection

Adds computeSignature + recordSighting + loadStore. F2a establishes the
machinery; F2c will wire it into the autonomous loop. seen-signatures.json
is written under docs/explorer-reports/ on first sighting and bumps
occurrences on subsequent matches. status=fixed re-encounter flags as
regression.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Reporter — `kind: 'error'` artifact for boot-time crashes + signature integration

**Files:**
- Modify: `scripts/explorer/reporter.ts`
- Create: `src/tests/explorer/reporter-error.test.ts`

The F1 reporter only handles `'finding'` and `'run'`. F1 smoke surfaced that boot-time crashes (driver fails to bootstrap, harness throws before any intent runs) have no first-class artifact — they end up in driver stderr only. F2a adds `kind: 'error'` for these cases. Also wires `recordSighting` into the `'finding'` path.

- [ ] **Step 1: Write the failing test for `kind: 'error'`**

Create `src/tests/explorer/reporter-error.test.ts`:

```typescript
import {describe, expect, it, beforeEach, afterEach} from 'vitest';
import {mkdtempSync, rmSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {writeReport, type ReportInput} from '../../../scripts/explorer/reporter';

describe('reporter error kind', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'exp-reporter-err-'));
  });

  afterEach(() => {
    rmSync(tmpRoot, {recursive: true, force: true});
  });

  it('writes an errors/<id>/ directory with stderr.log + report.md when kind=error', async() => {
    const input: ReportInput = {
      reportRoot: tmpRoot,
      kind: 'error',
      goal: 'send a message',
      trace: [],
      finding: null,
      screenshots: [],
      errorReason: 'driver failed to boot: harness timed out waiting for userA onboarding',
      errorStderr: '[harness] boot: ...\n[ERROR] First-install popup intercepted click\n'
    };
    const dir = await writeReport(input);
    expect(dir).toMatch(/errors\/[0-9a-f-]+$/);
    expect(existsSync(join(dir, 'report.md'))).toBe(true);
    expect(existsSync(join(dir, 'stderr.log'))).toBe(true);
    const md = readFileSync(join(dir, 'report.md'), 'utf8');
    expect(md).toContain('# Error');
    expect(md).toContain('driver failed to boot');
    const stderr = readFileSync(join(dir, 'stderr.log'), 'utf8');
    expect(stderr).toContain('First-install popup');
  });
});
```

- [ ] **Step 2: Run test to verify it FAILS**

Expected: TypeScript error on `kind: 'error'` (not a valid value yet) OR runtime "writeReport: unknown kind".

- [ ] **Step 3: Modify `scripts/explorer/reporter.ts`**

Replace the file content with this updated version:

```typescript
import {mkdirSync, writeFileSync, copyFileSync, existsSync} from 'node:fs';
import {join, basename} from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import type {AtomicAction} from './types';
import type {HardFinding} from './oracles/hard';
import {computeSignature, recordSighting, type Sighting} from './signature';

export interface TraceStep {
  step: number;
  intent: string;
  params: Record<string, unknown>;
  atomic_trace: AtomicAction[];
}

export interface ReportInput {
  reportRoot: string;
  kind: 'finding' | 'run' | 'error';
  goal: string;
  trace: TraceStep[];
  finding: HardFinding | null;
  screenshots: {pathOnDisk: string; label: string}[];
  /** Required when kind === 'error' — short summary of why the run failed before producing a finding/run. */
  errorReason?: string;
  /** Required when kind === 'error' — captured stderr / stdout of the driver. */
  errorStderr?: string;
}

export async function writeReport(input: ReportInput): Promise<string> {
  let dir: string;
  if(input.kind === 'finding') {
    if(!input.finding) throw new Error('writeReport: kind=finding requires finding');
    const sigInput = `${input.finding.oracle}:${input.finding.page}:${input.finding.hash}`;
    const findId = createHash('sha1').update(sigInput).digest('hex').slice(0, 8);
    dir = join(input.reportRoot, `FIND-${findId}`);
  } else if(input.kind === 'run') {
    const runId = randomUUID();
    dir = join(input.reportRoot, 'runs', runId);
  } else if(input.kind === 'error') {
    if(!input.errorReason) throw new Error('writeReport: kind=error requires errorReason');
    const errId = randomUUID();
    dir = join(input.reportRoot, 'errors', errId);
  } else {
    throw new Error(`writeReport: unknown kind ${(input as {kind: string}).kind}`);
  }

  mkdirSync(dir, {recursive: true});
  mkdirSync(join(dir, 'screenshots'), {recursive: true});

  // trace.jsonl (always written, may be empty for error)
  writeFileSync(
    join(dir, 'trace.jsonl'),
    input.trace.map((s) => JSON.stringify(s)).join('\n') + (input.trace.length > 0 ? '\n' : ''),
    'utf8'
  );

  // signature.txt + cross-run dedup (only for findings)
  if(input.kind === 'finding' && input.finding) {
    const intentName = input.trace.length > 0 ? input.trace[input.trace.length - 1].intent : 'atomic';
    const area = inferArea(intentName);
    const signature = computeSignature({
      area,
      intent: intentName,
      oracle: `A:${input.finding.oracle}`,
      hash: input.finding.hash
    });
    writeFileSync(join(dir, 'signature.txt'), signature + '\n', 'utf8');
    const findId = basename(dir).replace('FIND-', '');
    const sighting: Sighting = {
      signature,
      findId: `FIND-${findId}`,
      timestamp: new Date().toISOString()
    };
    await recordSighting(join(input.reportRoot, 'seen-signatures.json'), sighting);
  }

  // stderr.log (only for errors)
  if(input.kind === 'error' && input.errorStderr) {
    writeFileSync(join(dir, 'stderr.log'), input.errorStderr, 'utf8');
  }

  // report.md (always)
  writeFileSync(join(dir, 'report.md'), renderMarkdown(input), 'utf8');

  // screenshots
  for(const s of input.screenshots) {
    if(!existsSync(s.pathOnDisk)) continue;
    copyFileSync(s.pathOnDisk, join(dir, 'screenshots', `${s.label}-${basename(s.pathOnDisk)}`));
  }

  return dir;
}

function inferArea(intentName: string): string {
  if(intentName.startsWith('send_') || intentName.startsWith('react_') ||
     intentName.startsWith('edit_own_') || intentName.startsWith('reply_')) return 'messaging';
  if(intentName.startsWith('open_') || intentName.startsWith('scroll_') ||
     intentName.startsWith('navigate_')) return 'navigation';
  if(intentName.startsWith('edit_profile') || intentName.includes('avatar') ||
     intentName.includes('lightning') || intentName.includes('relays')) return 'profile';
  if(intentName.includes('group')) return 'edge';
  if(intentName.includes('paste') || intentName.includes('drag') || intentName.includes('voice')) return 'media';
  if(intentName.includes('offline') || intentName.includes('relay') || intentName.includes('network')) return 'network';
  return 'unknown';
}

function renderMarkdown(input: ReportInput): string {
  if(input.kind === 'finding') {
    const head = `# Finding\n\n**Goal**: ${input.goal}\n**Oracle**: ${input.finding!.oracle}\n**Page**: ${input.finding!.page}\n**Message**: \`${input.finding!.message.slice(0, 200)}\`\n`;
    const traceMd = input.trace.map((s) => `${s.step}. \`${s.intent}\` ${JSON.stringify(s.params)}`).join('\n');
    return `${head}\n## Trace\n\n${traceMd}\n`;
  }
  if(input.kind === 'run') {
    const traceMd = input.trace.map((s) => `${s.step}. \`${s.intent}\` ${JSON.stringify(s.params)}`).join('\n');
    return `# Run\n\n**Goal**: ${input.goal}\n**Status**: completed without findings\n\n## Trace\n\n${traceMd}\n`;
  }
  // kind === 'error'
  return `# Error\n\n**Goal**: ${input.goal}\n**Reason**: ${input.errorReason}\n\nSee \`stderr.log\` for the captured driver output.\n`;
}
```

- [ ] **Step 4: Run all reporter tests** — `pnpm exec vitest run src/tests/explorer/reporter.test.ts src/tests/explorer/reporter-error.test.ts` — 3/3 (2 from F1 + 1 new).

- [ ] **Step 5: Verify lint clean**

```bash
npx eslint scripts/explorer/reporter.ts src/tests/explorer/reporter-error.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add scripts/explorer/reporter.ts src/tests/explorer/reporter-error.test.ts
git commit -m "$(cat <<'EOF'
feat(explorer): reporter kind=error + signature integration

Adds errors/<uuid>/ artifact kind for boot-time crashes that fail before
any intent runs (surfaced as a gap during F1 smoke). Also wires
recordSighting into the finding path so seen-signatures.json is updated
on every FIND-* artifact.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Oracle B — typed expectation schema + driver-side verifier

**Files:**
- Create: `scripts/explorer/oracles/expectations.ts`
- Create: `src/tests/explorer/expectations.test.ts`

Oracle B verifies a typed `Expectation` against the live page state via Playwright vanilla. F2a ships the schema + verifier; F2c will wire it into the autonomous loop. F2a tests use Playwright's `chromium.launch()` with `setContent` to drive synthetic pages — no fuzz harness required for unit tests.

- [ ] **Step 1: Write the failing test**

Create `src/tests/explorer/expectations.test.ts`:

```typescript
import {describe, expect, it, beforeAll, afterAll} from 'vitest';
import {chromium, type Browser, type BrowserContext, type Page} from 'playwright';
import {verifyExpectation, type Expectation} from '../../../scripts/explorer/oracles/expectations';

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

describe('Oracle B — typed expectation verifier', () => {
  it('element_appears resolves true when an element with the hint exists', async() => {
    await pageA.setContent('<button data-testid="send-button">Send</button>');
    const exp: Expectation = {
      type: 'element_appears',
      page: 'A',
      selector_hint: 'send-button',
      timeout_ms: 1000
    };
    const result = await verifyExpectation(exp, {pageA, pageB});
    expect(result.ok).toBe(true);
  });

  it('element_appears resolves false when the element is missing', async() => {
    await pageA.setContent('<div>nothing here</div>');
    const exp: Expectation = {
      type: 'element_appears',
      page: 'A',
      selector_hint: 'send-button',
      timeout_ms: 200
    };
    const result = await verifyExpectation(exp, {pageA, pageB});
    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
  });

  it('text_changes resolves true when the element\'s text contains the expected substring', async() => {
    await pageA.setContent('<div data-testid="status">loading</div>');
    setTimeout(() => {
      pageA.evaluate(() => {
        document.querySelector('[data-testid="status"]')!.textContent = 'ready';
      });
    }, 100);
    const exp: Expectation = {
      type: 'text_changes',
      page: 'A',
      selector_hint: 'status',
      to_contains: 'ready',
      timeout_ms: 2000
    };
    const result = await verifyExpectation(exp, {pageA, pageB});
    expect(result.ok).toBe(true);
  });

  it('count_equals resolves true when the count matches', async() => {
    await pageA.setContent('<ul><li>a</li><li>b</li><li>c</li></ul>');
    const exp: Expectation = {
      type: 'count_equals',
      page: 'A',
      selector_hint: 'li',
      count: 3,
      timeout_ms: 500
    };
    const result = await verifyExpectation(exp, {pageA, pageB});
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it FAILS** — module not found.

- [ ] **Step 3: Implement `scripts/explorer/oracles/expectations.ts`**

```typescript
import type {Page} from 'playwright';
import {resolveSelector} from '../selector-resolver';

export type Expectation =
  | {type: 'element_appears'; page: 'A'|'B'; selector_hint: string; text_contains?: string; timeout_ms: number}
  | {type: 'element_disappears'; page: 'A'|'B'; selector_hint: string; timeout_ms: number}
  | {type: 'text_changes'; page: 'A'|'B'; selector_hint: string; from?: string; to_contains: string; timeout_ms: number}
  | {type: 'navigation_to'; page: 'A'|'B'; url_pattern: string; timeout_ms: number}
  | {type: 'count_equals'; page: 'A'|'B'; selector_hint: string; count: number; timeout_ms: number}
  | {type: 'value_changes'; page: 'A'|'B'; selector_hint: string; expected: string; timeout_ms: number};

export interface VerifyResult {
  ok: boolean;
  reason?: string;
  observed?: {url: string; html_excerpt?: string};
}

export interface Pages {
  pageA: Page;
  pageB: Page;
}

const pickPage = (pages: Pages, p: 'A'|'B'): Page => p === 'A' ? pages.pageA : pages.pageB;

export async function verifyExpectation(exp: Expectation, pages: Pages): Promise<VerifyResult> {
  const page = pickPage(pages, exp.page);
  const deadline = Date.now() + exp.timeout_ms;

  switch(exp.type) {
    case 'element_appears': {
      while(Date.now() < deadline) {
        const loc = await resolveSelector(page, exp.selector_hint);
        if(loc) {
          const count = await loc.count().catch(() => 0);
          if(count > 0) {
            if(exp.text_contains) {
              const text = await loc.textContent().catch(() => '') ?? '';
              if(text.includes(exp.text_contains)) return {ok: true};
            } else {
              return {ok: true};
            }
          }
        }
        await page.waitForTimeout(100);
      }
      return {ok: false, reason: `element_appears hint="${exp.selector_hint}" did not match within ${exp.timeout_ms}ms`};
    }
    case 'element_disappears': {
      while(Date.now() < deadline) {
        const loc = await resolveSelector(page, exp.selector_hint);
        if(!loc) return {ok: true};
        const count = await loc.count().catch(() => 0);
        if(count === 0) return {ok: true};
        await page.waitForTimeout(100);
      }
      return {ok: false, reason: `element_disappears hint="${exp.selector_hint}" still present after ${exp.timeout_ms}ms`};
    }
    case 'text_changes': {
      while(Date.now() < deadline) {
        const loc = await resolveSelector(page, exp.selector_hint);
        if(loc) {
          const text = await loc.textContent().catch(() => '') ?? '';
          if(exp.from && text.includes(exp.from)) {
            await page.waitForTimeout(100);
            continue;
          }
          if(text.includes(exp.to_contains)) return {ok: true};
        }
        await page.waitForTimeout(100);
      }
      return {ok: false, reason: `text_changes to_contains="${exp.to_contains}" not observed within ${exp.timeout_ms}ms`};
    }
    case 'navigation_to': {
      try {
        await page.waitForURL(new RegExp(exp.url_pattern), {timeout: exp.timeout_ms});
        return {ok: true};
      } catch{
        return {ok: false, reason: `navigation_to url_pattern="${exp.url_pattern}" did not occur within ${exp.timeout_ms}ms`, observed: {url: page.url()}};
      }
    }
    case 'count_equals': {
      while(Date.now() < deadline) {
        const candidate = await resolveSelector(page, exp.selector_hint);
        if(candidate) {
          const count = await candidate.count().catch(() => 0);
          if(count === exp.count) return {ok: true};
        }
        await page.waitForTimeout(100);
      }
      return {ok: false, reason: `count_equals expected ${exp.count} elements with hint="${exp.selector_hint}" within ${exp.timeout_ms}ms`};
    }
    case 'value_changes': {
      while(Date.now() < deadline) {
        const loc = await resolveSelector(page, exp.selector_hint);
        if(loc) {
          const value = await loc.inputValue().catch(() => null);
          if(value === exp.expected) return {ok: true};
        }
        await page.waitForTimeout(100);
      }
      return {ok: false, reason: `value_changes expected="${exp.expected}" not observed within ${exp.timeout_ms}ms`};
    }
  }
}
```

- [ ] **Step 4: Run test to verify it PASSES** — 4/4. The test takes ~5-10s because it boots a real browser. This is acceptable for F2a's first browser-using test.

- [ ] **Step 5: Verify lint clean**

```bash
npx eslint scripts/explorer/oracles/expectations.ts src/tests/explorer/expectations.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add scripts/explorer/oracles/expectations.ts src/tests/explorer/expectations.test.ts
git commit -m "$(cat <<'EOF'
feat(explorer): Oracle B typed expectation verifier

Adds the typed Expectation schema (element_appears, element_disappears,
text_changes, navigation_to, count_equals, value_changes) and a
driver-side verifyExpectation() that resolves selectors via the F1
selector-resolver and polls until the timeout. Tests use a real
Playwright browser context (no fuzz harness needed) to cover the four
most common variants.

F2a establishes the verifier; F2c will wire it into the autonomous
loop's per-step expectation declaration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Triage subagent definition

**Files:**
- Create: `.claude/agents/nostra-explorer-triage.md`

The triage subagent reads a candidate finding (expectation failure) and decides whether it's a real bug or an LLM-hallucinated unfounded expectation. F2a creates the definition; F2c will dispatch it from the autonomous loop. F2a does NOT wire it.

- [ ] **Step 1: Create the triage subagent definition**

Create `.claude/agents/nostra-explorer-triage.md`:

```markdown
---
name: nostra-explorer-triage
description: Second-pass triage subagent for the agentic explorer. Receives a candidate finding (expectation that failed against observed page state) and decides whether it represents a real bug or an unfounded LLM expectation. Wired into the explorer autonomous loop in F2c.
tools: Read, Glob, Grep
---

You are the **nostra-explorer-triage subagent**. Your job is to decide whether a single candidate finding is a real bug worth recording, or whether the expectation that triggered it was unfounded (LLM hallucination, wrong assumption about UI behavior, race condition between verifier and page).

## What you receive in the prompt

The orchestrator passes you, in this order:

1. **Goal** of the explorer run (e.g. "edit profile bio with very long string")
2. **Step trace so far** — the sequence of intents that have run, with their atomic_traces
3. **Failed expectation** — typed Expectation object that did not resolve `ok: true`
4. **Observation** — captured page state at the moment of failure: screenshot path, AX tree excerpt, last 50 console lines, current URL
5. **(Optional)** the snippet of the FEATURES.md / domain priming relevant to the goal area

## What you decide

You output exactly ONE JSON object with this schema:

```json
{
  "verdict": "REAL_BUG" | "UNFOUNDED",
  "confidence": 0.0,
  "reasoning": "1-3 sentences",
  "suggested_action": "RECORD_FINDING" | "DISCARD" | "RETRY_WITH_WIDER_TIMEOUT"
}
```

## Rules of thumb (calibrate with these, but use judgment)

- **REAL_BUG signals**: console error matches the observed UI state; the expected element type is documented in FEATURES.md as existing in this flow; the goal explicitly required this UI affordance; multiple iterations on different runs hit the same expectation failure (cross-reference seen-signatures.json mentally).
- **UNFOUNDED signals**: the LLM expected an element with a CSS class that doesn't exist anywhere in the codebase; the expectation was about behavior NOT documented (e.g. "after click, button turns green" with no codebase evidence); the timeout was very short relative to similar successful flows; the goal area is one where the LLM has shown low-confidence guesses before.
- **RETRY_WITH_WIDER_TIMEOUT**: when the expectation looks plausible but the timeout was likely too aggressive (< 1s for an action that involves network/relay).

## Constraints

- You CANNOT modify any file. Tools: Read, Glob, Grep ONLY.
- Stay grounded in the codebase. Use Glob/Grep on `src/components/` and `src/scss/` to verify whether expected selectors / classes exist before declaring REAL_BUG.
- If you say `confidence` ≥ 0.8, you must cite at least one file:line that supports your verdict.
- Output the JSON object as the LAST thing in your response. The orchestrator parses the last JSON block from your output.

## Anti-pattern

Do NOT say "needs more investigation" or "could go either way" — the orchestrator MUST get a binary verdict to act on. If you are genuinely uncertain, choose UNFOUNDED with confidence ≤ 0.6 and let the explorer continue exploring.
```

- [ ] **Step 2: Verify the file is well-formed Markdown frontmatter**

```bash
cd /home/raider/Repository/nostra.chat-wt/explorer-f2a
head -6 .claude/agents/nostra-explorer-triage.md
```

Expected output: opening `---`, name, description, tools, closing `---`.

- [ ] **Step 3: Commit**

```bash
git add .claude/agents/nostra-explorer-triage.md
git commit -m "$(cat <<'EOF'
feat(explorer): triage subagent definition (preparatory for F2c)

Defines the nostra-explorer-triage subagent that will be dispatched in
F2c's autonomous loop on every candidate finding to decide REAL_BUG vs
UNFOUNDED. F2a ships the definition only; loop wiring comes in F2c.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: F2a milestone — verify cumulative state, smoke, commit

**Files:** none (orchestration + verification only).

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
  src/tests/explorer/expectations.test.ts
```

Expected: All unit tests pass. F1 had 16 unit tests; F2a adds 2 (socket-client) + 5 (signature) + 1 (reporter-error) + 4 (expectations) = 12 new = **28 total unit tests**.

- [ ] **Step 2: Verify lint + tsc**

```bash
cd /home/raider/Repository/nostra.chat-wt/explorer-f2a
pnpm lint 2>&1 | tail -3
npx tsc --noEmit 2>&1 | tail -5
npx eslint scripts/explorer/socket-client.ts scripts/explorer/signature.ts \
  scripts/explorer/oracles/expectations.ts scripts/explorer/reporter.ts \
  src/tests/explorer/socket-client.test.ts src/tests/explorer/signature.test.ts \
  src/tests/explorer/reporter-error.test.ts src/tests/explorer/expectations.test.ts \
  2>&1 | tail -3
```

Expected: NO NEW errors beyond baseline (`.test-sign-manifest.mjs` parse + tsconfig TS5107/TS5101). `npx eslint` on F2a files: 0 errors.

- [ ] **Step 3: F1 regression check — manual smoke**

The F2a changes do NOT modify the F1 user-visible flow. The slash command + F1 explorer subagent should still produce a clean run for `/nostra-explore "send a message"`.

If the user is willing to run the manual smoke: instruct them to:
1. `pnpm start` in another terminal (NOT `pnpm preview` — see Task 2 doc fix)
2. In Claude Code: `/nostra-explore "send a message"`
3. Verify a `docs/explorer-reports/runs/<uuid>/` directory is created with `trace.jsonl` + `report.md`
4. Verify NO `seen-signatures.json` is created (F2a only writes it on finding, not on clean run)

This verification is the user's, not the implementer's. Note in your report that the milestone smoke is the user's verification step.

- [ ] **Step 4: F2a milestone commit**

This task adds no new files; the milestone is implicit in the cumulative commits 1-6. Nothing to commit here. Verify the branch state:

```bash
cd /home/raider/Repository/nostra.chat-wt/explorer-f2a
git log --oneline ^main HEAD
```

Expected: 6 commits (one per Task 1-6, plus Task 4 commit if separated, plus Task 6 doc-only commit).

If the implementer prefers to add a milestone marker, an EMPTY commit is appropriate:

```bash
git commit --allow-empty -m "$(cat <<'EOF'
feat(explorer): F2a milestone — foundation extensions complete

F2a delivers:
- Node socket client helper (replaces nc -U improvisation)
- Slash command doc fix (pnpm start, not preview)
- Reporter kind=error for boot crashes + signature integration
- Cross-run signature dedup (seen-signatures.json)
- Oracle B typed expectation verifier
- Triage subagent definition (preparatory)

12 new unit tests; all 28 explorer unit tests pass. F1 user-visible
flow unchanged. F2c will wire the new infrastructure into the
autonomous loop.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

The empty milestone commit is OPTIONAL — if you prefer a clean log without it, skip step 4 entirely.

---

## Self-Review Checklist (run after writing the plan)

1. **Spec coverage (F2a portion only)**:
   - [x] §3 cross-run dedup → Task 3 (signature module)
   - [x] §4 Oracle B typed expectations → Task 5
   - [x] §4 second-pass triage subagent → Task 6 (definition only; wiring is F2c)
   - [x] §5/§6 reporter `kind: 'error'` for boot crashes (gap surfaced by F1 smoke) → Task 4
   - [x] F1 smoke gap "nc -U dropped responses" → Task 1
   - [x] F1 smoke gap "doc says preview but only start works" → Task 2

2. **Out of F2a scope (deferred to F2b/F2c)**:
   - Full intent catalog beyond F1's 6 (media, edge messaging, network/offline, settings) → F2b
   - Oracle D LLM-generated invariants → F2c
   - Autonomous LLM loop with goal-D autonomous selection → F2c
   - Triage subagent dispatch wiring → F2c
   - Per-step expectation declaration in subagent prompt → F2c
   - Auto-fix pipeline (entire F3) → F3

3. **Type consistency**:
   - `SeenStore` from `signature.ts` consumed by `reporter.ts`
   - `Sighting` from `signature.ts` constructed by `reporter.ts`
   - `Expectation` from `oracles/expectations.ts` will be consumed by F2c subagent prompts
   - `ReportInput.kind: 'error'` extends F1's `'finding' | 'run'` — backwards-compatible (F1 callers don't pass `kind: 'error'`)

4. **Placeholder scan**: no "TBD"/"TODO" — verified.

---

## Out of scope for F2a (explicit)

- Oracle D (LLM-generated invariants in vm sandbox) — F2c
- Triage subagent loop wiring — F2c
- Autonomous goal selection (D mode) — F2c
- Per-step expectation declaration in explorer subagent prompt — F2c
- Full intent catalog (media, edge messaging, network/offline, settings) — F2b
- Auto-fix pipeline — F3
- gh CLI / PR creation — F3
- Network/Tor/offline simulation — F3+

These are tracked explicitly in the spec at §6 and will become separate plans:
- `2026-04-30-agentic-explorer-f2b-catalog-expansion.md` (after F2a ships)
- `2026-04-30-agentic-explorer-f2c-autonomous-loop.md` (after F2b ships)
