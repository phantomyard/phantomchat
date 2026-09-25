/*
 * Ring resolution for notify-only installs. The releases list is untrusted
 * input from api.github.com, so every shape here is one the API can really
 * return: drafts, foreign tags, prereleases, out-of-order pages.
 */
import {describe, it, expect} from 'vitest';
import {
  versionFromTag,
  compareVersions,
  pickReleaseForChannel,
  isNotifiableUpdate,
  isReleasePageUrl,
  collectReleasesForChannel
} from './updateFeed';

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

  it('drops a release whose html_url is not a release page of this repo', () => {
    // html_url is untrusted API JSON and ends up at shell.openExternal, so a
    // hostile or merely wrong target must not survive as a clickable link.
    for(const url of [
      'https://evil.example/phantomyard/phantomchat/releases/tag/phantomchat-v1.0.60',
      'https://github.com.evil.example/phantomyard/phantomchat/releases/tag/x',
      'http://github.com/phantomyard/phantomchat/releases/tag/phantomchat-v1.0.60',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://github.com/phantomyard/other-repo/releases/tag/phantomchat-v1.0.60'
    ]) {
      const picked = pickReleaseForChannel([
        {tag_name: 'phantomchat-v1.0.60', draft: false, prerelease: false, html_url: url},
        release('phantomchat-v1.0.45')
      ], 'stable');
      expect(picked?.version, url).toBe('1.0.45');
    }
  });
});

describe('isReleasePageUrl', () => {
  it('accepts this repo\'s release pages over https', () => {
    expect(isReleasePageUrl('https://github.com/phantomyard/phantomchat/releases/tag/phantomchat-v1.0.50')).toBe(true);
    expect(isReleasePageUrl('https://github.com/phantomyard/phantomchat/releases/latest')).toBe(true);
  });

  it('rejects other hosts, other schemes, other repos and non-strings', () => {
    for(const url of [
      'https://evil.example/phantomyard/phantomchat/releases/tag/x',
      'https://github.com.evil.example/phantomyard/phantomchat/releases/tag/x',
      'https://raw.githubusercontent.com/phantomyard/phantomchat/releases/tag/x',
      'http://github.com/phantomyard/phantomchat/releases/tag/x',
      'javascript:alert(1)',
      'https://github.com/phantomyard/phantomchat/issues/1',
      'not a url',
      '',
      null,
      undefined,
      42,
      {}
    ]) {
      expect(isReleasePageUrl(url as unknown), String(url)).toBe(false);
    }
  });
});

describe('collectReleasesForChannel', () => {
  /** Pages of 3, newest-first: N previews then one stable, as main really looks. */
  const paged = (previews: number) => {
    const all = [
      ...Array.from({length: previews}, (_, i) => release(`phantomchat-v1.1.${previews - i}`, {prerelease: true})),
      release('phantomchat-v1.0.45')
    ];
    const pages: ReturnType<typeof release>[][] = [];
    for(let i = 0; i < all.length; i += 3) pages.push(all.slice(i, i + 3));
    return {
      pages,
      fetchPage: async(page: number) => pages[page - 1] ?? []
    };
  };

  it('keeps paging past a full page of previews until the stable ring appears', async() => {
    const {fetchPage} = paged(7);
    const calls: number[] = [];
    const releases = await collectReleasesForChannel('stable', (page) => {
      calls.push(page);
      return fetchPage(page);
    }, 10, 3);
    // This is the regression: with one fixed page the stable release is
    // invisible and a stable install is told it is up to date forever.
    expect(pickReleaseForChannel(releases, 'stable')?.version).toBe('1.0.45');
    expect(calls).toEqual([1, 2, 3]);
  });

  it('stops as soon as the ring is represented', async() => {
    const {fetchPage} = paged(2);
    const calls: number[] = [];
    await collectReleasesForChannel('preview', (page) => {
      calls.push(page);
      return fetchPage(page);
    }, 10, 3);
    expect(calls).toEqual([1]);
  });

  it('stops on a short page rather than asking for pages that cannot exist', async() => {
    const calls: number[] = [];
    const releases = await collectReleasesForChannel('stable', async(page) => {
      calls.push(page);
      return page === 1 ? [release('phantomchat-v1.1.0', {prerelease: true})] : [];
    }, 10, 3);
    expect(calls).toEqual([1]);
    expect(pickReleaseForChannel(releases, 'stable')).toBeNull();
  });

  it('honours the page bound when the ring never appears', async() => {
    let calls = 0;
    await collectReleasesForChannel('stable', async() => {
      calls++;
      return [
        release('phantomchat-v1.1.2', {prerelease: true}),
        release('phantomchat-v1.1.1', {prerelease: true}),
        release('phantomchat-v1.1.0', {prerelease: true})
      ];
    }, 4, 3);
    expect(calls).toBe(4);
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
