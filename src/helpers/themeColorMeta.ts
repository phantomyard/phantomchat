/*
 * PWA theme-color meta handling (issue #213).
 *
 * index.html ships TWO media-scoped `theme-color` metas so the browser can
 * paint the PWA window title bar correctly before the app boots (dark system
 * theme -> #14161D, light -> #ffffff). Once the app knows the real theme
 * palette color, that pair must collapse into a single unscoped meta:
 * a scoped pair would keep overriding the app-driven color whenever the
 * system color-scheme matches its media query.
 */

export function applyThemeColorToMeta(head: HTMLHeadElement, color: string): void {
  const first = head.querySelector('meta[name="theme-color"]');
  if(!first) {
    return;
  }

  if(first.hasAttribute('media')) {
    first.removeAttribute('media');
    head.querySelectorAll('meta[name="theme-color"][media]').forEach((meta) => meta.remove());
  }

  first.setAttribute('content', color);
}
