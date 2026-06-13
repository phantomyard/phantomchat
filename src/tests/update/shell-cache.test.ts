import {describe, it, expect, beforeEach} from 'vitest';
import 'fake-indexeddb/auto';
import {shellCacheName, pendingCacheName, getActiveVersion, setActiveVersion, gcOrphans, atomicSwap} from '@lib/serviceWorker/shell-cache';

const store = new Map<string, Map<string, Response>>();
const cachesStub: CacheStorage = {
  async open(name: string) {
    if(!store.has(name)) store.set(name, new Map());
    const m = store.get(name)!;
    return {
      async put(req: any, res: Response) { m.set(typeof req === 'string' ? req : req.url, res.clone()); },
      async match(req: any) { return m.get(typeof req === 'string' ? req : req.url); },
      async delete(req: any) { return m.delete(typeof req === 'string' ? req : req.url); },
      async keys() { return Array.from(m.keys()).map((u) => new Request(u)); }
    } as any;
  },
  async has(name: string) { return store.has(name); },
  async delete(name: string) { return store.delete(name); },
  async keys() { return Array.from(store.keys()); },
  async match() { return undefined as any; }
};
(globalThis as any).caches = cachesStub;

beforeEach(() => {
  store.clear();
});

describe('shell-cache', () => {
  it('shellCacheName produces stable format', () => {
    expect(shellCacheName('0.12.0')).toBe('shell-v0.12.0');
    expect(pendingCacheName('0.12.0')).toBe('shell-v0.12.0-pending');
  });

  it('setActiveVersion + getActiveVersion round-trip', async() => {
    await setActiveVersion('0.12.0', 'ed25519:abc');
    const v = await getActiveVersion();
    expect(v?.version).toBe('0.12.0');
    expect(v?.keyFingerprint).toBe('ed25519:abc');
  });

  it('atomicSwap renames pending to active', async() => {
    const pending = await cachesStub.open(pendingCacheName('0.13.0'));
    await pending.put('https://localhost/foo.js', new Response('bar'));
    await setActiveVersion('0.12.0', 'ed25519:abc');
    await atomicSwap('0.12.0', '0.13.0', 'ed25519:abc');
    expect(await cachesStub.has('shell-v0.13.0')).toBe(true);
    expect(await cachesStub.has('shell-v0.13.0-pending')).toBe(false);
    expect(await cachesStub.has('shell-v0.12.0')).toBe(false);
    const v = await getActiveVersion();
    expect(v?.version).toBe('0.13.0');
  });

  it('gcOrphans removes pending caches not matching active', async() => {
    await cachesStub.open('shell-v0.11.0');
    await cachesStub.open('shell-v0.12.0-pending');
    await cachesStub.open('shell-v0.13.0');
    await setActiveVersion('0.13.0', 'ed25519:abc');
    await gcOrphans();
    expect(await cachesStub.has('shell-v0.11.0')).toBe(false);
    expect(await cachesStub.has('shell-v0.12.0-pending')).toBe(false);
    expect(await cachesStub.has('shell-v0.13.0')).toBe(true);
  });
});
