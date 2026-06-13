import {describe, it, expect} from 'vitest';
import {
  extractLeadingEmoji,
  setLeadingEmoji
} from '@components/sidebarLeft/tabs/editFolderInput/titleIconOps';

const MAX = 12;

describe('extractLeadingEmoji', () => {
  it('returns null for empty', () => {
    expect(extractLeadingEmoji('')).toBe(null);
  });

  it('returns null for pure text', () => {
    expect(extractLeadingEmoji('Work')).toBe(null);
  });

  it('returns the leading emoji', () => {
    expect(extractLeadingEmoji('🎯 Work')).toBe('🎯');
  });

  it('returns null when emoji is not at start', () => {
    expect(extractLeadingEmoji('Work 🎯')).toBe(null);
  });

  it('matches a ZWJ-joined emoji cluster', () => {
    expect(extractLeadingEmoji('👨‍👩‍👧 Family')).toBe('👨‍👩‍👧');
  });

  it('matches a flag sequence', () => {
    expect(extractLeadingEmoji('🇯🇵 Japan')).toBe('🇯🇵');
  });
});

describe('setLeadingEmoji', () => {
  it('prepends emoji + space to plain text', () => {
    expect(setLeadingEmoji('Work', '🎯', MAX)).toBe('🎯 Work');
  });

  it('replaces existing leading emoji', () => {
    expect(setLeadingEmoji('🐸 Work', '🎯', MAX)).toBe('🎯 Work');
  });

  it('replaces existing leading emoji with following space', () => {
    expect(setLeadingEmoji('🐸  Work', '🎯', MAX)).toBe('🎯 Work');
  });

  it('uses only the emoji when title is empty', () => {
    expect(setLeadingEmoji('', '🎯', MAX)).toBe('🎯');
  });

  it('truncates tail text to respect the max length cap', () => {
    // emoji (surrogate pair length 2) + ' ' + tail, capped at 12
    const out = setLeadingEmoji('abcdefghijkl', '🎯', MAX);
    expect(out.length).toBeLessThanOrEqual(MAX);
    expect(out.startsWith('🎯 ')).toBe(true);
  });

  it('returns only the emoji when budget forbids any tail', () => {
    // emoji alone is length 2, max is 2 → no space, no tail
    const out = setLeadingEmoji('Work', '🎯', 2);
    expect(out).toBe('🎯');
  });

  it('replaces a ZWJ-joined leading emoji without leaving orphan joiners', () => {
    // Before the regex widening, the result was '🎯 ‍👩‍👧 Family' (orphan ZWJ + codepoints).
    expect(setLeadingEmoji('👨‍👩‍👧 Fam', '🎯', 20)).toBe('🎯 Fam');
  });
});
