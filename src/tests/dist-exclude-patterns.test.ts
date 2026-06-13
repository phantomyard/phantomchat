import {describe, test, expect} from 'vitest';
import {DIST_EXCLUDE_PATTERNS} from '../scripts/build/fs-utils';

const excluded = (path: string): boolean =>
  DIST_EXCLUDE_PATTERNS.some((re) => re.test(path));

describe('DIST_EXCLUDE_PATTERNS — emit-update-manifest / validate-update-manifest', () => {
  test('excludes Cloudflare Pages _headers (always 404 in production)', () => {
    expect(excluded('dist/_headers')).toBe(true);
  });

  test('excludes Cloudflare Pages _redirects (always 404 in production)', () => {
    expect(excluded('dist/_redirects')).toBe(true);
  });

  test('does NOT exclude Vite chunks that happen to start with underscore', () => {
    expect(excluded('dist/_commonjsHelpers-Cpj98o6Y.js')).toBe(false);
  });

  test('does NOT exclude files whose path merely contains _headers / _redirects as a substring', () => {
    expect(excluded('dist/assets/some_headers_like.js')).toBe(false);
    expect(excluded('dist/_headersish.js')).toBe(false);
  });

  test('still excludes source maps', () => {
    expect(excluded('dist/sw-abc123.js.map')).toBe(true);
    expect(excluded('dist/assets/foo.css.map')).toBe(true);
  });

  test('still excludes update-manifest.json (the manifest should not reference itself)', () => {
    expect(excluded('dist/update-manifest.json')).toBe(true);
  });

  test('still excludes changelog markdown files', () => {
    expect(excluded('dist/changelogs/0.16.0.md')).toBe(true);
  });

  test('does NOT exclude actual bundle chunks', () => {
    expect(excluded('dist/index-abc123.js')).toBe(false);
    expect(excluded('dist/sw-DkjvAzWg.js')).toBe(false);
    expect(excluded('dist/assets/img/emoji/1f600.png')).toBe(false);
  });

  test('excludes Tor consensus binaries (regenerated each build, served immutable)', () => {
    expect(excluded('dist/webtor/consensus.br.bin')).toBe(true);
    expect(excluded('dist/webtor/microdescriptors.br.bin')).toBe(true);
  });

  test('does NOT exclude other webtor assets that have stable bytes', () => {
    expect(excluded('dist/webtor/webtor_wasm.js')).toBe(false);
    expect(excluded('dist/webtor/webtor_wasm_bg.wasm')).toBe(false);
    expect(excluded('dist/webtor/package.json')).toBe(false);
  });
});
