/**
 * Tests for the canonical Blossom server list (/blossom.json) and helper
 * expanders used by multi-mirror write / multi-GET receive (issue #86).
 */

import '../setup';
import {
  DEFAULT_BLOSSOM_SERVERS,
  loadCanonicalBlossomServers,
  getBlossomServers,
  __resetBlossomServersCacheForTests,
  blossomHashUrl,
  expandBlossomFetchUrls,
  BLOSSOM_MIRROR_MIN
} from '@lib/phantomchat/blossom-servers';

describe('blossom-servers', () => {
  const realFetch = globalThis.fetch;
  const realOverride = (globalThis as any).window?.__phantomchatTestBlossom;

  afterEach(() => {
    globalThis.fetch = realFetch;
    __resetBlossomServersCacheForTests();
    if(typeof (globalThis as any).window !== 'undefined') {
      (globalThis as any).window.__phantomchatTestBlossom = realOverride;
    }
  });

  function mockFetch(impl: () => Promise<Partial<Response>>) {
    globalThis.fetch = (() => impl()) as unknown as typeof fetch;
  }

  it('ships a solid public default of ≥3 https servers', () => {
    expect(DEFAULT_BLOSSOM_SERVERS.length).toBeGreaterThanOrEqual(3);
    for(const s of DEFAULT_BLOSSOM_SERVERS) {
      expect(s.startsWith('https://')).toBe(true);
    }
    // Dead CDN we deliberately dropped on 2026-07-16.
    expect(DEFAULT_BLOSSOM_SERVERS).not.toContain('https://cdn.satellite.earth');
    expect(BLOSSOM_MIRROR_MIN).toBeGreaterThanOrEqual(2);
  });

  it('parses a valid blossom.json into a server list', async() => {
    mockFetch(async() => ({
      ok: true,
      json: async() => ({servers: ['https://a.example', 'https://b.example']})
    }));
    const servers = await loadCanonicalBlossomServers();
    expect(servers).toEqual(['https://a.example', 'https://b.example']);
  });

  it('filters non-https and non-string entries + de-dupes', async() => {
    mockFetch(async() => ({
      ok: true,
      json: async() => ({
        servers: ['https://ok.example/', 'http://bad.example', 42, null, 'https://ok.example']
      })
    }));
    const servers = await loadCanonicalBlossomServers();
    expect(servers).toEqual(['https://ok.example']);
  });

  it('returns null on non-ok / malformed so getBlossomServers falls back', async() => {
    mockFetch(async() => ({ok: false, json: async() => ({})}));
    expect(await loadCanonicalBlossomServers()).toBeNull();

    mockFetch(async() => ({ok: true, json: async() => ({nope: true})}));
    expect(await loadCanonicalBlossomServers()).toBeNull();

    const servers = await getBlossomServers();
    expect(servers).toEqual([...DEFAULT_BLOSSOM_SERVERS]);
  });

  it('honors window.__phantomchatTestBlossom override (MockBlossom e2e)', async() => {
    if(typeof (globalThis as any).window === 'undefined') {
      (globalThis as any).window = {};
    }
    (globalThis as any).window.__phantomchatTestBlossom = 'https://mock.local:9';
    let fetched = false;
    mockFetch(async() => {
      fetched = true;
      return {ok: true, json: async() => ({servers: ['https://x']})};
    });
    const servers = await getBlossomServers();
    expect(servers).toEqual(['https://mock.local:9']);
    expect(fetched).toBe(false);
  });

  it('builds hash URLs and expands fetch candidates primary → mirrors → hash', () => {
    const sha = 'ab'.repeat(32);
    expect(blossomHashUrl('https://a.example/', sha)).toBe(`https://a.example/${sha}`);

    const expanded = expandBlossomFetchUrls(
      'https://primary.example/x',
      sha,
      ['https://mirror1.example/x', 'https://primary.example/x'],
      ['https://a.example', 'https://b.example']
    );
    expect(expanded[0]).toBe('https://primary.example/x');
    expect(expanded).toContain('https://mirror1.example/x');
    expect(expanded).toContain(`https://a.example/${sha}`);
    expect(expanded).toContain(`https://b.example/${sha}`);
    // de-dupe
    expect(expanded.filter((u) => u === 'https://primary.example/x')).toHaveLength(1);
  });
});
