import {describe, expect, it} from 'vitest';

/**
 * Stage-1 fixer self-classification schema (spec §5).
 *
 * The fixer subagent MUST emit this JSON to `$FIND_DIR/fix-attempt-1/classification.json`
 * before doing anything else. This test validates the shape — the actual fixer agent
 * lives in `.claude/agents/phantomchat-fixer.md` and produces this artifact at runtime.
 */

const ALLOWED = ['ui-cosmetic', 'i18n', 'timeout-bump', 'logic-pure', 'css-style'] as const;
const DISALLOWED = ['async-timing', 'storage', 'race', 'messageport', 'other'] as const;
const ALL_CATEGORIES = [...ALLOWED, ...DISALLOWED] as const;

type Category = typeof ALL_CATEGORIES[number];

interface Classification {
  category: Category;
  confidence: number;
  reasoning: string;
  scope_files: string[];
}

function parseClassification(raw: string): {ok: true; value: Classification} | {ok: false; reason: string} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch(e) {
    return {ok: false, reason: `not valid JSON: ${(e as Error).message}`};
  }
  if(typeof parsed !== 'object' || parsed === null) return {ok: false, reason: 'not an object'};
  const o = parsed as Record<string, unknown>;
  if(typeof o.category !== 'string') return {ok: false, reason: 'category not a string'};
  if(!ALL_CATEGORIES.includes(o.category as Category)) return {ok: false, reason: `category not in enum: ${o.category}`};
  if(typeof o.confidence !== 'number' || o.confidence < 0 || o.confidence > 1) return {ok: false, reason: 'confidence not in [0,1]'};
  if(typeof o.reasoning !== 'string' || o.reasoning.length === 0) return {ok: false, reason: 'reasoning empty/non-string'};
  if(!Array.isArray(o.scope_files) || !o.scope_files.every((f) => typeof f === 'string')) return {ok: false, reason: 'scope_files not string[]'};
  return {ok: true, value: o as unknown as Classification};
}

function isAllowed(c: Classification): boolean {
  return (ALLOWED as readonly string[]).includes(c.category);
}

describe('explorer fixer stage-1 classification schema', () => {
  it('parses a well-formed allowed classification', () => {
    const raw = JSON.stringify({
      category: 'ui-cosmetic',
      confidence: 0.85,
      reasoning: 'Topbar shows wrong icon when chat is muted; only icon class needs swapping.',
      scope_files: ['src/components/chat/topbar.tsx']
    });
    const r = parseClassification(raw);
    expect(r.ok).toBe(true);
    if(r.ok) {
      expect(isAllowed(r.value)).toBe(true);
      expect(r.value.scope_files).toEqual(['src/components/chat/topbar.tsx']);
    }
  });

  it('parses a well-formed disallowed classification (which forces report-only)', () => {
    const raw = JSON.stringify({
      category: 'messageport',
      confidence: 0.95,
      reasoning: 'Worker IPC error in appManagersManager — manager[method] dispatch failure.',
      scope_files: []
    });
    const r = parseClassification(raw);
    expect(r.ok).toBe(true);
    if(r.ok) expect(isAllowed(r.value)).toBe(false);
  });

  it('rejects malformed JSON', () => {
    const r = parseClassification('{not json');
    expect(r.ok).toBe(false);
  });

  it('rejects unknown category', () => {
    const raw = JSON.stringify({
      category: 'super-easy-just-do-it',
      confidence: 0.9,
      reasoning: 'x',
      scope_files: []
    });
    const r = parseClassification(raw);
    expect(r.ok).toBe(false);
    if(r.ok === false) expect(r.reason).toMatch(/not in enum/);
  });

  it('rejects confidence out of [0,1]', () => {
    const raw = JSON.stringify({
      category: 'ui-cosmetic',
      confidence: 1.5,
      reasoning: 'x',
      scope_files: []
    });
    expect(parseClassification(raw).ok).toBe(false);
  });

  it('rejects empty reasoning (we want LLM to actually justify)', () => {
    const raw = JSON.stringify({
      category: 'ui-cosmetic',
      confidence: 0.9,
      reasoning: '',
      scope_files: []
    });
    expect(parseClassification(raw).ok).toBe(false);
  });

  it('rejects scope_files containing non-strings', () => {
    const raw = JSON.stringify({
      category: 'ui-cosmetic',
      confidence: 0.9,
      reasoning: 'x',
      scope_files: ['src/foo.ts', 42]
    });
    expect(parseClassification(raw).ok).toBe(false);
  });

  it('isAllowed correctly partitions ALLOWED/DISALLOWED enum', () => {
    for(const cat of ALLOWED) {
      const c: Classification = {category: cat, confidence: 0.9, reasoning: 'x', scope_files: []};
      expect(isAllowed(c)).toBe(true);
    }
    for(const cat of DISALLOWED) {
      const c: Classification = {category: cat, confidence: 0.9, reasoning: 'x', scope_files: []};
      expect(isAllowed(c)).toBe(false);
    }
  });

  it('FIND-0be5c329 (the open finding) would classify as messageport → report-only', () => {
    // Synthetic classification matching the actual finding's report.md
    const raw = JSON.stringify({
      category: 'messageport',
      confidence: 0.95,
      reasoning: 'TypeError: manager[method] is not a function in src/lib/appManagers/appManagersManager.ts — Worker IPC dispatch site. Stack frames include MTProtoMessagePort and SuperMessagePort. Pure messageport category.',
      scope_files: []
    });
    const r = parseClassification(raw);
    expect(r.ok).toBe(true);
    if(r.ok) expect(isAllowed(r.value)).toBe(false);
  });
});
