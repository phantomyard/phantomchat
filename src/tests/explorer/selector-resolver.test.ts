import {describe, expect, it} from 'vitest';
import {buildSelectorCandidates} from '../../../scripts/explorer/selector-resolver';

describe('buildSelectorCandidates', () => {
  it('emits candidates in priority order: data-testid, role+name, text, aria-label, class', () => {
    const cands = buildSelectorCandidates('settings panel');
    expect(cands.length).toBeGreaterThanOrEqual(3);
    expect(cands[0].kind).toBe('testid');
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
