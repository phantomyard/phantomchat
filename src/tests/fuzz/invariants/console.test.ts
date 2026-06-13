import {describe, it, expect} from 'vitest';
import {consoleClean} from './console';
import type {FuzzContext, UserHandle} from '../types';

function fakeUser(consoleLog: string[], reloadTimes: number[] = [Date.now() - 60_000]): UserHandle {
  return {
    id: 'userA',
    context: null as any,
    page: null as any,
    displayName: 'A',
    npub: '',
    remotePeerId: 0,
    consoleLog,
    reloadTimes
  };
}

function ctx(aLog: string[], bLog: string[] = []): FuzzContext {
  return {
    users: {userA: fakeUser(aLog), userB: fakeUser(bLog)},
    relay: null as any,
    snapshots: new Map(),
    actionIndex: 100
  };
}

describe('INV-console-clean', () => {
  it('passes when log is clean', async () => {
    const r = await consoleClean.check(ctx([]));
    expect(r.ok).toBe(true);
  });

  it('passes when only allowlisted entries are present', async () => {
    const r = await consoleClean.check(ctx(['[log] [vite] hmr update', '[log] [ChatAPI] subscription active 4/4']));
    expect(r.ok).toBe(true);
  });

  it('passes internal-logger warnings including ANSI-prefixed variants', async () => {
    const r = await consoleClean.check(ctx([
      '[warning] %s [0.044] [IDB-tweb-common] performing idb upgrade from 0 to 8',
      '[warning] %s [36m%s [0.001] [MP-CRYPTO] attaching send port',
      '[warning] %s [0.036] [MP-MTPROTO] attaching send port'
    ]));
    expect(r.ok).toBe(true);
  });

  it('fails on pageerror entry', async () => {
    const r = await consoleClean.check(ctx(['[pageerror] ReferenceError: x is not defined\n    at …']));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('ReferenceError');
  });

  it('fails on console.error from our code', async () => {
    const r = await consoleClean.check(ctx(['[error] [ChatAPI] relay publish failed: 503']));
    expect(r.ok).toBe(false);
    expect(r.message).toContain('relay publish failed');
  });

  it('skips warmup window (5s after reload)', async () => {
    const justReloaded = fakeUser(['[error] [NostraSync] unexpected EOSE'], [Date.now() - 2000]);
    const c: FuzzContext = {
      users: {userA: justReloaded, userB: fakeUser([])},
      relay: null as any,
      snapshots: new Map(),
      actionIndex: 1
    };
    const r = await consoleClean.check(c);
    expect(r.ok).toBe(true);
  });
});
