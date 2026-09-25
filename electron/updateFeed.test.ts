/*
 * Ring resolution for notify-only installs. The releases list is untrusted
 * input from api.github.com, so every shape here is one the API can really
 * return: drafts, foreign tags, prereleases, out-of-order pages.
 */
import {describe, it, expect} from 'vitest';
import {versionFromTag, compareVersions, pickReleaseForChannel, isNotifiableUpdate} from './updateFeed';

const release = (tag: string, opts: {prerelease?: boolean, draft?: boolean} = {}) => ({
  tag_name: tag,
  draft: opts.draft ?? false,
  prerelease: opts.prerelease ?? false,
  html_url: `https://github.com/phantomyard/phantomchat/releases/tag/${tag}`
});

describe('versionFromTag', () => {
  it('extracts the version from a desktop tag', () => {
    expect(versionFromTag('phantomchat-v1.0.50')).toBe('1.0.50');
  });

  it('rejects tags belonging to anything else in the repo', () => {
    for(const tag of ['v1.0.50', 'phantombot-v1.1.401', 'phantomchat-1.0.50', 'release-1.0.50']) {
      expect(versionFromTag(tag)).toBeNull();
    }
  });

  it('rejects malformed versions rather than half-parsing them', () => {
    for(const tag of ['phantomchat-v1.0', 'phantomchat-v1.0.50-rc1', 'phantomchat-vx.y.z', 'phantomchat-v']) {
      expect(versionFromTag(tag)).toBeNull();
    }
  });

  it('rejects non-string tags', () => {
    for(const tag of [null, undefined, 42, {}]) expect(versionFromTag(tag)).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    // The regression this guards: '1.0.9' > '1.0.10' as strings, which would
    // strand every user the moment the build counter crossed a power of ten.
    expect(compareVersions('1.0.10', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.100', '1.0.99')).toBeGreaterThan(0);
  });

  it('is zero for equal versions and symmetric otherwise', () => {
    expect(compareVersions('1.0.50', '1.0.50')).toBe(0);
    expect(compareVersions('1.0.49', '1.0.50')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '1.9.9')).toBeGreaterThan(0);
  });
});

describe('pickReleaseForChannel', () => {
  it('preview takes the newest release of either kind', () => {
    const picked = pickReleaseForChannel([
      release('phantomchat-v1.0.45'),
      release('phantomchat-v1.0.50', {prerelease: true})
    ], 'preview');
    expect(picked?.version).toBe('1.0.50');
    expect(picked?.prerelease).toBe(true);
  });

  it('stable skips prereleases entirely', () => {
    const picked = pickReleaseForChannel([
      release('phantomchat-v1.0.50', {prerelease: true}),
      release('phantomchat-v1.0.45')
    ], 'stable');
    expect(picked?.version).toBe('1.0.45');
    expect(picked?.prerelease).toBe(false);
  });

  it('ignores drafts in both rings', () => {
    const releases = [release('phantomchat-v1.0.60', {draft: true}), release('phantomchat-v1.0.45')];
    expect(pickReleaseForChannel(releases, 'stable')?.version).toBe('1.0.45');
    expect(pickReleaseForChannel(releases, 'preview')?.version).toBe('1.0.45');
  });

  it('ignores releases from other products sharing the repo', () => {
    const picked = pickReleaseForChannel([
      release('some-other-v9.9.9'),
      release('phantomchat-v1.0.45')
    ], 'stable');
    expect(picked?.version).toBe('1.0.45');
  });

  it('orders by version, not by the position GitHub happened to return', () => {
    const picked = pickReleaseForChannel([
      release('phantomchat-v1.0.9'),
      release('phantomchat-v1.0.10'),
      release('phantomchat-v1.0.8')
    ], 'stable');
    expect(picked?.version).toBe('1.0.10');
  });

  it('returns null when the ring is empty', () => {
    expect(pickReleaseForChannel([], 'stable')).toBeNull();
    expect(pickReleaseForChannel([release('phantomchat-v1.0.50', {prerelease: true})], 'stable')).toBeNull();
  });

  it('skips entries missing an html_url rather than emitting an unopenable link', () => {
    const picked = pickReleaseForChannel([
      {tag_name: 'phantomchat-v1.0.60', draft: false, prerelease: false},
      release('phantomchat-v1.0.45')
    ], 'stable');
    expect(picked?.version).toBe('1.0.45');
  });
});

describe('isNotifiableUpdate', () => {
  const stable45 = pickReleaseForChannel([release('phantomchat-v1.0.45')], 'stable');

  it('notifies on a strictly newer release', () => {
    expect(isNotifiableUpdate('1.0.44', stable45)).toBe(true);
  });

  it('stays silent on the same version', () => {
    expect(isNotifiableUpdate('1.0.45', stable45)).toBe(false);
  });

  it('stays silent when the ring is BEHIND the installed build', () => {
    // A preview user who switches to stable on macOS: they run 1.0.50, the
    // stable ring offers 1.0.45. We cannot install anything on the notify
    // path, so prompting them to "update" downwards is pure noise.
    expect(isNotifiableUpdate('1.0.50', stable45)).toBe(false);
  });

  it('stays silent with no candidate or an unparseable current version', () => {
    expect(isNotifiableUpdate('1.0.45', null)).toBe(false);
    expect(isNotifiableUpdate('0.0.0-ci.7', stable45)).toBe(false);
  });
});
