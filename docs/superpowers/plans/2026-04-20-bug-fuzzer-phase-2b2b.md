# Bug Fuzzer Phase 2b.2b Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 3 carry-forward items from Phase 2b.2a (`FIND-chrono-v2`, `FIND-cold-deleteWhileSending`, `FIND-cold-reactPeerSeesEmoji` + reporter clobber bug), add profile scope to the fuzzer, and emit `baseline-seed42-v2b2.json`.

**Architecture:** Single monolithic PR branched from `origin/main` at `00f8de2e` in worktree `../nostra.chat-wt/2b2b`. Sequential linear task execution (T1→T8). Each task is a single atomic Conventional Commit. Max 1 fix wave per task before carry-forward to Phase 2b.3.

**Tech Stack:** TypeScript 5.7, Vitest, Playwright, Solid.js, Nostr (NIP-17, NIP-25, NIP-44, NIP-59), `tsx` runner for fuzz CLI, ESLint 2-space, `if(` no-space.

**Spec:** [`docs/superpowers/specs/2026-04-20-bug-fuzzer-phase-2b2b-design.md`](../specs/2026-04-20-bug-fuzzer-phase-2b2b-design.md)

---

## Global preconditions (verify before Task 1)

- [ ] **P.1:** Worktree exists at `/home/raider/Repository/nostra.chat-wt/2b2b`, branch `fuzz-phase-2b2b`, `git log -1 origin/main` HEAD matches first parent.
- [ ] **P.2:** `.env.local` copied from main repo into worktree.
- [ ] **P.3:** `pnpm install` ran clean (run from worktree).
- [ ] **P.4:** `pnpm lint` clean, `npx tsc --noEmit` clean, `pnpm test:nostra:quick` ≥ 401 passing, `npx vitest run src/tests/fuzz/` ≥ 63 passing. Record counts as baseline.
- [ ] **P.5:** `pnpm start` runs successfully at `:8080` (needed for T4, T7 fuzz runs — keep in a separate background terminal throughout execution).

---

## Task 1: Reporter parse-preserve-update — fix clobber of curated sections

**Spec reference:** §6.1

**Files:**
- Modify: `src/tests/fuzz/reporter.ts` (lines 1-end)
- Modify: `src/tests/fuzz/reporter.test.ts` (append cases)

**Problem:** `recordFinding()` currently reads `FUZZ-FINDINGS.md`, parses only `### FIND-*` entries via `parseFindingsMarkdown`, then rewrites via `renderFindingsMarkdown(entries)` which emits the standard layout **and discards all curated narrative**: `### Fixed in Phase 2b.2a` headings, `### Fixed in Phase 2b.1` headings, carry-forward notes inside Open entries, anything that isn't a parseable `### FIND-` header.

**Target:** Preserve byte-for-byte everything except the entries inside `## Open`. Update those in-place (bump occurrences / add new / skip if signature found in Fixed).

- [ ] **Step 1.1: Write failing test for zone split**

Add to `src/tests/fuzz/reporter.test.ts` before the existing `describe('markdown round-trip')` block:

```typescript
import {describe, it, expect} from 'vitest';
import {splitFindingsZones, mergeFindings, writeFindingsMarkdownPure} from './reporter';

describe('splitFindingsZones', () => {
  it('splits prelude / open / postlude on curated markdown', () => {
    const md = [
      '# Fuzz Findings',
      '',
      'Last updated: 2026-04-20',
      'Open bugs: 1 · Fixed: 1',
      '',
      '## Open (sorted by occurrences desc)',
      '',
      '### FIND-aaaaaaaa — INV-foo',
      '- **Status**: open',
      '- **Tier**: cheap',
      '- **Occurrences**: 2',
      '- **First seen**: 2026-04-19 12:00:00',
      '- **Last seen**: 2026-04-19 13:00:00',
      '- **Seed**: 42',
      '- **Assertion**: "boom"',
      '- **Replay**: `pnpm fuzz --replay=FIND-aaaaaaaa`',
      '- **Minimal trace** (1 actions):',
      '  1. `sendText({"from":"userA","text":"hi"})`',
      '- **Artifacts**: [`docs/fuzz-reports/FIND-aaaaaaaa/`](../fuzz-reports/FIND-aaaaaaaa/)',
      '',
      '## Fixed',
      '',
      '### Fixed in Phase 2b.2a',
      '',
      '#### FIND-bbbbbbbb — INV-bar',
      '- **Status**: fixed in Phase 2b.2a',
      '- narrative here that must survive',
      ''
    ].join('\n');
    const {prelude, openEntries, postlude} = splitFindingsZones(md);
    expect(prelude).toContain('# Fuzz Findings');
    expect(prelude).toContain('## Open (sorted by occurrences desc)');
    expect(openEntries.length).toBe(1);
    expect(openEntries[0].signature).toBe('aaaaaaaa');
    expect(postlude).toContain('## Fixed');
    expect(postlude).toContain('### Fixed in Phase 2b.2a');
    expect(postlude).toContain('narrative here that must survive');
  });

  it('empty string returns default prelude + empty open + empty postlude', () => {
    const {prelude, openEntries, postlude} = splitFindingsZones('');
    expect(prelude.length).toBeGreaterThan(0);
    expect(openEntries.length).toBe(0);
    expect(postlude).toBe('');
  });

  it('file with no Fixed section returns empty postlude', () => {
    const md = [
      '# Fuzz Findings',
      '',
      '## Open (sorted by occurrences desc)',
      '',
      '### FIND-aaaaaaaa — INV-x',
      '- **Status**: open',
      '- **Tier**: cheap',
      '- **Occurrences**: 1',
      '- **First seen**: 2026-04-19 12:00:00',
      '- **Last seen**: 2026-04-19 12:00:00',
      '- **Seed**: 42',
      '- **Assertion**: "x"',
      '',
      ''
    ].join('\n');
    const {openEntries, postlude} = splitFindingsZones(md);
    expect(openEntries.length).toBe(1);
    expect(postlude).toBe('');
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `cd /home/raider/Repository/nostra.chat-wt/2b2b && npx vitest run src/tests/fuzz/reporter.test.ts`
Expected: FAIL with `splitFindingsZones is not exported from './reporter'`

- [ ] **Step 1.3: Implement `splitFindingsZones` in reporter.ts**

At the bottom of `src/tests/fuzz/reporter.ts` (before `recordFinding`), add:

```typescript
const DEFAULT_PRELUDE = [
  '# Fuzz Findings',
  '',
  '## Open (sorted by occurrences desc)',
  '',
  ''
].join('\n');

export interface FindingsZones {
  prelude: string;
  openEntries: ReportEntry[];
  postlude: string;
}

export function splitFindingsZones(md: string): FindingsZones {
  if(md.trim().length === 0) {
    return {prelude: DEFAULT_PRELUDE, openEntries: [], postlude: ''};
  }
  // Locate `## Open` heading
  const openHeadingRe = /^##\s+Open\b.*$/m;
  const openMatch = openHeadingRe.exec(md);
  if(!openMatch) {
    // No Open section — treat entire file as prelude, no entries
    return {prelude: md, openEntries: [], postlude: ''};
  }
  const openStartIdx = openMatch.index + openMatch[0].length;
  // Locate `## Fixed` heading (end of Open)
  const fixedHeadingRe = /^##\s+Fixed\b.*$/m;
  const openBodyAndMore = md.slice(openStartIdx);
  const fixedMatch = fixedHeadingRe.exec(openBodyAndMore);
  let openBody: string;
  let postlude: string;
  if(fixedMatch) {
    openBody = openBodyAndMore.slice(0, fixedMatch.index);
    postlude = openBodyAndMore.slice(fixedMatch.index);
  } else {
    openBody = openBodyAndMore;
    postlude = '';
  }
  const prelude = md.slice(0, openStartIdx) + (openBody.startsWith('\n') ? '' : '\n');
  const openEntries = parseFindingsMarkdown(openBody);
  return {prelude: md.slice(0, openStartIdx), openEntries, postlude};
}
```

- [ ] **Step 1.4: Run test to verify passes**

Run: `npx vitest run src/tests/fuzz/reporter.test.ts`
Expected: PASS (3 new cases green)

- [ ] **Step 1.5: Write failing test for mergeFindings**

Append to `reporter.test.ts`:

```typescript
describe('mergeFindings', () => {
  const now = '2026-04-20 10:00:00';
  const baseEntry = (sig: string, occ: number): ReportEntry => ({
    signature: sig,
    invariantId: 'INV-x',
    tier: 'cheap',
    assertion: 'boom',
    occurrences: occ,
    firstSeen: '2026-04-19 12:00:00',
    lastSeen: '2026-04-19 12:00:00',
    seed: 42,
    minimalTrace: [],
    status: 'open'
  });

  it('bumps occurrences for existing signature', () => {
    const existing = [baseEntry('aaaaaaaa', 3)];
    const merged = mergeFindings(existing, [{signature: 'aaaaaaaa', invariantId: 'INV-x', tier: 'cheap', assertion: 'boom', seed: 42, minimalTrace: []}], new Set<string>(), now);
    expect(merged.length).toBe(1);
    expect(merged[0].occurrences).toBe(4);
    expect(merged[0].lastSeen).toBe(now);
    expect(merged[0].firstSeen).toBe('2026-04-19 12:00:00'); // preserved
  });

  it('appends new signature', () => {
    const existing = [baseEntry('aaaaaaaa', 1)];
    const merged = mergeFindings(existing, [{signature: 'bbbbbbbb', invariantId: 'INV-y', tier: 'cheap', assertion: 'other', seed: 42, minimalTrace: []}], new Set<string>(), now);
    expect(merged.length).toBe(2);
    expect(merged.find((e) => e.signature === 'bbbbbbbb')!.firstSeen).toBe(now);
    expect(merged.find((e) => e.signature === 'bbbbbbbb')!.occurrences).toBe(1);
  });

  it('skips signature already in Fixed set', () => {
    const existing: ReportEntry[] = [];
    const fixed = new Set<string>(['cccccccc']);
    const merged = mergeFindings(existing, [{signature: 'cccccccc', invariantId: 'INV-z', tier: 'cheap', assertion: 'should-skip', seed: 42, minimalTrace: []}], fixed, now);
    expect(merged.length).toBe(0);
  });
});
```

- [ ] **Step 1.6: Run test to verify fails**

Run: `npx vitest run src/tests/fuzz/reporter.test.ts`
Expected: FAIL with `mergeFindings is not exported`

- [ ] **Step 1.7: Implement mergeFindings**

Add below `splitFindingsZones` in `reporter.ts`:

```typescript
export interface IncomingFinding {
  signature: string;
  invariantId: string;
  tier: ReportEntry['tier'];
  assertion: string;
  seed: number;
  minimalTrace: Action[];
}

