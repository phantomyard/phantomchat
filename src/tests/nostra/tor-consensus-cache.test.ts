/**
 * Unit tests for tor-consensus-cache.
 *
 * Uses a hand-rolled in-memory CacheStorage shim because jsdom does not
 * provide `caches` out of the box.
 */
import {describe, it, expect, beforeEach, afterAll, vi} from 'vitest';

import '../setup';

class MemoryCache {
  store = new Map<string, Response>();

  async match(req: string | Request): Promise<Response | undefined> {
    const key = typeof req === 'string' ? req : req.url;
    const resp = this.store.get(key);
    return resp ? resp.clone() : undefined;
  }

  async put(req: string | Request, resp: Response): Promise<void> {
    const key = typeof req === 'string' ? req : req.url;
    this.store.set(key, resp.clone());
  }

  async delete(req: string | Request): Promise<boolean> {
    const key = typeof req === 'string' ? req : req.url;
    return this.store.delete(key);
  }
}

class MemoryCacheStorage {
  private caches = new Map<string, MemoryCache>();

  async open(name: string): Promise<MemoryCache> {
    let cache = this.caches.get(name);
    if(!cache) {
      cache = new MemoryCache();
      this.caches.set(name, cache);
    }
    return cache;
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }

  reset() {
    this.caches.clear();
  }
}

const memCaches = new MemoryCacheStorage();
(globalThis as any).caches = memCaches;

describe('tor-consensus-cache', () => {
  let mod: typeof import('@lib/nostra/tor-consensus-cache');

  beforeEach(async() => {
    memCaches.reset();
    vi.resetModules();
    mod = await import('@lib/nostra/tor-consensus-cache');
    vi.useRealTimers();
  });

  afterAll(() => {
    delete (globalThis as any).caches;
  });

  it('returns null when cache is empty', async() => {
    expect(await mod.getCachedConsensus()).toBeNull();
    expect(await mod.getCachedMicrodescs()).toBeNull();
  });

  it('saves and retrieves consensus bytes identically', async() => {
    const bytes = new Uint8Array([0x9b, 0x90, 0xff, 0x36, 0x07]);
    await mod.saveCachedConsensus(new Response(bytes));

    const cached = await mod.getCachedConsensus();
    expect(cached).not.toBeNull();
    const retrieved = new Uint8Array(await cached!.arrayBuffer());
    expect(retrieved).toEqual(bytes);
  });

  it('saves and retrieves microdescriptors bytes identically', async() => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    await mod.saveCachedMicrodescs(new Response(bytes));

    const cached = await mod.getCachedMicrodescs();
    expect(cached).not.toBeNull();
    const retrieved = new Uint8Array(await cached!.arrayBuffer());
    expect(retrieved).toEqual(bytes);
  });

  it('returns null when the entry is older than the TTL', async() => {
    const bytes = new Uint8Array([1, 2, 3]);

    // Save now
    const realNow = Date.now.bind(Date);
    const fakeNow = realNow();
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow);
    await mod.saveCachedConsensus(new Response(bytes));

    // Advance time past the 2 hour TTL
    vi.spyOn(Date, 'now').mockImplementation(() => fakeNow + (2 * 60 * 60 * 1000) + 1);

    const cached = await mod.getCachedConsensus();
    expect(cached).toBeNull();

    (Date.now as any).mockRestore();
  });

  it('returns a fresh clone each call so callers can consume independently', async() => {
    const bytes = new Uint8Array([9, 9, 9]);
    await mod.saveCachedConsensus(new Response(bytes));

    const a = await mod.getCachedConsensus();
    const b = await mod.getCachedConsensus();

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();

    const bytesA = new Uint8Array(await a!.arrayBuffer());
    const bytesB = new Uint8Array(await b!.arrayBuffer());
    expect(bytesA).toEqual(bytes);
    expect(bytesB).toEqual(bytes);
  });

  it('clearConsensusCache deletes everything', async() => {
    await mod.saveCachedConsensus(new Response(new Uint8Array([1])));
    await mod.saveCachedMicrodescs(new Response(new Uint8Array([2])));

    await mod.clearConsensusCache();

    expect(await mod.getCachedConsensus()).toBeNull();
    expect(await mod.getCachedMicrodescs()).toBeNull();
  });
});
