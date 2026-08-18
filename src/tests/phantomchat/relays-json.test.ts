/**
 * Tests for loadCanonicalRelays() — fetches the canonical relay list from the
 * static /relays.json endpoint (single source of truth shared with phantombot)
 * and falls back to the hardcoded DEFAULT_RELAYS when the fetch fails.
 */

import '../setup';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {DEFAULT_RELAYS, loadCanonicalRelays} from '@lib/phantomchat/nostr-relay-pool';

describe('loadCanonicalRelays', () => {
  const realFetch = globalThis.fetch;
  const realTestRelays = (globalThis as any).window?.__phantomchatTestRelays;

  afterEach(() => {
    globalThis.fetch = realFetch;
    if(typeof (globalThis as any).window !== 'undefined') {
      (globalThis as any).window.__phantomchatTestRelays = realTestRelays;
    }
  });

  function mockFetch(impl: () => Promise<Partial<Response>>) {
    globalThis.fetch = (() => impl()) as unknown as typeof fetch;
  }

  it('parses a valid relays.json into RelayConfig objects', async() => {
    mockFetch(async() => ({
      ok: true,
      json: async() => ({relays: ['wss://a.example', 'wss://b.example']})
    }));
    const relays = await loadCanonicalRelays();
    expect(relays).toEqual([
      {url: 'wss://a.example', read: true, write: true},
      {url: 'wss://b.example', read: true, write: true}
    ]);
  });

  it('filters out non-wss and non-string entries', async() => {
    mockFetch(async() => ({
      ok: true,
      json: async() => ({relays: ['wss://ok.example', 'http://bad.example', 42, null]})
    }));
    const relays = await loadCanonicalRelays();
    expect(relays).toEqual([{url: 'wss://ok.example', read: true, write: true}]);
  });

  it('returns null on a non-ok response (caller falls back to DEFAULT_RELAYS)', async() => {
    mockFetch(async() => ({ok: false, json: async() => ({})}));
    expect(await loadCanonicalRelays()).toBeNull();
  });

  it('returns null when relays is missing or not an array', async() => {
    mockFetch(async() => ({ok: true, json: async() => ({nope: true})}));
    expect(await loadCanonicalRelays()).toBeNull();
  });

  it('returns null when the array has no valid wss entries', async() => {
    mockFetch(async() => ({ok: true, json: async() => ({relays: ['http://x', 1]})}));
    expect(await loadCanonicalRelays()).toBeNull();
  });

  it('returns null when fetch throws (offline)', async() => {
    mockFetch(async() => {
      throw new Error('network down');
    });
    expect(await loadCanonicalRelays()).toBeNull();
  });

  it('returns null (skips fetch) when test relays are pinned', async() => {
    if(typeof (globalThis as any).window === 'undefined') {
      (globalThis as any).window = {};
    }
    (globalThis as any).window.__phantomchatTestRelays = [
      {url: 'wss://pinned.example', read: true, write: true}
    ];
    let fetched = false;
    mockFetch(async() => {
      fetched = true;
      return {ok: true, json: async() => ({relays: ['wss://x']})};
    });
    expect(await loadCanonicalRelays()).toBeNull();
    expect(fetched).toBe(false);
  });
});

/**
 * public/relays.json is the single source of truth at runtime (phantombot fetches
 * the same URL over HTTP), and DEFAULT_RELAYS is the build-time disaster net used
 * only when that fetch fails. They are two hand-maintained copies of one list, so
 * they silently drift — a cold-start client would then dial a relay set nobody
 * validated. This test is the only thing that couples them.
 */
describe('relays.json / DEFAULT_RELAYS parity', () => {
  const canonical: string[] = JSON.parse(
    readFileSync(resolve(__dirname, '../../../public/relays.json'), 'utf8')
  ).relays;

  it('public/relays.json contains only wss:// URLs and no duplicates', () => {
    expect(canonical.length).toBeGreaterThan(0);
    for(const url of canonical) expect(url.startsWith('wss://')).toBe(true);
    expect(new Set(canonical).size).toBe(canonical.length);
  });

  it('DEFAULT_RELAYS matches public/relays.json exactly, in order', () => {
    expect(DEFAULT_RELAYS.map((r) => r.url)).toEqual(canonical);
  });

  it('every DEFAULT_RELAYS entry is read+write', () => {
    for(const r of DEFAULT_RELAYS) {
      expect(r.read).toBe(true);
      expect(r.write).toBe(true);
    }
  });
});