export function mergeFindings(
  existingOpen: ReportEntry[],
  incoming: IncomingFinding[],
  fixedSignatures: Set<string>,
  now: string
): ReportEntry[] {
  const byId = new Map<string, ReportEntry>();
  for(const e of existingOpen) byId.set(e.signature, e);
  for(const f of incoming) {
    if(fixedSignatures.has(f.signature)) continue;
    const prev = byId.get(f.signature);
    if(prev) {
      prev.occurrences += 1;
      prev.lastSeen = now;
    } else {
      byId.set(f.signature, {
        signature: f.signature,
        invariantId: f.invariantId,
        tier: f.tier,
        assertion: f.assertion,
        occurrences: 1,
        firstSeen: now,
        lastSeen: now,
        seed: f.seed,
        minimalTrace: f.minimalTrace,
        status: 'open'
      });
    }
  }
  return [...byId.values()].sort((a, b) => b.occurrences - a.occurrences);
}

export function parseFixedSignatures(postlude: string): Set<string> {
  const out = new Set<string>();
  const re = /(?:^|\n)(?:####?)\s+FIND-([0-9a-f]{8})\b/g;
  let m: RegExpExecArray | null;
  while((m = re.exec(postlude)) !== null) out.add(m[1]);
  return out;
}
```

Note: `parseFixedSignatures` matches `### FIND-xxxx` **or** `#### FIND-xxxx` because curated Fixed subsections use `####` (nested under `### Fixed in Phase X`).

- [ ] **Step 1.8: Run test to verify passes**

Run: `npx vitest run src/tests/fuzz/reporter.test.ts`
Expected: PASS (all 6 cases green)

- [ ] **Step 1.9: Write failing test for writeFindingsMarkdownPure integration**

Append:

```typescript
describe('writeFindingsMarkdownPure (end-to-end string transform)', () => {
  it('preserves Fixed subsection byte-for-byte when adding a new Open finding', () => {
    const existing = [
      '# Fuzz Findings',
      '',
      '## Open (sorted by occurrences desc)',
      '',
      '## Fixed',
      '',
      '### Fixed in Phase 2b.2a',
      '',
      '#### FIND-aaaaaaaa — INV-foo',
      '- **Status**: fixed in Phase 2b.2a',
      '- Long narrative explaining the fix that MUST survive.',
      '  - Multi-line bullet.',
      ''
    ].join('\n');
    const incoming: IncomingFinding = {
      signature: 'cccccccc',
      invariantId: 'INV-new',
      tier: 'cheap',
      assertion: 'new bug',
      seed: 99,
      minimalTrace: [{name: 'sendText', args: {from: 'userA', text: 'z'}}]
    };
    const result = writeFindingsMarkdownPure(existing, [incoming], '2026-04-20 10:00:00');
    expect(result).toContain('### Fixed in Phase 2b.2a');
    expect(result).toContain('Long narrative explaining the fix that MUST survive.');
    expect(result).toContain('#### FIND-aaaaaaaa');
    expect(result).toContain('### FIND-cccccccc — INV-new');
  });

  it('does not re-add finding whose signature is in Fixed', () => {
    const existing = [
      '# Fuzz Findings',
      '',
      '## Open (sorted by occurrences desc)',
      '',
      '## Fixed',
      '',
      '### Fixed in Phase 2b.2a',
      '',
      '#### FIND-cccccccc — INV-old',
      ''
    ].join('\n');
    const incoming: IncomingFinding = {
      signature: 'cccccccc',
      invariantId: 'INV-old',
      tier: 'cheap',
      assertion: 'recurring',
      seed: 99,
      minimalTrace: []
    };
    const result = writeFindingsMarkdownPure(existing, [incoming], '2026-04-20 10:00:00');
    // Should not add FIND-cccccccc to Open
    const openStart = result.indexOf('## Open');
    const fixedStart = result.indexOf('## Fixed');
    const openSection = result.slice(openStart, fixedStart);
    expect(openSection).not.toContain('### FIND-cccccccc');
  });
});
```

- [ ] **Step 1.10: Run test to verify fails**

Run: `npx vitest run src/tests/fuzz/reporter.test.ts`
Expected: FAIL with `writeFindingsMarkdownPure is not exported`

- [ ] **Step 1.11: Implement writeFindingsMarkdownPure**

Append to `reporter.ts`:

```typescript
export function writeFindingsMarkdownPure(
  existing: string,
  incoming: IncomingFinding[],
  now: string
): string {
  const {prelude, openEntries, postlude} = splitFindingsZones(existing);
  const fixedSigs = parseFixedSignatures(postlude);
  const merged = mergeFindings(openEntries, incoming, fixedSigs, now);
  const openRendered = merged.flatMap(renderEntry).join('\n');
  // Ensure a trailing newline between open body and postlude heading
  const openBlock = openRendered.length > 0 ? openRendered + '\n' : '';
  return prelude + openBlock + postlude;
}
```

- [ ] **Step 1.12: Run test to verify passes**

Run: `npx vitest run src/tests/fuzz/reporter.test.ts`
Expected: PASS (all 8 cases green)

- [ ] **Step 1.13: Wire writeFindingsMarkdownPure into recordFinding**

Replace the body of `recordFinding` in `src/tests/fuzz/reporter.ts` (the block inside `try{ ... }`) with:

```typescript
    const md = existsSync(FINDINGS_PATH) ? readFileSync(FINDINGS_PATH, 'utf8') : '';
    const {openEntries} = splitFindingsZones(md);
    const existing = openEntries.find((e) => e.signature === signature);
    const isNew = !existing;
    const incoming: IncomingFinding = {
      signature,
      invariantId: f.invariantId,
      tier: f.tier,
      assertion: f.message,
      seed,
      minimalTrace
    };
    const nextMd = writeFindingsMarkdownPure(md, [incoming], now);
    writeFileSync(FINDINGS_PATH, nextMd, 'utf8');
    if(isNew && ctx) await writeArtifacts(signature, f, minimalTrace, seed, ctx);
    return {signature, isNew};
```

Remove the now-unused imports / helper calls that referenced `parseFindingsMarkdown` + `renderFindingsMarkdown` directly in `recordFinding` (keep both functions exported — still used by pure helpers and tests).

- [ ] **Step 1.14: Run full fuzz vitest suite**

Run: `npx vitest run src/tests/fuzz/`
Expected: PASS, count ≥ 63 (baseline) + 8 new cases in reporter.test.ts

- [ ] **Step 1.15: Manual smoke — fuzzer run preserves curation**

Pre: ensure `docs/FUZZ-FINDINGS.md` at HEAD has the curated Fixed sections (from `origin/main`).

Run: `pnpm fuzz --duration=30s --seed=42` (requires `pnpm start` background).

Check: `git diff docs/FUZZ-FINDINGS.md`. Expected: ONLY changes to `Last updated:` timestamp + `Last seen` fields of existing Open findings and/or appended new Open entries. **Fixed subsections must be byte-for-byte unchanged** (no modifications to `### Fixed in Phase 2b.2a`, `### Fixed in Phase 2b.1`, narrative text, etc.).

If the diff shows anything in `## Fixed`: **FAIL** — investigate splitFindingsZones (likely a regex edge case).

- [ ] **Step 1.16: Commit**

```bash
cd /home/raider/Repository/nostra.chat-wt/2b2b
git add src/tests/fuzz/reporter.ts src/tests/fuzz/reporter.test.ts
git commit -m "fix(fuzz): reporter preserves curated Fixed sections via parse-merge

- Introduce splitFindingsZones / mergeFindings / writeFindingsMarkdownPure.
- recordFinding now preserves prelude + postlude byte-for-byte, updates only Open entries.
- Skip re-adding findings whose signature already appears in Fixed.
- Adds 8 Vitest cases covering zone split, merge semantics, end-to-end string transform."
```

Revert any working-tree change to `docs/FUZZ-FINDINGS.md` from the smoke run: `git checkout docs/FUZZ-FINDINGS.md` (the change was last-seen timestamp, not a finding — intentional restore).

---

## Task 2: Multi-kind deterministic warmup handshake in bootHarness

**Spec reference:** §6.2

**Files:**
- Modify: `src/tests/fuzz/harness.ts` (add `warmupHandshake` + helpers, call from `bootHarness` after `linkContacts`)
- Grep + remove any `actionIndex < N` cold-start guards introduced in 2b.2a

**Closes:** `FIND-cold-deleteWhileSending`, `FIND-cold-reactPeerSeesEmoji` (both in FUZZ-FINDINGS.md Open).

- [ ] **Step 2.1: Identify cold-start guards to remove**

Run: `grep -rn 'actionIndex < \|cold.*start\|cold-start' src/tests/fuzz/`
Record all hits. These are the guards added in 2b.2a as stop-gaps; they must be removed in Step 2.10 after warmup is wired.

- [ ] **Step 2.2: Add warmupHandshake signature**

Edit `src/tests/fuzz/harness.ts`. After the `injectContact` function (near line 150), add:

```typescript
async function warmupHandshake(a: UserHandle, b: UserHandle): Promise<void> {
  log('warmup: A→B text → B→A react → A→B delete → drain');
  const warmupText = `__warmup_${Date.now()}__`;
  await sendTextViaUI(a, b, warmupText);
  await waitForBubbleOnPeer(b, warmupText, 15000);
  log('warmup: step 1 (text) ack');
  await reactToBubbleViaUI(b, warmupText, '👍');
  await waitForReactionOnPeer(a, warmupText, '👍', 15000);
  log('warmup: step 2 (react) ack');
  await deleteBubbleViaUI(a, warmupText);
  await waitForBubbleAbsenceOnPeer(b, warmupText, 15000);
  log('warmup: step 3 (delete) ack');
  await a.page.waitForTimeout(500);
  log('warmup: drain complete');
}
```

- [ ] **Step 2.3: Add helpers sendTextViaUI / reactToBubbleViaUI / deleteBubbleViaUI / waitFor*OnPeer**

Below `warmupHandshake`, add helpers. Use the selectors the real fuzz actions in `src/tests/fuzz/actions/messaging.ts` use (consult that file first to match selector conventions — re-use them, do not fork).

```typescript
async function sendTextViaUI(self: UserHandle, peer: UserHandle, text: string): Promise<void> {
  // Navigate self's chat to peer if not already open
  await openChatWith(self, peer.remotePeerId);
  const input = self.page.locator('.input-message-input[contenteditable="true"]').first();
  await input.click();
  await input.type(text, {delay: 10});
  await self.page.keyboard.press('Enter');
}

async function reactToBubbleViaUI(self: UserHandle, bubbleText: string, emoji: string): Promise<void> {
  const bubble = self.page.locator(`.bubble:has-text("${bubbleText}")`).first();
  await bubble.click({button: 'right', timeout: 5000});
  const picker = self.page.locator('.reactions-picker, [data-test="reactions-picker"]').first();
  await picker.waitFor({state: 'visible', timeout: 5000});
  await picker.getByText(emoji).click({timeout: 5000});
  await self.page.keyboard.press('Escape').catch(() => {});
}

async function deleteBubbleViaUI(self: UserHandle, bubbleText: string): Promise<void> {
  const bubble = self.page.locator(`.bubble:has-text("${bubbleText}")`).first();
  await bubble.click({button: 'right', timeout: 5000});
  const menuItem = self.page.locator('.btn-menu-item:has-text("Delete")').first();
  await menuItem.click({timeout: 5000});
  const confirm = self.page.locator('button:has-text("Delete")').last();
  await confirm.click({timeout: 5000}).catch(() => {});
}

async function openChatWith(self: UserHandle, remotePeerId: number): Promise<void> {
  const dialog = self.page.locator(`.chatlist-chat[data-peer-id="${remotePeerId}"]`).first();
  if(await dialog.count() > 0) await dialog.click();
  await self.page.waitForTimeout(500);
}

async function waitForBubbleOnPeer(peer: UserHandle, text: string, timeoutMs: number): Promise<void> {
  await peer.page.locator(`.bubble:has-text("${text}")`).first().waitFor({state: 'visible', timeout: timeoutMs});
}

async function waitForBubbleAbsenceOnPeer(peer: UserHandle, text: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while(Date.now() - start < timeoutMs) {
    const count = await peer.page.locator(`.bubble:has-text("${text}")`).count();
    if(count === 0) return;
    await peer.page.waitForTimeout(250);
  }
  throw new Error(`bubble "${text}" still visible on peer after ${timeoutMs}ms`);
}

async function waitForReactionOnPeer(peer: UserHandle, bubbleText: string, emoji: string, timeoutMs: number): Promise<void> {
  await peer.page
    .locator(`.bubble:has-text("${bubbleText}") .reactions:has-text("${emoji}")`)
    .first()
    .waitFor({state: 'visible', timeout: timeoutMs});
}
```

**Important:** If the actual selectors in `actions/messaging.ts` differ, re-use those. Do not hardcode a second copy.

- [ ] **Step 2.4: Wire warmupHandshake into bootHarness**

In `bootHarness`, after `await linkContacts(userA, userB)` (line 49 area), add:

```typescript
  await warmupHandshake(userA, userB);
```

- [ ] **Step 2.5: Type safety — reloadTimes + consoleLog arrays**

Verify `UserHandle` still lint-clean. If `warmupHandshake` triggers TS7018 on any inferred `[]`, explicitly annotate (`const reloadTimes: number[] = []`). Already done per prior operational note — verify no regression.

- [ ] **Step 2.6: Lint + typecheck**

```bash
pnpm lint
npx tsc --noEmit
```

Both must be clean.

- [ ] **Step 2.7: Run Vitest fuzz suite**

Run: `npx vitest run src/tests/fuzz/`
Expected: PASS at ≥ 63 (same as before; warmup has no Vitest coverage — it's an integration-level change).

- [ ] **Step 2.8: Smoke — warmup actually runs in live fuzz boot**

Run: `pnpm fuzz --duration=60s --seed=42` (requires `pnpm start`).

Grep the output for warmup markers:
```
[harness] warmup: step 1 (text) ack
[harness] warmup: step 2 (react) ack
[harness] warmup: step 3 (delete) ack
[harness] warmup: drain complete
```

All four must appear before the first fuzz action executes.

- [ ] **Step 2.9: Replay cold-start FINDs 10× each**

Run each 10 times, expect 10/10 pass:

```bash
for i in 1 2 3 4 5 6 7 8 9 10; do pnpm fuzz --replay=FIND-cold-deleteWhileSending || break; done
for i in 1 2 3 4 5 6 7 8 9 10; do pnpm fuzz --replay=FIND-cold-reactPeerSeesEmoji || break; done
```

If either shows a failure: investigate; max 1 fix wave (per §4 decision #3) then carry-forward.

- [ ] **Step 2.10: Remove cold-start guards**

Using the list from Step 2.1, remove every `actionIndex < N` / cold-start guard. Each removal should be a single-line or block deletion; verify no dangling `if` bodies.

Re-run: `npx vitest run src/tests/fuzz/` → still passes.
Re-run: `pnpm fuzz --duration=3m --seed=42` → no regressions, 0 findings in first 10 actions (warmup now carries the load).

- [ ] **Step 2.11: Mark FINDs as Fixed in FUZZ-FINDINGS.md**

Manually move `FIND-cold-deleteWhileSending` and `FIND-cold-reactPeerSeesEmoji` from `## Open` to a new `### Fixed in Phase 2b.2b` subsection under `## Fixed`. Include root cause + fix summary + regression link.

- [ ] **Step 2.12: Commit**

```bash
git add src/tests/fuzz/harness.ts docs/FUZZ-FINDINGS.md
git commit -m "fix(fuzz): deterministic bidirectional multi-kind warmup in bootHarness

- warmupHandshake exercises kinds 1059/7/5 via real UI flow before first fuzz action.
- Waits for DOM confirmation at each step (15s each).
- Removes prior actionIndex<N cold-start guards.
- Closes FIND-cold-deleteWhileSending, FIND-cold-reactPeerSeesEmoji."
```

---

## Task 3: chrono-v2 — `mid` tiebreaker in P2P bubble sort

**Spec reference:** §6.3

**Files:**
- Modify: `src/components/chat/bubbleGroups.ts` (`insertSomething` callers or introduce custom comparator path)
- Modify: `src/tests/fuzz/invariants/bubbles.test.ts` (append regression case)

**Closes:** `FIND-chrono-v2`.

- [ ] **Step 3.1: Read current insertSomething behavior**

Read `src/components/chat/bubbleGroups.ts` around lines 640-670 (the `addItem` / `removeItem` methods) plus the top-of-file `insertSomething` helper. Note: `insertSomething(array, item, sortKey, reverse)` takes a **single** sort key. Same-second collisions ignore `mid`.

- [ ] **Step 3.2: Write failing regression test**

Append to `src/tests/fuzz/invariants/bubbles.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
// If the invariant is importable standalone, import it; else replicate the
// comparator logic. Prefer importing the invariant check function.

describe('INV-bubble-chronological — FIND-chrono-v2 regression', () => {
  // Three items with identical timestamp but distinct mid; insertion order
  // is reversed from expected. After sort, must land in descending mid.
  it('sorts same-timestamp items by mid desc deterministically', () => {
    const items = [
      {mid: 100, timestamp: 1712345678},
      {mid: 300, timestamp: 1712345678},
      {mid: 200, timestamp: 1712345678}
    ];
    // Sort comparator under test (replicate the P2P path)
    items.sort((a, b) => {
      if(a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
      return b.mid - a.mid;
    });
    expect(items.map((i) => i.mid)).toEqual([300, 200, 100]);
  });

  it('is deterministic across 20 runs', () => {
    for(let run = 0; run < 20; run++) {
      const shuffled = [
        {mid: 100, timestamp: 1712345678},
        {mid: 300, timestamp: 1712345678},
        {mid: 200, timestamp: 1712345678}
      ].sort(() => Math.random() - 0.5);
      shuffled.sort((a, b) => {
        if(a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
        return b.mid - a.mid;
      });
      expect(shuffled.map((i) => i.mid)).toEqual([300, 200, 100]);
    }
  });
});
```

- [ ] **Step 3.3: Run test — must pass**

Run: `npx vitest run src/tests/fuzz/invariants/bubbles.test.ts`
Expected: PASS (these tests cover the target behavior we want — they will fail only if the codepath we later modify diverges from this comparator).

**Note**: these are self-contained comparator tests. To actually exercise `insertSomething`, we add an integration step later.

- [ ] **Step 3.4: Modify bubbleGroups.ts — introduce P2P two-key comparator**

In `src/components/chat/bubbleGroups.ts`:

Find the constructor block setting `sortItemsKey` (line ~383). Add a field `_p2pComparator` and the insertion branch. The minimal-invasive approach:

1. At the class field area (~line 367-370), add:

```typescript
  private _isP2P: boolean = false;
```

2. Inside the constructor, after setting `sortItemsKey`/`sortGroupsKey`:

```typescript
      this._isP2P = isP2P;
```

3. Find the callsites of `insertSomething(array, item, this.sortItemsKey, ...)`. For P2P, use a custom comparator. Approach: create a helper method `insertGroupItem(arr, item)`:

```typescript
  private insertGroupItem(arr: GroupItem[], item: GroupItem): number {
    if(this._isP2P) {
      return insertSomethingWithTiebreak<GroupItem>(
        arr,
        item,
        'timestamp',
        'mid',
        this.reverse = item.reverse
      );
    }
    return insertSomething(arr, item, this.sortItemsKey, this.reverse = item.reverse);
  }
```

4. Add `insertSomethingWithTiebreak` near the existing `insertSomething` at the top of the file:

```typescript
function insertSomethingWithTiebreak<T>(
  to: Array<T>,
  what: T,
  primaryKey: keyof T,
  secondaryKey: keyof T,
  reverse: boolean
): number {
  if(reverse) {
    // For ASCENDING insertion (reverse=true): primary asc, then secondary asc
    let i = 0;
    while(i < to.length && (
      (to[i] as any)[primaryKey] < (what as any)[primaryKey] ||
      ((to[i] as any)[primaryKey] === (what as any)[primaryKey] && (to[i] as any)[secondaryKey] < (what as any)[secondaryKey])
    )) i++;
    to.splice(i, 0, what);
    return i;
  }
  // DESCENDING insertion: primary desc, then secondary desc
  let i = 0;
  while(i < to.length && (
    (to[i] as any)[primaryKey] > (what as any)[primaryKey] ||
    ((to[i] as any)[primaryKey] === (what as any)[primaryKey] && (to[i] as any)[secondaryKey] > (what as any)[secondaryKey])
  )) i++;
  to.splice(i, 0, what);
  return i;
}
```

5. Replace the previous `insertSomething(array, item, this.sortItemsKey, ...)` callsite in `addItem` (near line 658) with `this.insertGroupItem(array, item)`.

- [ ] **Step 3.5: Lint + typecheck**

```bash
pnpm lint
npx tsc --noEmit
```

Both must be clean.

- [ ] **Step 3.6: Run Vitest — all still pass**

Run: `npx vitest run src/tests/fuzz/invariants/bubbles.test.ts`
Expected: PASS (3 existing bubbles tests + 2 new chrono-v2 tests)

Run: `npx vitest run src/tests/nostra/`
Expected: ≥401 passing.

- [ ] **Step 3.7: Replay FIND-eef9f130 10 times**

Run: `for i in 1 2 3 4 5 6 7 8 9 10; do pnpm fuzz --replay=FIND-eef9f130 || echo FAIL; done`
Expected: all 10 pass (previously flaked ~40%).

- [ ] **Step 3.8: Mark FIND-chrono-v2 as Fixed in FUZZ-FINDINGS.md**

Move entry from Open to `### Fixed in Phase 2b.2b` (same subsection created in Task 2 step 2.11). Add root cause + fix ref.

- [ ] **Step 3.9: Commit**

```bash
git add src/components/chat/bubbleGroups.ts src/tests/fuzz/invariants/bubbles.test.ts docs/FUZZ-FINDINGS.md
git commit -m "fix(nostra): bubble chronological order — mid tiebreaker on same-second ties

P2P peers can produce bubbles with identical timestamps; the single-key
sort collapsed to non-deterministic insertion order. Add insertSomethingWithTiebreak
using (timestamp, mid) both desc. Closes FIND-chrono-v2."
```

---

## Task 4: Baseline v2b1 smoke-run (no commit, verification only)

**Spec reference:** §6.6 (pre-check before v2b2 emit)

Per §4 decision #2, v2b1 is **NOT** committed. Task 4 only verifies `findings === 0` on a 6-min run against the current fuzzer action registry before profile additions.

- [ ] **Step 4.1: Clean run**

Ensure:
- `pnpm start` is running at `:8080`
- `git status` in worktree is clean
- Any prior fuzz runs' working-tree diff on `docs/FUZZ-FINDINGS.md` is restored

- [ ] **Step 4.2: Execute smoke**

Run: `pnpm fuzz --duration=6m --max-commands=40 --seed=42 2>&1 | tee /tmp/2b2b-t4-smoke.log`

- [ ] **Step 4.3: Verify exit**

Expected in output:
- `findings: 0` (or equivalent success sentinel printed by the fuzzer)
- Exit code 0

If findings > 0:
- Per §4 decision #3 fix-wave cap: max 1 wave. Investigate root cause, if surgical fix applicable, apply and re-run Step 4.2. If 2nd run still fails: carry-forward newly surfaced FINDs to Phase 2b.3, document in FUZZ-FINDINGS.md Open, and **do not block** the PR — proceed to Task 5. Baseline gate is evaluated at T7.

- [ ] **Step 4.4: Record metadata**

Append to `/tmp/2b2b-t4-smoke.log` summary to a file you'll paste into the PR body later:

```
T4 smoke-run @ $(date -Iseconds)
Duration: 6m
Seed: 42
Max commands: 40
Findings: <0 or N>
Exit code: <0 or nonzero>
```

No commit in T4 (verification only).

---

## Task 5: reactViaUI fuzz action + INV-reactions-picker-nonempty

**Spec reference:** §6.4

**Files:**
- Create: `src/tests/fuzz/actions/reactions.ts` (new file)
- Modify: `src/tests/fuzz/actions/index.ts` (register new action)
- Create: `src/tests/fuzz/invariants/reactions-ui.ts` (new invariant)
- Modify: `src/tests/fuzz/invariants/index.ts` (register)
- Create: `src/tests/fuzz/actions/reactions.test.ts` (if not already present; the grep showed `invariants/reactions.test.ts` exists, but no `actions/reactions.test.ts`)

- [ ] **Step 5.1: Inspect existing action structure**

Read `src/tests/fuzz/actions/index.ts` to see how existing actions (messaging, lifecycle, navigation) register. Follow the same pattern.

Read `src/tests/fuzz/actions/messaging.ts` to confirm how `reactRandomBubble` (or equivalent manager-proxy action) works. The new `reactViaUI` must use Playwright clicks, not manager-proxy.

- [ ] **Step 5.2: Write failing Vitest for action generator determinism**

Create `src/tests/fuzz/actions/reactions.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
import {reactViaUIAction} from './reactions';

describe('reactViaUIAction', () => {
  it('has stable name', () => {
    expect(reactViaUIAction.name).toBe('reactViaUI');
  });

  it('gen returns null when no suitable bubble', () => {
    const mockState = {pickRandomBubble: () => null};
    const mockRng = {pick: <T>(arr: T[]) => arr[0]};
    // @ts-expect-error mocked
    const args = reactViaUIAction.gen(mockRng, mockState);
    expect(args).toBeNull();
  });

  it('gen returns valid args when bubble exists', () => {
    const mockState = {pickRandomBubble: () => ({mid: 42})};
    const mockRng = {pick: <T>(arr: T[]) => arr[0]};
    // @ts-expect-error mocked
    const args = reactViaUIAction.gen(mockRng, mockState);
    expect(args).toMatchObject({user: 'userA', emoji: expect.any(String), mid: 42});
  });
});
```

- [ ] **Step 5.3: Run test — fail**

Run: `npx vitest run src/tests/fuzz/actions/reactions.test.ts`
Expected: FAIL with `Cannot find module './reactions'`

- [ ] **Step 5.4: Implement reactViaUIAction**

Create `src/tests/fuzz/actions/reactions.ts`:

```typescript
import type {FuzzAction, FuzzContext} from '../types';

const EMOJIS = ['👍', '❤️', '😂', '🎉', '😮'];

export const reactViaUIAction: FuzzAction = {
  name: 'reactViaUI',
  weight: 1.0,
  gen: (rng: any, state: any) => {
    const user = rng.pick(['userA', 'userB']);
    const emoji = rng.pick(EMOJIS);
    const target = state.pickRandomBubble(user, {allowOwn: false});
    if(!target) return null;
    return {user, emoji, mid: target.mid};
  },
  execute: async (ctx: FuzzContext, args: {user: string; emoji: string; mid: number}) => {
    const u = ctx.users[args.user as 'userA' | 'userB'];
    const bubble = u.page.locator(`[data-mid="${args.mid}"]`).first();
    await bubble.waitFor({state: 'visible', timeout: 3000});
    await bubble.click({button: 'right', timeout: 5000});
    const picker = u.page.locator('.reactions-picker, [data-test="reactions-picker"]').first();
    await picker.waitFor({state: 'visible', timeout: 3000});
    const button = picker.getByText(args.emoji).first();
    await button.click({timeout: 3000});
    await u.page.keyboard.press('Escape').catch(() => {});
  }
};
```

**Note:** `FuzzAction` / `FuzzContext` shapes may differ; read `src/tests/fuzz/types.ts` first and match. If `gen` expects different types, adapt without changing intent.

- [ ] **Step 5.5: Run test — pass**

Run: `npx vitest run src/tests/fuzz/actions/reactions.test.ts`
Expected: PASS.

- [ ] **Step 5.6: Register in actions/index.ts**

Edit `src/tests/fuzz/actions/index.ts`. Import and add `reactViaUIAction` to the exported actions list. Follow existing registration pattern verbatim.

- [ ] **Step 5.7: Write failing test for INV-reactions-picker-nonempty**

Create `src/tests/fuzz/invariants/reactions-ui.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
import {invReactionsPickerNonempty} from './reactions-ui';

describe('INV-reactions-picker-nonempty', () => {
  it('fails when picker exists with 0 emoji children', () => {
    const mockPage = {
      locator: () => ({
        count: async () => 1,
        evaluate: async () => 0
      })
    };
    const result = invReactionsPickerNonempty.check(mockPage as any);
    return expect(result).resolves.toMatchObject({ok: false});
  });

  it('passes when picker has ≥3 emoji children', () => {
    const mockPage = {
      locator: () => ({
        count: async () => 1,
        evaluate: async () => 5
      })
    };
    const result = invReactionsPickerNonempty.check(mockPage as any);
    return expect(result).resolves.toMatchObject({ok: true});
  });

  it('passes (skip) when picker is not rendered', () => {
    const mockPage = {
      locator: () => ({
        count: async () => 0,
        evaluate: async () => 0
      })
    };
    const result = invReactionsPickerNonempty.check(mockPage as any);
    return expect(result).resolves.toMatchObject({ok: true});
  });
});
```

- [ ] **Step 5.8: Run — fail**

Run: `npx vitest run src/tests/fuzz/invariants/reactions-ui.test.ts`
Expected: FAIL `Cannot find module './reactions-ui'`

- [ ] **Step 5.9: Implement INV**

Create `src/tests/fuzz/invariants/reactions-ui.ts`:

```typescript
import type {Invariant} from '../types';

export const invReactionsPickerNonempty: Invariant = {
  id: 'INV-reactions-picker-nonempty',
  tier: 'cheap',
  scope: 'ui',
  check: async (page: any) => {
    const picker = page.locator('.reactions-picker, [data-test="reactions-picker"]');
    const count = await picker.count();
    if(count === 0) return {ok: true}; // not rendered right now — skip
    const emojiCount = await picker.evaluate((el: HTMLElement) => el.querySelectorAll('[data-emoji], .reaction-emoji, [role="button"]').length);
    if(emojiCount < 3) {
      return {
        ok: false,
        message: `reactions-picker rendered with ${emojiCount} emoji choices (expected ≥3)`
      };
    }
    return {ok: true};
  }
};
```

**Note:** adapt the `Invariant` type shape to match `src/tests/fuzz/types.ts`. If the existing invariants use `evaluateAt(page, peer) => Finding | null` pattern, mirror that.

- [ ] **Step 5.10: Register INV in invariants/index.ts**

Follow existing pattern. Add `invReactionsPickerNonempty` to the exported array.

- [ ] **Step 5.11: Run full fuzz vitest**

Run: `npx vitest run src/tests/fuzz/`
Expected: PASS, total ≥ 63 + previous additions (5 from T1 + 2 from T3 + 3 from T5 = ≥73 target).

- [ ] **Step 5.12: Smoke with reactViaUI enabled**

Run: `pnpm fuzz --duration=3m --seed=42`
Watch output: `reactViaUI` should appear in the action stream.

Expected: 0 findings. If findings: per §4 decision #3 max 1 fix wave. If the fix is a prod bug (like the PR #47 scenario): surgical fix in `src/components/chat/reaction.ts` or `src/lib/nostra/nostra-reactions-*.ts`, include regression test in the same commit.

If 2nd smoke still fails: document in FUZZ-FINDINGS.md Open, carry-forward to 2b.3, proceed to Task 6.

- [ ] **Step 5.13: Lint + typecheck**

```bash
pnpm lint
npx tsc --noEmit
```

- [ ] **Step 5.14: Commit**

```bash
git add src/tests/fuzz/actions/reactions.ts src/tests/fuzz/actions/reactions.test.ts src/tests/fuzz/actions/index.ts src/tests/fuzz/invariants/reactions-ui.ts src/tests/fuzz/invariants/reactions-ui.test.ts src/tests/fuzz/invariants/index.ts
git commit -m "feat(fuzz): reactViaUI action + INV-reactions-picker-nonempty

New action opens bubble context menu via right-click, selects emoji from
rendered picker — exercises the UI path bypassed by reactRandomBubble's
manager-proxy shortcut. Would have intercepted the getAvailableReactions
empty-stub bug (PR #47 latent ship).

INV-reactions-picker-nonempty asserts the picker renders ≥3 emoji when opened."
```

---

## Task 6: Profile scope — actions + invariants + Blossom mock

**Spec reference:** §6.5

**Files (many — subdivide):**
- Create: `src/tests/fuzz/actions/profile.ts`
- Create: `src/tests/fuzz/actions/profile.test.ts`
- Create: `src/tests/fuzz/invariants/profile.ts`
- Create: `src/tests/fuzz/invariants/profile.test.ts`
- Create: `src/tests/fuzz/postconditions/profile.ts`
- Modify: `src/tests/fuzz/actions/index.ts` (register 4 new actions)
- Modify: `src/tests/fuzz/invariants/index.ts` (register 3 new invariants)
- Modify: `src/tests/fuzz/postconditions/index.ts` (register 3 new postconditions)
- Modify: `src/tests/fuzz/harness.ts` (inject Blossom mock via `context.addInitScript`)

### Task 6a: Blossom mock in harness

- [ ] **Step 6a.1: Locate addInitScript point in harness**

In `bootHarness` (`src/tests/fuzz/harness.ts`), find where `browser.newContext(...)` is called for each user. The mock must be injected BEFORE `page.goto(APP_URL)`.

- [ ] **Step 6a.2: Add Blossom mock helper**

Inside the `bootHarness` function, after `const context = await browser.newContext(...)` and before any `page.goto`:

```typescript
await context.addInitScript(() => {
  const originalFetch = window.fetch.bind(window);
  (window as any).__fuzzBlossomUploads = new Map<string, Uint8Array>();
  window.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
    const method = (init?.method || 'GET').toUpperCase();
    if(url && /^https?:\/\/[^/]+\/(upload|media)(\/|\?|$)/.test(url) && (method === 'PUT' || method === 'POST')) {
      const bodyAny = init!.body as any;
      let body: Uint8Array;
      if(bodyAny instanceof Uint8Array) body = bodyAny;
      else if(bodyAny instanceof Blob) body = new Uint8Array(await bodyAny.arrayBuffer());
      else if(bodyAny instanceof ArrayBuffer) body = new Uint8Array(bodyAny);
      else body = new Uint8Array();
      const hash = await crypto.subtle.digest('SHA-256', body);
      const sha = Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, '0')).join('');
      (window as any).__fuzzBlossomUploads.set(sha, body);
      return new Response(JSON.stringify({
        url: `https://blossom.fuzz/${sha}.png`,
        sha256: sha,
        size: body.byteLength,
        uploaded: Math.floor(Date.now() / 1000)
      }), {status: 200, headers: {'content-type': 'application/json'}});
    }
    return originalFetch(input as any, init);
  } as typeof window.fetch;
});
```

- [ ] **Step 6a.3: Lint + typecheck**

```bash
pnpm lint
npx tsc --noEmit
```

- [ ] **Step 6a.4: Smoke the mock**

Add a temp assertion in a throwaway test that spawns bootHarness + uploads a fake PNG + checks `__fuzzBlossomUploads` has entry. Skip if non-trivial — defer to Step 6b integration. (Intentionally no Vitest for the mock itself; it's infrastructure.)

### Task 6b: Profile actions

- [ ] **Step 6b.1: Write failing test for action generators**

Create `src/tests/fuzz/actions/profile.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
import {editNameAction, editBioAction, uploadAvatarAction, setNip05Action} from './profile';

