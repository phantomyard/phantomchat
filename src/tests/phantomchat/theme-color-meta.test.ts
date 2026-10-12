import {describe, expect, it} from 'vitest';

import {applyThemeColorToMeta} from '../../helpers/themeColorMeta';

/**
 * Issue #213: the PWA title bar (painted from <meta name="theme-color">)
 * must get the theme palette color at startup, not only after a theme
 * toggle. index.html ships a media-scoped meta pair for the pre-boot paint;
 * applyThemeColorToMeta must collapse it to one unscoped meta when the app
 * sets the real color, otherwise the scoped metas keep overriding the
 * app-driven color per system color-scheme.
 */

function makeHead(html: string): HTMLHeadElement {
  const head = document.createElement('head');
  head.innerHTML = html;
  document.documentElement.appendChild(head);
  return head;
}

function themeColorMetas(head: HTMLHeadElement): {content: string; media: string | null}[] {
  return Array.from(head.querySelectorAll('meta[name="theme-color"]')).map((meta) => ({
    content: meta.getAttribute('content') ?? '',
    media: meta.getAttribute('media')
  }));
}

describe('applyThemeColorToMeta (#213 PWA theme-color on startup)', () => {
  it('collapses the media-scoped startup pair into one unscoped meta', () => {
    const head = makeHead(`
      <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">
      <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#14161D">
      <meta name="description" content="x">
    `);

    applyThemeColorToMeta(head, '#5CC85E');

    const metas = themeColorMetas(head);
    expect(metas).toHaveLength(1);
    expect(metas[0].content).toBe('#5CC85E');
    expect(metas[0].media).toBeNull();
    // unrelated metas untouched
    expect(head.querySelectorAll('meta[name="description"]')).toHaveLength(1);
  });

  it('updates a plain (already unscoped) meta in place', () => {
    const head = makeHead(`<meta name="theme-color" content="#ffffff">`);

    applyThemeColorToMeta(head, '#3080FF');

    const metas = themeColorMetas(head);
    expect(metas).toHaveLength(1);
    expect(metas[0].content).toBe('#3080FF');
    expect(metas[0].media).toBeNull();
  });

  it('is a no-op when no theme-color meta exists', () => {
    const head = makeHead(`<meta name="description" content="x">`);

    expect(() => applyThemeColorToMeta(head, '#3080FF')).not.toThrow();
    expect(themeColorMetas(head)).toHaveLength(0);
  });

  it('keeps working across repeated calls (fullscreen-call #000000 override)', () => {
    const head = makeHead(`
      <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff">
      <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#14161D">
    `);

    applyThemeColorToMeta(head, '#5CC85E');
    // call components force black in fullscreen and restore afterwards
    applyThemeColorToMeta(head, '#000000');
    applyThemeColorToMeta(head, '#5CC85E');

    const metas = themeColorMetas(head);
    expect(metas).toHaveLength(1);
    expect(metas[0].content).toBe('#5CC85E');
    expect(metas[0].media).toBeNull();
  });
});
