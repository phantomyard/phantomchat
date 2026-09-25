/*
 * Re-stamping the Windows update feed after Authenticode signing.
 *
 * The failure guarded against is silent at build time and fatal at update
 * time: electron-updater checks the downloaded installer against the feed's
 * sha512, so a feed still carrying the PRE-signing hash makes every Windows
 * update fail with a checksum error. Nothing in the build notices, because
 * the artifacts themselves are perfectly fine.
 */
import {describe, it, expect} from 'vitest';
import {createHash} from 'crypto';
import {restampUpdateFeed, sha512Base64} from './restamp-update-feed.mjs';
import {load} from 'js-yaml';

const X64 = 'PhantomChat-1.0.50-windows-x64.exe';
const ARM = 'PhantomChat-1.0.50-windows-arm64.exe';

const feed = `version: 1.0.50
files:
  - url: ${X64}
    sha512: STALE-X64
    size: 100
    blockMapSize: 42
  - url: ${ARM}
    sha512: STALE-ARM
    size: 100
    blockMapSize: 43
path: ${X64}
sha512: STALE-X64
releaseDate: '2026-09-25T00:00:00.000Z'
`;

// Kept as strings so the expected hashes below can be computed the same way
// without handing a Buffer to createHash — @types/node models Buffer as
// incompatible with BinaryLike here, and tsc --noEmit runs in its own CI job.
const BYTES: Record<string, string> = {
  [X64]: 'signed-x64-installer-bytes',
  [ARM]: 'signed-arm64-installer-bytes-which-are-longer',
};
const signed: Record<string, Buffer> = {
  [X64]: Buffer.from(BYTES[X64]),
  [ARM]: Buffer.from(BYTES[ARM]),
};

const restamp = (src = feed, read = (url: string) => signed[url]) =>
  load(restampUpdateFeed(src, read)) as any;

describe('restampUpdateFeed', () => {
  it('replaces every entry hash and size with the signed artifact on disk', () => {
    const out = restamp();
    expect(out.files.map((f: any) => f.sha512)).toEqual([
      createHash('sha512').update(BYTES[X64]).digest('base64'),
      createHash('sha512').update(BYTES[ARM]).digest('base64'),
    ]);
    expect(out.files.map((f: any) => f.size)).toEqual([
      signed[X64].length,
      signed[ARM].length,
    ]);
    // The whole point: no pre-signing hash survives anywhere in the feed.
    expect(JSON.stringify(out)).not.toContain('STALE');
  });

  it('keeps the legacy top-level fields in step with files[0]', () => {
    // Old clients read path/sha512 rather than files[]; leaving them stale
    // would reproduce the same broken update for exactly those clients.
    const out = restamp();
    expect(out.path).toBe(X64);
    expect(out.sha512).toBe(out.files[0].sha512);
  });

  it('preserves the entry order so the arch fallback still resolves', () => {
    // electron-updater falls back to files[0] when it cannot match an
    // architecture; re-ordering here would hand arm64 bytes to x64 machines.
    const out = restamp();
    expect(out.files.map((f: any) => f.url)).toEqual([X64, ARM]);
    expect(out.version).toBe('1.0.50');
  });

  it('drops blockMapSize, which described the unsigned bytes', () => {
    const out = restamp();
    for(const file of out.files) expect(file.blockMapSize).toBeUndefined();
  });

  it('aborts when an artifact named in the feed is missing', () => {
    // Fail closed: publishing the feed unchanged would advertise hashes for
    // bytes nobody will ever download.
    expect(() => restamp(feed, (url) => (url === ARM ? (undefined as any) : signed[url])))
      .toThrow(/missing or empty/);
  });

  it('aborts on an empty artifact', () => {
    expect(() => restamp(feed, () => Buffer.alloc(0))).toThrow(/missing or empty/);
  });

  it('rejects a feed with no files[]', () => {
    expect(() => restamp('version: 1.0.50\n')).toThrow(/no files/);
  });

  it('hashes with sha512/base64, the format electron-updater verifies', () => {
    expect(sha512Base64(Buffer.from('abc')) as string)
      .toBe(createHash('sha512').update('abc').digest('base64'));
  });
});
