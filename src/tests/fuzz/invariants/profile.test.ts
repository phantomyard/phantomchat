// @ts-nocheck
// @vitest-environment node
import {describe, it, expect} from 'vitest';
import {invProfileKind0SingleActive, invProfileCacheCoherent, invProfilePropagates} from './profile';

function mkRelay(events: any[]) {
  return {getAllEvents: async () => events};
}

function mkPage(opts: {ownPubkey?: string; cache?: any; peers?: any} = {}) {
  return {
    evaluate: async (fn: any, arg?: any) => {
      // Best-effort simulation of browser-side evaluate.
      const src = String(fn);
      // We implement tiny sniffers based on what the invariant reads.
      if(src.includes('__nostraOwnPubkey')) return opts.ownPubkey ?? null;
      if(src.includes('nostra-profile-cache')) return opts.cache ?? null;
      if(src.includes('apiManagerProxy')) {
        const peers = opts.peers ?? {};
        for(const p of Object.values(peers) as any[]) {
          if(!p) continue;
          if(p.first_name === arg || p.display_name === arg) return true;
        }
        return false;
      }
      return null;
    },
    waitForTimeout: async () => {}
  };
}

function mkCtx(opts: {
  events?: any[];
  users?: Record<string, any>;
} = {}) {
  return {
    relay: mkRelay(opts.events ?? []),
    users: opts.users ?? {userA: {page: mkPage()}, userB: {page: mkPage()}},
    snapshots: new Map(),
    actionIndex: 0
  };
}

describe('INV-profile-kind0-single-active', () => {
  it('passes when no kind-0 events', async () => {
    const ctx = mkCtx({events: []});
    const r = await invProfileKind0SingleActive.check(ctx as any);
    expect(r.ok).toBe(true);
  });

  it('passes when multiple kind-0 for same pubkey with different created_at', async () => {
    const ctx = mkCtx({events: [
      {kind: 0, pubkey: 'A', created_at: 1},
      {kind: 0, pubkey: 'A', created_at: 2},
      {kind: 0, pubkey: 'B', created_at: 5}
    ]});
    const r = await invProfileKind0SingleActive.check(ctx as any);
    expect(r.ok).toBe(true);
  });

  it('fails when two kind-0 share the same created_at for one pubkey', async () => {
    const ctx = mkCtx({events: [
      {kind: 0, pubkey: 'A', created_at: 5},
      {kind: 0, pubkey: 'A', created_at: 5}
    ]});
    const r = await invProfileKind0SingleActive.check(ctx as any);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/kind-0/);
  });

  it('skips non-kind-0 events', async () => {
    const ctx = mkCtx({events: [
      {kind: 1059, pubkey: 'A', created_at: 1},
      {kind: 1059, pubkey: 'A', created_at: 1}
    ]});
    const r = await invProfileKind0SingleActive.check(ctx as any);
    expect(r.ok).toBe(true);
  });
});

describe('INV-profile-cache-coherent', () => {
  it('passes when cache name matches latest relay kind-0 name', async () => {
    const events = [{
      kind: 0,
      pubkey: 'pubkeyA',
      created_at: 10,
      content: JSON.stringify({name: 'Alice'})
    }];
    const userA = {page: mkPage({
      ownPubkey: 'pubkeyA',
      cache: {name: 'Alice', created_at: 10}
    })};
    const userB = {page: mkPage()};
    const ctx = mkCtx({events, users: {userA, userB}});
    const r = await invProfileCacheCoherent.check(ctx as any);
    expect(r.ok).toBe(true);
  });

  it('fails when cache name != latest relay kind-0 name', async () => {
    const events = [{
      kind: 0,
      pubkey: 'pubkeyA',
      created_at: 20,
      content: JSON.stringify({name: 'Bob'})
    }];
    const userA = {page: mkPage({
      ownPubkey: 'pubkeyA',
      cache: {name: 'Alice', created_at: 20}
    })};
    const userB = {page: mkPage()};
    const ctx = mkCtx({events, users: {userA, userB}});
    const r = await invProfileCacheCoherent.check(ctx as any);
    expect(r.ok).toBe(false);
  });

  it('passes when cache created_at is newer than relay (in-flight publish)', async () => {
    const events = [{
      kind: 0,
      pubkey: 'pubkeyA',
      created_at: 5,
      content: JSON.stringify({name: 'OldAlice'})
    }];
    const userA = {page: mkPage({
      ownPubkey: 'pubkeyA',
      cache: {name: 'Alice', created_at: 99}
    })};
    const userB = {page: mkPage()};
    const ctx = mkCtx({events, users: {userA, userB}});
    const r = await invProfileCacheCoherent.check(ctx as any);
    expect(r.ok).toBe(true);
  });

  it('passes when no cache present', async () => {
    const ctx = mkCtx({events: [], users: {userA: {page: mkPage()}, userB: {page: mkPage()}}});
    const r = await invProfileCacheCoherent.check(ctx as any);
    expect(r.ok).toBe(true);
  });
});

describe('INV-profile-propagates', () => {
  it('is a no-op without an action', async () => {
    const ctx = mkCtx();
    const r = await invProfilePropagates.check(ctx as any);
    expect(r.ok).toBe(true);
  });

  it('is a no-op for non-editName actions', async () => {
    const ctx = mkCtx();
    const r = await invProfilePropagates.check(ctx as any, {name: 'sendText', args: {}} as any);
    expect(r.ok).toBe(true);
  });

  it('passes when peer mirror has the new name', async () => {
    const userA = {page: mkPage()};
    const userB = {page: mkPage({peers: {p1: {first_name: 'Carol-xyz'}}})};
    const ctx = mkCtx({users: {userA, userB}});
    const r = await invProfilePropagates.check(ctx as any, {
      name: 'editName',
      args: {user: 'userA'},
      meta: {user: 'userA', newName: 'Carol-xyz'}
    } as any);
    expect(r.ok).toBe(true);
  });

  it('fails when peer never sees the new name', async () => {
    const userA = {page: mkPage()};
    const userB = {page: mkPage({peers: {p1: {first_name: 'NotThat'}}})};
    const ctx = mkCtx({users: {userA, userB}});
    const r = await invProfilePropagates.check(ctx as any, {
      name: 'editName',
      args: {user: 'userA'},
      meta: {user: 'userA', newName: 'Carol-xyz'}
    } as any);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/peer never saw/);
  }, 10000);
});
