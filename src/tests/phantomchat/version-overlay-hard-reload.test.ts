/*
 * Version-overlay hard recovery — issue #223.
 *
 * The bug: closing/opening the PWA shortly after a deploy showed the
 * "WebK has updated — click anywhere to reload" version-yield overlay on
 * every cold start. The running shell was older than a build that had already
 * run on the device (k_build is monotonic), and the overlay's tap handler was
 * a plain location.reload() — which the service worker (cache-first, no
 * expiry for .js) and the HTTP cache (max-age=600) served from the SAME stale
 * copies. Recovery looped forever; the working escape (hardReloadClearingCaches)
 * was unreachable behind the overlay.
 *
 * Fix pinned here:
 *  1. the overlay's tap goes through hardReloadClearingCaches — SW unregister
 *     + CacheStorage clear BEFORE navigating;
 *  2. the navigation itself is cache-busted (?pc_cb=<ts>), so even the HTTP
 *     cache cannot re-serve the old shell — no bare location.reload() survives
 *     in the recovery path;
 *  3. the marker is stripped from the URL once the fresh shell has landed.
 */
import {describe, it, expect, afterEach, vi} from 'vitest';
import {readFileSync} from 'fs';
import {join} from 'path';

const SRC = join(__dirname, '../..');
const indexSrc = readFileSync(join(SRC, 'index.ts'), 'utf8');
const checkerSrc = readFileSync(join(SRC, 'lib/phantomchat/phantomchat-update-checker.ts'), 'utf8');
// Code only — the file's comments legitimately discuss location.reload() when
// explaining the #223 loop, so contracts must not trip over their own docs.
const checkerCode = checkerSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('cache-busted navigation target (#223)', () => {
  it('adds a fresh bust marker and preserves hash + existing params', async() => {
    const {cacheBustedHref, CACHE_BUST_PARAM} = await import('../../lib/phantomchat/phantomchat-update-checker');
    const out = new URL(cacheBustedHref('https://pc.test/app?tgaddr=x#/chats', 123));
    expect(out.searchParams.get(CACHE_BUST_PARAM)).toBe('123');
    expect(out.searchParams.get('tgaddr')).toBe('x');
    expect(out.hash).toBe('#/chats');
  });

  it('replaces a stale marker instead of stacking a second one', async() => {
    const {cacheBustedHref, CACHE_BUST_PARAM} = await import('../../lib/phantomchat/phantomchat-update-checker');
    const out = new URL(cacheBustedHref('https://pc.test/app?pc_cb=1#/x', 999));
    expect(out.searchParams.getAll(CACHE_BUST_PARAM)).toEqual(['999']);
    expect(out.href).not.toContain('pc_cb=1');
  });

  it('each bust yields a URL distinct from the previous one', async() => {
    const {cacheBustedHref} = await import('../../lib/phantomchat/phantomchat-update-checker');
    expect(cacheBustedHref('https://pc.test/app', 1)).not.toBe(cacheBustedHref('https://pc.test/app', 2));
  });

  it('strips the marker after landing, and only then', async() => {
    const {stripCacheBustParam, CACHE_BUST_PARAM} = await import('../../lib/phantomchat/phantomchat-update-checker');
    const dirty = 'https://pc.test/app?pc_cb=123&tgaddr=x#/chats';
    const url = new URL(stripCacheBustParam(dirty));
    expect(url.searchParams.has(CACHE_BUST_PARAM)).toBe(false);
    expect(url.searchParams.get('tgaddr')).toBe('x');
    expect(url.hash).toBe('#/chats');
    // No marker present -> returned byte-identical, no URL normalization churn.
    const clean = 'https://pc.test/app';
    expect(stripCacheBustParam(clean)).toBe(clean);
  });
});

