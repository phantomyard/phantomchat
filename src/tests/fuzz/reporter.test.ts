import {describe, it, expect} from 'vitest';
import {
  computeSignature,
  parseFindingsMarkdown,
  renderFindingsMarkdown,
  splitFindingsZones,
  mergeFindings,
  writeFindingsMarkdownPure
} from './reporter';
import type {IncomingFinding} from './reporter';
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

  it('normalises timing prefixes so the same logical warning collapses to one sig', () => {
    const a = computeSignature({invariantId: 'INV-x', message: '[warning] %s [0.044] [IDB-tweb-common] performing idb upgrade from 0 to 8'});
    const b = computeSignature({invariantId: 'INV-x', message: '[warning] %s [0.047] [IDB-tweb-common] performing idb upgrade from 0 to 8'});
    const c = computeSignature({invariantId: 'INV-x', message: '[warning] %s [12.031] [IDB-tweb-common] performing idb upgrade from 0 to 8'});
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('normalises npub + hex ids + mid + boot durations', () => {
    const a = computeSignature({invariantId: 'INV-x', message: 'avatar DOM src != cache on userA (npub1nla4z48mw5qxt6e…)'});
    const b = computeSignature({invariantId: 'INV-x', message: 'avatar DOM src != cache on userA (npub17nud3gwqgabc…)'});
    expect(a).toBe(b);

    const c = computeSignature({invariantId: 'INV-x', message: 'bubble mid=1712345678 state sent but tracker delivered'});
    const d = computeSignature({invariantId: 'INV-x', message: 'bubble mid=1712345999 state sent but tracker delivered'});
    expect(c).toBe(d);

    const e = computeSignature({invariantId: 'INV-x', message: 'boot done in 67.2s after 2 retries'});
    const f = computeSignature({invariantId: 'INV-x', message: 'boot done in 82.1s after 2 retries'});
    expect(e).toBe(f);
  });

  it('does NOT collapse distinct errors (conservative normalisation)', () => {
    const a = computeSignature({invariantId: 'INV-x', message: 'duplicate mid in DOM'});
    const b = computeSignature({invariantId: 'INV-x', message: 'bubble not chronological'});
    expect(a).not.toBe(b);
  });

  it('collapses emoji and temp-mid variants of the same bug', () => {
    const fire = computeSignature({invariantId: 'INV-x', message: 'reaction 🔥 not visible on mid=1776497965366456'});
    const thumbs = computeSignature({invariantId: 'INV-x', message: 'reaction 👍 not visible on mid=1776497611062493'});
    const think = computeSignature({invariantId: 'INV-x', message: 'reaction 🤔 not visible on mid=0.0001'});
    const tempFire = computeSignature({invariantId: 'INV-x', message: 'reaction 🔥 not visible on mid=0.0002'});
    expect(fire).toBe(thumbs);
    expect(fire).toBe(think);
    expect(fire).toBe(tempFire);
  });
});

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
    expect(merged[0].firstSeen).toBe('2026-04-19 12:00:00');
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
    const openStart = result.indexOf('## Open');
    const fixedStart = result.indexOf('## Fixed');
    const openSection = result.slice(openStart, fixedStart);
    expect(openSection).not.toContain('### FIND-cccccccc');
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

  // Human curation of FUZZ-FINDINGS.md sometimes wraps the JSON-stringified
  // assertion in markdown code-span backticks (`"..."`). The parser must
  // tolerate both shapes so the emit/merge pipeline doesn't crash mid-run
  // and lose the finding.
  it('parses entry with backtick-wrapped assertion (human-curated form)', () => {
    const md = [
      '# Fuzz Findings',
      '',
      '## Open',
      '',
      '### FIND-deadbeef — INV-something',
      '- **Status**: open',
      '- **Tier**: cheap',
      '- **Occurrences**: 1',
      '- **First seen**: 2026-04-24 00:00:00',
      '- **Last seen**: 2026-04-24 00:00:00',
      '- **Seed**: 42',
      '- **Assertion**: `"group 9626d38a on userB: admin foo not in members"`',
      '- **Replay**: `pnpm fuzz --replay=FIND-deadbeef`',
      '- **Minimal trace** (1 actions):',
      '  1. `sendText({"from":"userB","text":"x"})`',
      ''
    ].join('\n');
    const parsed = parseFindingsMarkdown(md);
    expect(parsed.length).toBe(1);
    expect(parsed[0].signature).toBe('deadbeef');
    expect(parsed[0].assertion).toBe('group 9626d38a on userB: admin foo not in members');
  });

  // Defensive: a plain-text assertion that isn't valid JSON (e.g. a
  // hand-written description) should fall back to the raw string instead
  // of throwing — merging occurrences is more important than normalising
  // the assertion payload.
  it('falls back to raw string when assertion is not valid JSON', () => {
    const md = [
      '# Fuzz Findings',
      '',
      '## Open',
      '',
      '### FIND-cafe0001 — INV-x',
      '- **Status**: open',
      '- **Tier**: cheap',
      '- **Occurrences**: 1',
      '- **First seen**: 2026-04-24 00:00:00',
      '- **Last seen**: 2026-04-24 00:00:00',
      '- **Seed**: 42',
      '- **Assertion**: some free-form text with no quotes',
      ''
    ].join('\n');
    const parsed = parseFindingsMarkdown(md);
    expect(parsed.length).toBe(1);
    expect(parsed[0].assertion).toBe('some free-form text with no quotes');
  });
});
