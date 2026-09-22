/*
 * Cache API keys on the desktop app:// origin (PR #152). Chromium's Cache API
 * only accepts http(s) request URLs, so '/<entry>' resolved against
 * app://localhost made every put/match reject.
 */
import {describe, it, expect} from 'vitest';
import {cacheKeyBase} from '@lib/files/cacheStorage';

describe('cacheKeyBase', () => {
  it('keeps origin-relative keys on the web (existing caches stay valid)', () => {
    expect(cacheKeyBase('https:')).toBe('/');
    expect(cacheKeyBase('http:')).toBe('/');
  });

  it('uses an absolute https base on the desktop app:// origin', () => {
    const base = cacheKeyBase('app:');
    expect(base).toMatch(/^https:\/\//);
    // The Cache API accepts it: a Request built from it is http(s).
    expect(new URL(base + 'some-file').protocol).toBe('https:');
  });

  it('falls back to the absolute base when the protocol is unknown', () => {
    expect(cacheKeyBase(undefined)).toMatch(/^https:\/\//);
  });
});
