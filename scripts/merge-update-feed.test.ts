/*
 * Feed merging (issue #164). The failure this guards against is silent and
 * user-visible: a clobbered latest.yml hands every Windows machine the
 * installer for the OTHER architecture on its next update.
 */
import {describe, it, expect} from 'vitest';
// Plain .mjs helper — imported for its exported merge function.
import {mergeUpdateFeeds} from './merge-update-feed.mjs';
import {load} from 'js-yaml';

const feed = (version: string, url: string, sha = 'AAAA') => `version: ${version}
files:
  - url: ${url}
    sha512: ${sha}
    size: 100
path: ${url}
sha512: ${sha}
releaseDate: '2026-09-25T00:00:00.000Z'
`;

const X64 = 'PhantomChat-1.0.50-windows-x64.exe';
const ARM = 'PhantomChat-1.0.50-windows-arm64.exe';

describe('mergeUpdateFeeds', () => {
  it('lists both architectures in one feed', () => {
    const merged = load(mergeUpdateFeeds([feed('1.0.50', X64), feed('1.0.50', ARM, 'BBBB')])) as any;
    expect(merged.files.map((f: any) => f.url)).toEqual([X64, ARM]);
    expect(merged.version).toBe('1.0.50');
  });

  it('keeps the first input as the fallback entry', () => {
    // electron-updater falls back to files[0] when it cannot match an
    // architecture, so the common one has to come first.
    const merged = load(mergeUpdateFeeds([feed('1.0.50', X64, 'AAAA'), feed('1.0.50', ARM, 'BBBB')])) as any;
    expect(merged.path).toBe(X64);
    expect(merged.sha512).toBe('AAAA');
  });

  it('produces a feed each architecture resolves correctly', () => {
    // Mirrors electron-updater's Provider.findFile: match process.arch
    // against the file name, else take the first.
    const merged = load(mergeUpdateFeeds([feed('1.0.50', X64), feed('1.0.50', ARM, 'BBBB')])) as any;
    const pick = (arch: string) =>
      (merged.files.find((f: any) => f.url.includes(arch)) ?? merged.files[0]).url;
    expect(pick('x64')).toBe(X64);
    expect(pick('arm64')).toBe(ARM);
  });

  it('refuses to merge feeds from different versions', () => {
    expect(() => mergeUpdateFeeds([feed('1.0.50', X64), feed('1.0.51', ARM)]))
      .toThrow(/version mismatch/i);
  });

  it('refuses a duplicate artifact — the clobber this script exists to prevent', () => {
    expect(() => mergeUpdateFeeds([feed('1.0.50', X64), feed('1.0.50', X64)]))
      .toThrow(/duplicate artifact/i);
  });

  it('rejects a feed with no files list', () => {
    expect(() => mergeUpdateFeeds(["version: 1.0.50\npath: x\n"])).toThrow(/files/i);
  });

  it('rejects a feed with no version', () => {
    expect(() => mergeUpdateFeeds(["files:\n  - url: a\n    sha512: b\n"])).toThrow(/version/i);
  });

  it('rejects malformed file entries rather than emitting an unusable feed', () => {
    expect(() => mergeUpdateFeeds(["version: 1.0.50\nfiles:\n  - url: a\n"])).toThrow(/malformed/i);
  });

  it('rejects empty input', () => {
    expect(() => mergeUpdateFeeds([])).toThrow(/no feed files/i);
  });

  it('passes a single feed through unchanged in substance', () => {
    const merged = load(mergeUpdateFeeds([feed('1.0.50', X64)])) as any;
    expect(merged.files).toHaveLength(1);
    expect(merged.path).toBe(X64);
  });
});
