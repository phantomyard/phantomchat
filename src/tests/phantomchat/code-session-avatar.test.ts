/**
 * The FIXED Code Mode session avatar (#279).
 *
 * Every coding session wears the same code sigil regardless of its phantom —
 * "a fixed code themed avatar for the group" (Andrew, 2026-10-29). The SVG has
 * no seed parameter, so two calls must be byte-identical, and the cached blob
 * URL must be stable.
 */
import {describe, it, expect, beforeEach} from 'vitest';
import {
  generateCodeSessionAvatarSvg,
  generateCodeSessionAvatar,
  clearCodeSessionAvatar
} from '@helpers/generateDicebearAvatar';

describe('generateCodeSessionAvatarSvg', () => {
  beforeEach(() => {
    clearCodeSessionAvatar();
  });

  it('is FIXED — two calls render byte-identical SVG', () => {
    expect(generateCodeSessionAvatarSvg()).toBe(generateCodeSessionAvatarSvg());
  });

  it('produces a valid SVG document', () => {
    const svg = generateCodeSessionAvatarSvg();
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg.includes('</svg>')).toBe(true);
  });

  it('carries the circle clip language shared with the phantom avatars', () => {
    expect(generateCodeSessionAvatarSvg()).toContain('viewBox="0 0 128 128"');
    expect(generateCodeSessionAvatarSvg()).toContain('<circle cx="64" cy="64" r="64"');
  });
});

describe('generateCodeSessionAvatar (blob URL cache)', () => {
  it('returns the same URL until cleared', () => {
    clearCodeSessionAvatar();
    const first = generateCodeSessionAvatar();
    const second = generateCodeSessionAvatar();
    expect(first).toBe(second);
    expect(/^(blob:|data:image\/svg\+xml)/.test(first)).toBe(true);
  });

  it('still yields a usable URL after clearCodeSessionAvatar (cache invalidation is safe)', () => {
    clearCodeSessionAvatar();
    generateCodeSessionAvatar();
    clearCodeSessionAvatar();
    const second = generateCodeSessionAvatar();
    expect(/^(blob:|data:image\/svg\+xml)/.test(second)).toBe(true);
  });
});