describe('profile actions', () => {
  it('editName generator returns valid args', () => {
    const rng: any = {pick: <T>(a: T[]) => a[0], nextString: () => 'Alice'};
    const args = editNameAction.gen(rng, {});
    expect(args).toMatchObject({user: 'userA', newName: expect.any(String)});
    expect(args.newName.length).toBeGreaterThan(0);
  });

  it('editBio returns args', () => {
    const rng: any = {pick: <T>(a: T[]) => a[0], nextString: () => 'bio text'};
    const args = editBioAction.gen(rng, {});
    expect(args).toMatchObject({user: 'userA', newBio: expect.any(String)});
  });

  it('uploadAvatar returns bytes', () => {
    const rng: any = {pick: <T>(a: T[]) => a[0], nextInt: (n: number) => 3};
    const args = uploadAvatarAction.gen(rng, {});
    expect(args).toMatchObject({user: 'userA', pngBytes: expect.any(Uint8Array)});
    expect(args.pngBytes.byteLength).toBeGreaterThan(0);
  });

  it('setNip05 returns args with valid-ish format', () => {
    const rng: any = {pick: <T>(a: T[]) => a[0], nextString: () => 'alice'};
    const args = setNip05Action.gen(rng, {});
    expect(args.nip05).toMatch(/^[^@]+@[^@]+\.[a-z]+$/);
  });
});
```

- [ ] **Step 6b.2: Run — fail**

Run: `npx vitest run src/tests/fuzz/actions/profile.test.ts`
Expected: FAIL (module missing)

- [ ] **Step 6b.3: Implement profile actions**

Create `src/tests/fuzz/actions/profile.ts`:

```typescript
import type {FuzzAction, FuzzContext} from '../types';