describe('hardReloadClearingCaches — clear first, navigate cache-busted (#223)', () => {
  it('unregisters every service worker and clears every cache bucket before navigating', async() => {
    // Import with real globals first: @config/app reads location at import
    // time, so stub only around the call itself.
    const {hardReloadClearingCaches} = await import('../../lib/phantomchat/phantomchat-update-checker');
    const order: string[] = [];
    const regs = [
      {unregister: () => (order.push('unregister:0'), Promise.resolve(true))},
      {unregister: () => (order.push('unregister:1'), Promise.resolve(true))}
    ];
    vi.stubGlobal('navigator', {serviceWorker: {getRegistrations: () => Promise.resolve(regs)}});
    vi.stubGlobal('caches', {
      keys: () => Promise.resolve(['shell-v1', 'assets-v1']),
      delete: (k: string) => (order.push('clear:' + k), Promise.resolve(true))
    });
    vi.stubGlobal('location', {
      href: 'https://pc.test/app?pc_cb=1#/chats',
      replace: (href: string) => order.push('navigate:' + href)
    });

    await hardReloadClearingCaches();

    expect(order.filter((e) => e.startsWith('unregister:'))).toHaveLength(2);
    expect(order.filter((e) => e.startsWith('clear:')).sort()).toEqual(['clear:assets-v1', 'clear:shell-v1']);
    // Nothing may navigate until every cache path has been torn down — a
    // navigate-before-clear re-arms the exact #223 loop.
    const navIdx = order.findIndex((e) => e.startsWith('navigate:'));
    expect(navIdx).toBeGreaterThan(-1);
    expect(order.slice(0, navIdx).every((e) => e.startsWith('unregister:') || e.startsWith('clear:'))).toBe(true);
  });

  it('navigates to a cache-busted URL — never a plain reload', async() => {
    const {hardReloadClearingCaches} = await import('../../lib/phantomchat/phantomchat-update-checker');
    const replaced: string[] = [];
    vi.stubGlobal('navigator', {serviceWorker: {getRegistrations: () => Promise.resolve([])}});
    vi.stubGlobal('caches', {keys: () => Promise.resolve([]), delete: () => Promise.resolve(true)});
    vi.stubGlobal('location', {
      href: 'https://pc.test/app?pc_cb=41#/chats',
      replace: (href: string) => replaced.push(href)
    });

    await hardReloadClearingCaches();

    expect(replaced).toHaveLength(1);
    const url = new URL(replaced[0]);
    expect(url.searchParams.has('pc_cb')).toBe(true);
    expect(url.searchParams.get('pc_cb')).not.toBe('41'); // fresh value, old shell unreachable
    expect(url.hash).toBe('#/chats');
    expect(replaced[0]).not.toBe('https://pc.test/app?pc_cb=41#/chats');
  });

  it('still navigates when cache teardown fails — partial clear beats a bricked overlay', async() => {
    const {hardReloadClearingCaches} = await import('../../lib/phantomchat/phantomchat-update-checker');
    const replaced: string[] = [];
    vi.stubGlobal('navigator', {serviceWorker: {getRegistrations: () => Promise.reject(new Error('boom'))}});
    vi.stubGlobal('caches', {
      keys: () => Promise.reject(new Error('boom')),
      delete: () => Promise.resolve(true)
    });
    vi.stubGlobal('location', {
      href: 'https://pc.test/app',
      replace: (href: string) => replaced.push(href)
    });

    await hardReloadClearingCaches();
    expect(replaced).toHaveLength(1);
  });
});

describe('wiring contracts (#223)', () => {
  it('the version overlay tap routes through hardReloadClearingCaches', () => {
    // The popup close handler for reason 'version' must be the hard recovery,
    // with a plain reload only as the module-load failure fallback.
    const handler = indexSrc.match(/const onVersionClick = \(\) => \{([\s\S]*?)\n  \};/);
    expect(handler).toBeTruthy();
    expect(handler![1]).toContain('hardReloadClearingCaches');
    expect(handler![1]).toMatch(/catch\(\(\) => appNavigationController\.reload\(\)\)/);
    expect(indexSrc).toMatch(/version:\s*\{[\s\S]*?onClick:\s*onVersionClick/);
  });

  it('no plain location.reload() survives in the update-checker recovery path', () => {
    // THE #223 loop: reload into the same caches. If this ever comes back,
    // the overlay bricks again on every stale serve.
    expect(checkerCode).not.toMatch(/location\.reload\(/);
    expect(checkerCode).toMatch(/location\.replace\(cacheBustedHref\(location\.href\)\)/);
  });

  it('the boot path strips the bust marker so it never lingers in the URL', () => {
    expect(checkerSrc).toMatch(/startUpdateChecker[\s\S]*stripCacheBustParam\(location\.href\)[\s\S]*history\.replaceState/);
  });

  it('recovery still leaves user data alone — only app-shell caches are touched', () => {
    // IndexedDB / localStorage must never appear as a teardown target.
    const fn = checkerSrc.match(/export async function hardReloadClearingCaches[\s\S]*?\n\}/);
    expect(fn).toBeTruthy();
    expect(fn![0]).not.toMatch(/indexedDB|localStorage/);
  });
});