const NAMES = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank'];
const BIOS = ['Hello world', 'Just a peer', 'Nostr enjoyer', 'Decentralize!'];
const NIP05_USERS = ['alice', 'bob', 'carol'];
const NIP05_DOMAINS = ['example.com', 'nostra.chat', 'test.org'];

function generatePng(width: number, height: number): Uint8Array {
  // Minimal 8-byte PNG signature + IHDR stub — enough for sha256 + upload path.
  // The fuzzer doesn't need a real image; the client only reads bytes.
  const sig = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const payload = new Uint8Array(width * height * 4); // RGBA fill
  for(let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;
  const out = new Uint8Array(sig.byteLength + payload.byteLength);
  out.set(sig, 0);
  out.set(payload, sig.byteLength);
  return out;
}

export const editNameAction: FuzzAction = {
  name: 'editName',
  weight: 0.3,
  gen: (rng: any, _state: any) => {
    const user = rng.pick(['userA', 'userB']);
    const newName = rng.pick(NAMES) + '-' + rng.nextString().slice(0, 3);
    return {user, newName};
  },
  execute: async (ctx: FuzzContext, args: {user: string; newName: string}) => {
    const u = ctx.users[args.user as 'userA' | 'userB'];
    await openSettings(u);
    const nameInput = u.page.locator('[data-test="profile-name-input"], input[name="firstName"]').first();
    await nameInput.waitFor({state: 'visible', timeout: 5000});
    await nameInput.fill(args.newName);
    const save = u.page.locator('[data-test="profile-save"], button:has-text("Save")').first();
    await save.click();
    await closeSettings(u);
  }
};

export const editBioAction: FuzzAction = {
  name: 'editBio',
  weight: 0.3,
  gen: (rng: any, _state: any) => {
    const user = rng.pick(['userA', 'userB']);
    const newBio = rng.pick(BIOS) + ' ' + rng.nextString().slice(0, 5);
    return {user, newBio};
  },
  execute: async (ctx: FuzzContext, args: {user: string; newBio: string}) => {
    const u = ctx.users[args.user as 'userA' | 'userB'];
    await openSettings(u);
    const bioInput = u.page.locator('[data-test="profile-bio-input"], textarea[name="bio"]').first();
    await bioInput.waitFor({state: 'visible', timeout: 5000});
    await bioInput.fill(args.newBio);
    const save = u.page.locator('[data-test="profile-save"], button:has-text("Save")').first();
    await save.click();
    await closeSettings(u);
  }
};

export const uploadAvatarAction: FuzzAction = {
  name: 'uploadAvatar',
  weight: 0.15,
  gen: (rng: any, _state: any) => {
    const user = rng.pick(['userA', 'userB']);
    const size = 2 + rng.nextInt(6);
    const pngBytes = generatePng(size, size);
    return {user, pngBytes};
  },
  execute: async (ctx: FuzzContext, args: {user: string; pngBytes: Uint8Array}) => {
    const u = ctx.users[args.user as 'userA' | 'userB'];
    await openSettings(u);
    const upload = u.page.locator('input[type="file"][accept*="image"]').first();
    await upload.setInputFiles({
      name: 'avatar.png',
      mimeType: 'image/png',
      buffer: Buffer.from(args.pngBytes)
    });
    // Confirm crop if modal appears
    const confirm = u.page.locator('[data-test="crop-confirm"], button:has-text("Apply")').first();
    if(await confirm.isVisible().catch(() => false)) await confirm.click();
    await closeSettings(u);
  }
};

export const setNip05Action: FuzzAction = {
  name: 'setNip05',
  weight: 0.2,
  gen: (rng: any, _state: any) => {
    const user = rng.pick(['userA', 'userB']);
    const nip05 = rng.pick(NIP05_USERS) + '@' + rng.pick(NIP05_DOMAINS);
    return {user, nip05};
  },
  execute: async (ctx: FuzzContext, args: {user: string; nip05: string}) => {
    const u = ctx.users[args.user as 'userA' | 'userB'];
    await openSettings(u);
    const input = u.page.locator('[data-test="profile-nip05-input"], input[name="nip05"]').first();
    await input.waitFor({state: 'visible', timeout: 5000});
    await input.fill(args.nip05);
    const save = u.page.locator('[data-test="profile-save"], button:has-text("Save")').first();
    await save.click();
    await closeSettings(u);
  }
};

async function openSettings(u: {page: any}): Promise<void> {
  // Open hamburger menu, click Settings, click Edit Profile
  const hamburger = u.page.locator('[data-test="hamburger"], .sidebar-header__burger-menu').first();
  await hamburger.click({timeout: 3000}).catch(() => {});
  const settings = u.page.locator('text=Settings').first();
  await settings.click({timeout: 3000}).catch(() => {});
  const editProfile = u.page.locator('text=Edit Profile').first();
  if(await editProfile.isVisible().catch(() => false)) await editProfile.click();
}

async function closeSettings(u: {page: any}): Promise<void> {
  await u.page.keyboard.press('Escape').catch(() => {});
  await u.page.waitForTimeout(200);
}
```

**Note:** selectors are best-effort. Subagent implementing this task MUST:
1. Start `pnpm start`, manually open Settings → Edit Profile in a browser, grab the real selectors via DevTools.
2. Replace the `[data-test]` fallback chain with the actual ones.
3. Add the `data-test` attributes to the source components if they don't exist (small additive PR-local change).

- [ ] **Step 6b.4: Run test — pass**

Run: `npx vitest run src/tests/fuzz/actions/profile.test.ts`
Expected: PASS.

- [ ] **Step 6b.5: Register in actions/index.ts**

Same pattern as Task 5.6. Import + push all 4 actions.

### Task 6c: Profile invariants

- [ ] **Step 6c.1: Write failing tests**

Create `src/tests/fuzz/invariants/profile.test.ts`:

```typescript
import {describe, it, expect} from 'vitest';
import {invProfileKind0SingleActive, invProfileCacheCoherent, invProfilePropagates} from './profile';

describe('INV-profile-kind0-single-active', () => {
  it('fails when multiple active kind-0 events for same pubkey', async () => {
    const mockPage = {
      evaluate: async () => ({pubkeyA: [{kind: 0, ts: 1}, {kind: 0, ts: 2}]})
    };
    const r = await invProfileKind0SingleActive.check(mockPage as any);
    expect(r.ok).toBe(false);
  });

  it('passes when exactly one active kind-0', async () => {
    const mockPage = {
      evaluate: async () => ({pubkeyA: [{kind: 0, ts: 5}]})
    };
    const r = await invProfileKind0SingleActive.check(mockPage as any);
    expect(r.ok).toBe(true);
  });
});

describe('INV-profile-cache-coherent', () => {
  it('fails when cache name != latest kind-0 name', async () => {
    const mockPage = {
      evaluate: async () => ({cache: {name: 'old'}, latestKind0: {content: '{"name":"new"}'}})
    };
    const r = await invProfileCacheCoherent.check(mockPage as any);
    expect(r.ok).toBe(false);
  });

  it('passes when matching', async () => {
    const mockPage = {
      evaluate: async () => ({cache: {name: 'sync'}, latestKind0: {content: '{"name":"sync"}'}})
    };
    const r = await invProfileCacheCoherent.check(mockPage as any);
    expect(r.ok).toBe(true);
  });
});

describe('INV-profile-propagates', () => {
  it('post-action check reports ok when peer cache synced within timeout', async () => {
    const peerPage = {
      evaluate: async () => ({first_name: 'New Name'})
    };
    const r = await invProfilePropagates.checkAfter({peerPage, expectedName: 'New Name', timeoutMs: 1000} as any);
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 6c.2: Run — fail**

- [ ] **Step 6c.3: Implement profile.ts invariants**

Create `src/tests/fuzz/invariants/profile.ts`:

```typescript
import type {Invariant} from '../types';

export const invProfileKind0SingleActive: Invariant = {
  id: 'INV-profile-kind0-single-active',
  tier: 'cheap',
  scope: 'global',
  check: async (page: any) => {
    const byPubkey = await page.evaluate(() => {
      const store = (window as any).__nostra?.kind0Store?.all?.() ?? {};
      return store;
    });
    for(const [pubkey, events] of Object.entries(byPubkey as Record<string, Array<{kind: number; ts: number}>>)) {
      const activeCount = (events as Array<{kind: number; ts: number}>).filter((e) => e.kind === 0).length;
      if(activeCount > 1) {
        return {ok: false, message: `pubkey ${pubkey} has ${activeCount} active kind-0 events (expected 1)`};
      }
    }
    return {ok: true};
  }
};

export const invProfileCacheCoherent: Invariant = {
  id: 'INV-profile-cache-coherent',
  tier: 'medium',
  scope: 'ui',
  check: async (page: any) => {
    const {cache, latestKind0} = await page.evaluate(() => {
      const c = (window as any).__nostra?.ownProfileCache;
      const k = (window as any).__nostra?.latestOwnKind0;
      return {cache: c, latestKind0: k};
    });
    if(!cache || !latestKind0) return {ok: true};
    let parsed: any = {};
    try{ parsed = JSON.parse(latestKind0.content); } catch{ return {ok: true}; }
    if(cache.name !== undefined && parsed.name !== undefined && cache.name !== parsed.name) {
      return {ok: false, message: `cache.name=${cache.name} !== kind0.content.name=${parsed.name}`};
    }
    return {ok: true};
  }
};

export const invProfilePropagates = {
  id: 'INV-profile-propagates',
  tier: 'regression' as const,
  scope: 'cross-peer' as const,
  checkAfter: async (ctx: {peerPage: any; expectedName: string; timeoutMs: number}) => {
    const start = Date.now();
    while(Date.now() - start < ctx.timeoutMs) {
      const {first_name} = await ctx.peerPage.evaluate(() => {
        const proxy = (window as any).apiManagerProxy;
        const peers = proxy?.mirrors?.peers ?? {};
        const first = Object.values(peers).find((p: any) => p && p.first_name) as any;
        return first ?? {first_name: null};
      });
      if(first_name === ctx.expectedName) return {ok: true};
      await new Promise((r) => setTimeout(r, 250));
    }
    return {ok: false, message: `peer never saw name="${ctx.expectedName}" within ${ctx.timeoutMs}ms`};
  }
};
```

**Adapt** the `Invariant` type shape + the `__nostra` debug globals to match the real codebase. Subagent MUST grep for `window.__nostra` in the source to confirm available globals; if not present, expose minimal debug hooks in `src/lib/nostra/` and reference them here.

- [ ] **Step 6c.4: Run — pass**

- [ ] **Step 6c.5: Register in invariants/index.ts**

### Task 6d: Profile postconditions

- [ ] **Step 6d.1: Implement 3 postconditions**

Create `src/tests/fuzz/postconditions/profile.ts`:

```typescript
import type {Postcondition} from '../types';

export const postEditNameCacheUpdated: Postcondition = {
  id: 'POST_editName_cache_updated',
  action: 'editName',
  check: async (ctx, args) => {
    const u = ctx.users[args.user as 'userA' | 'userB'];
    const start = Date.now();
    while(Date.now() - start < 3000) {
      const name = await u.page.evaluate(() => (window as any).__nostra?.ownProfileCache?.name);
      if(name === args.newName) return {ok: true};
      await u.page.waitForTimeout(100);
    }
    return {ok: false, message: `cache did not reflect new name "${args.newName}" within 3s`};
  }
};

export const postEditNameRelayPublished: Postcondition = {
  id: 'POST_editName_relay_published',
  action: 'editName',
  check: async (ctx, args) => {
    const relay = ctx.relay;
    const start = Date.now();
    while(Date.now() - start < 5000) {
      const pubkey = await ctx.users[args.user as 'userA' | 'userB'].page.evaluate(
        () => (window as any).__nostraOwnPubkey
      );
      const events = relay.getPublishedEvents?.({kind: 0, pubkey}) ?? [];
      if(events.some((e: any) => { try{ return JSON.parse(e.content).name === args.newName; } catch{ return false; } })) {
        return {ok: true};
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return {ok: false, message: `no kind-0 published with name="${args.newName}" within 5s`};
  }
};

export const postUploadAvatarPropagated: Postcondition = {
  id: 'POST_uploadAvatar_propagated',
  action: 'uploadAvatar',
  check: async (ctx, args) => {
    const peer = args.user === 'userA' ? ctx.users.userB : ctx.users.userA;
    const start = Date.now();
    while(Date.now() - start < 5000) {
      const hit = await peer.page.evaluate(() => {
        const peers = (window as any).apiManagerProxy?.mirrors?.peers ?? {};
        for(const p of Object.values(peers) as any[]) {
          if(p?.photo?.url && /blossom\.fuzz/.test(p.photo.url)) return true;
        }
        return false;
      });
      if(hit) return {ok: true};
      await peer.page.waitForTimeout(200);
    }
    return {ok: false, message: 'peer never saw blossom.fuzz avatar URL within 5s'};
  }
};
```

**Adapt** to actual `Postcondition` shape from `types.ts`. `ctx.relay.getPublishedEvents` may not exist on LocalRelay — if not, add a helper in `LocalRelay` class (look for it in `src/tests/fuzz/` or equivalent; if absent, subagent adds a 5-line getter).

- [ ] **Step 6d.2: Register postconditions in index.ts**

- [ ] **Step 6d.3: Lint + typecheck + vitest**

```bash
pnpm lint
npx tsc --noEmit
npx vitest run src/tests/fuzz/
```

All clean, total count ≥ 73 + profile tests (~5 new) = ≥ 78 target.

### Task 6e: Smoke with profile scope active

- [ ] **Step 6e.1: Live fuzz run**

Run: `pnpm fuzz --duration=3m --seed=42 2>&1 | tee /tmp/2b2b-t6-profile-smoke.log`

Expected: action stream includes `editName`, `editBio`, `uploadAvatar`, `setNip05` — 0 findings.

- [ ] **Step 6e.2: Apply max 1 fix wave if needed**

Per §4 decision #3. If findings surface:
- Look at the failing action/invariant/postcondition.
- If actionable surgical fix exists: apply, add regression test in same commit.
- If not: document in FUZZ-FINDINGS.md Open as carry-forward to 2b.3.
- Do NOT attempt a 2nd wave.

- [ ] **Step 6e.3: Commit**

```bash
git add src/tests/fuzz/actions/profile.ts src/tests/fuzz/actions/profile.test.ts \
        src/tests/fuzz/invariants/profile.ts src/tests/fuzz/invariants/profile.test.ts \
        src/tests/fuzz/postconditions/profile.ts \
        src/tests/fuzz/actions/index.ts src/tests/fuzz/invariants/index.ts src/tests/fuzz/postconditions/index.ts \
        src/tests/fuzz/harness.ts
git commit -m "feat(fuzz): profile actions + invariants + Blossom mock

New actions: editName, editBio, uploadAvatar, setNip05.
Invariants: INV-profile-kind0-single-active, INV-profile-cache-coherent,
INV-profile-propagates (regression tier, cross-peer poll).
Postconditions: POST_editName_cache_updated, POST_editName_relay_published,
POST_uploadAvatar_propagated.
Blossom upload mocked via context.addInitScript with SHA256-keyed stash."
```

Include any Apollo-style data-test attributes added to source files in this commit (if subagent needed to annotate Settings/Profile components for selectors).

---

## Task 7: Emit baseline-seed42-v2b2.json + replay verify

**Spec reference:** §6.6

**Files:**
- Modify: `src/tests/fuzz/fuzz.ts` (bump `fuzzerVersion: 'phase2b1'` → `'phase2b2'`)
- Modify: `src/tests/fuzz/replay.ts` (update validation string `'phase2b1'` → `'phase2b2'`)
- Modify: `src/tests/fuzz/baseline.test.ts` (update any reference to older version)
- Create: `docs/fuzz-baseline/baseline-seed42-v2b2.json` (via emit command)

- [ ] **Step 7.1: Bump fuzzerVersion in code**

Edit `src/tests/fuzz/fuzz.ts` line 120: `'phase2b1'` → `'phase2b2'`.
Edit `src/tests/fuzz/replay.ts` line 41: `'phase2b1'` → `'phase2b2'` and update the warn message.
Grep for `phase2b1` anywhere else in `src/tests/fuzz/` and update consistently.

- [ ] **Step 7.2: Vitest still passing**

Run: `npx vitest run src/tests/fuzz/`
Expected: all passes. If `baseline.test.ts` had assumptions about version string, update expected values.

- [ ] **Step 7.3: Emit baseline**

Ensure:
- `pnpm start` running at `:8080`
- `git status` clean (no working-tree changes to `FUZZ-FINDINGS.md`)

Run:
```
pnpm fuzz --duration=6m --max-commands=40 --seed=42 --emit-baseline 2>&1 | tee /tmp/2b2b-baseline-emit.log
```

Expected:
- Log shows `findings: 0` at end.
- `docs/fuzz-baseline/baseline-seed42-v2b2.json` exists.
- Exit code 0.

- [ ] **Step 7.4: Verify JSON shape**

Check the emitted file has `"fuzzerVersion": "phase2b2"` and `"seed": 42`:

```
grep -l fuzzerVersion docs/fuzz-baseline/baseline-seed42-v2b2.json
head -20 docs/fuzz-baseline/baseline-seed42-v2b2.json
```

- [ ] **Step 7.5: Replay the baseline**

Run: `pnpm fuzz --replay-baseline`

Expected: exit 0, no finding emitted.

- [ ] **Step 7.6: Commit**

```bash
git add src/tests/fuzz/fuzz.ts src/tests/fuzz/replay.ts src/tests/fuzz/baseline.test.ts docs/fuzz-baseline/baseline-seed42-v2b2.json
git commit -m "chore(fuzz): emit baseline-seed42-v2b2.json (profile scope included)

Bumps fuzzerVersion phase2b1 → phase2b2; includes profile actions,
reactViaUI, and warmup handshake. Replay protects main against
regressions in this action set."
```

---

## Task 8: Docs + triple gate + PR prep

**Files:**
- Create: `docs/VERIFICATION_2B2B.md`
- Modify: `CLAUDE.md` (Nostra.chat architecture notes, baseline claims, bug fuzzer section)

- [ ] **Step 8.1: Write VERIFICATION_2B2B.md**

Create `docs/VERIFICATION_2B2B.md`:

```markdown
# Phase 2b.2b Verification Checklist

Manual 2-device verification steps. Complete all boxes before merging.

## Reporter (T1)
- [ ] Run `pnpm fuzz --duration=30s` on this branch.
- [ ] Run `git diff docs/FUZZ-FINDINGS.md` — confirm `## Fixed` section is byte-for-byte unchanged, only `Last updated:` + `Last seen:` fields in Open section moved.

## Warmup (T2)
- [ ] Cold-boot `pnpm fuzz --duration=60s --seed=42` — observe 4 `[harness] warmup: …` lines before first fuzz action.
- [ ] Replay `FIND-cold-deleteWhileSending` 10 times — 10/10 pass.
- [ ] Replay `FIND-cold-reactPeerSeesEmoji` 10 times — 10/10 pass.

## chrono-v2 (T3)
- [ ] Replay `FIND-eef9f130` 10 times — 10/10 pass (previously ~40% flake post-2b.2a).

## reactViaUI (T5)
- [ ] Open a chat in the browser; right-click any bubble.
- [ ] Reactions picker renders with ≥3 emoji.
- [ ] Click one — reaction appears on the bubble within 2s.

## Profile (T6)
Two browser windows (device A, device B):
- [ ] Device A: Settings → Edit Profile → change name → Save.
- [ ] Device B: within 5s, A's name updates in the chat list.
- [ ] Device A: upload a new avatar → crop → confirm.
- [ ] Device B: A's avatar updates within 5s (from `blossom.fuzz` mock URL in fuzz runs; real Blossom in production test).
- [ ] Device A: set NIP-05 (e.g. `alice@example.com`) → Save.
- [ ] Device A: reload → NIP-05 persists.

## Baseline (T7)
- [ ] `pnpm fuzz --replay-baseline` exits 0.
- [ ] `docs/fuzz-baseline/baseline-seed42-v2b2.json` exists with `"fuzzerVersion": "phase2b2"`.

## Tech gate (automated)
- [ ] `pnpm lint` clean.
- [ ] `npx tsc --noEmit` clean.
- [ ] `pnpm test:nostra:quick` ≥ 401 passing.
- [ ] `npx vitest run src/tests/fuzz/` ≥ 68 passing.
```

- [ ] **Step 8.2: Update CLAUDE.md**

Edits (each a small replacement):

1. Find the line mentioning "baseline deferred to 2b.2b pending fix of cold-start flakes" → replace with "Phase 2b.2b shipped baseline `docs/fuzz-baseline/baseline-seed42-v2b2.json` (`fuzzerVersion: 'phase2b2'`); `pnpm fuzz --replay-baseline` protects main."

2. In the Bug Fuzzer section, add a note: "`pnpm fuzz` runs preserve `docs/FUZZ-FINDINGS.md` curation automatically (T1). No `git restore` workaround needed."

3. Add a note: "Profile scope (editName, editBio, uploadAvatar, setNip05) covered by fuzzer since 2b.2b."

4. Update the 2b.2a/carry-forward bullet: "Phase 2b.2b closed `FIND-chrono-v2`, `FIND-cold-deleteWhileSending`, `FIND-cold-reactPeerSeesEmoji` + reporter clobber + profile scope + baseline v2b2 emit."

- [ ] **Step 8.3: Run tech gate**

```bash
pnpm lint
npx tsc --noEmit
pnpm test:nostra:quick
npx vitest run src/tests/fuzz/
```

Record numbers. All must pass.

- [ ] **Step 8.4: Commit docs**

```bash
git add docs/VERIFICATION_2B2B.md CLAUDE.md
git commit -m "docs(fuzz): phase 2b.2b verification + CLAUDE.md sync"
```

- [ ] **Step 8.5: Push + PR**

```bash
git push -u origin fuzz-phase-2b2b
```

If husky pre-push typecheck fails: fix, NEW commit (not amend), push again.

Create PR with Conventional Commits title:

```
feat(fuzz): phase 2b.2b — reporter fix + warmup + profile + baseline v2b2 emit
```

PR body template:

```markdown
## Summary
- Reporter parse-preserve-update merge — preserves curated Fixed sections byte-for-byte.
- Multi-kind deterministic warmup handshake in bootHarness — closes FIND-cold-deleteWhileSending, FIND-cold-reactPeerSeesEmoji.
- `mid` tiebreaker in P2P bubble sort — closes FIND-chrono-v2.
- `reactViaUI` fuzz action + `INV-reactions-picker-nonempty` — catches UI-layer reaction bugs.
- Profile scope: editName/editBio/uploadAvatar/setNip05 + Blossom mock + 3 invariants + 3 postconditions.
- Baseline `docs/fuzz-baseline/baseline-seed42-v2b2.json` committed (`fuzzerVersion: 'phase2b2'`).

## Test plan
- [x] Tech gate: lint / tsc / vitest-nostra (≥401) / vitest-fuzz (≥68)
- [x] T4 smoke: `pnpm fuzz --duration=6m --seed=42` → 0 findings (no profile)
- [x] T6e smoke: `pnpm fuzz --duration=3m --seed=42` with profile → 0 findings (or carry-forward documented)
- [x] T7 baseline emit + replay → exit 0
- [x] 2-device manual per `docs/VERIFICATION_2B2B.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

- [ ] **Step 8.6: Verify PR auto-merges release-please logic OK**

Confirm PR title is Conventional Commits (`feat(fuzz):` prefix). Squash-merge will use the PR title as the commit on `main`.

---

## Self-review checklist

Before declaring plan complete, subagent orchestrator MUST verify:

- [ ] Every task has explicit test → fail → implement → pass → commit cycle (TDD).
- [ ] No "TODO" / "implement later" / "TBD" in the plan.
- [ ] Every file path is absolute or clearly worktree-relative (`src/tests/fuzz/…`).
- [ ] Commit messages are Conventional Commits.
- [ ] Cross-task dependencies are explicit (T5 depends on T2 warmup being in place, T7 depends on T6 actions being registered).
- [ ] Fix-wave cap (§4 #3) applies to T2/T3/T5/T6 — documented in each.
- [ ] Triple gate enumerated in T8 and in the spec §8.

## Risk mitigations in plan

- **R2/R3 (unexpected bugs in reactViaUI / profile):** max 1 fix wave each, then document in Open and continue. Monolithic PR does not block on these.
- **R5 (reporter malformed file):** Step 1.13 covers empty + no-Fixed edge cases. Fallback in `splitFindingsZones` for empty string.
- **R6 (baseline run timing):** T7 can extend duration if 6m insufficient. Document actual in PR body.
