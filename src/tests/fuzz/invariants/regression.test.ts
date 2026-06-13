import {describe, it, expect, vi} from 'vitest';
import {noNip04, idbSeedEncrypted} from './regression';
import type {FuzzContext} from '../types';

function ctx(opts: {relayEvents?: any[]; idbDump?: string} = {}): FuzzContext {
  return {
    users: {
      userA: {id: 'userA', context: null as any, page: {evaluate: vi.fn(async() => opts.idbDump || '')} as any, displayName: 'A', npub: '', remotePeerId: 0, consoleLog: [], reloadTimes: []},
      userB: {id: 'userB', context: null as any, page: {evaluate: vi.fn(async() => opts.idbDump || '')} as any, displayName: 'B', npub: '', remotePeerId: 0, consoleLog: [], reloadTimes: []}
    } as any,
    relay: {getAllEvents: vi.fn(async() => opts.relayEvents || [])} as any,
    snapshots: new Map(),
    actionIndex: 0
  };
}

describe('INV-no-nip04', () => {
  it('passes when relay has no kind 4 events', async() => {
    const r = await noNip04.check(ctx({relayEvents: [{kind: 1059, id: 'x'}, {kind: 0, id: 'y'}]}));
    expect(r.ok).toBe(true);
  });

  it('fails when relay has a kind 4 event', async() => {
    const r = await noNip04.check(ctx({relayEvents: [{kind: 1059, id: 'x'}, {kind: 4, id: 'bad'}]}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/kind 4/i);
  });
});

describe('INV-idb-seed-encrypted', () => {
  it('passes when idb dump contains no plaintext seed/nsec', async() => {
    const r = await idbSeedEncrypted.check(ctx({idbDump: '{"pubkey":"abc","ciphertext":"ENCRYPTED"}'}));
    expect(r.ok).toBe(true);
  });

  it('fails when idb dump contains nsec1 plaintext', async() => {
    const r = await idbSeedEncrypted.check(ctx({idbDump: '{"nsec":"nsec1abcdefghijklmnopqrstuvwxyz"}'}));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/plaintext/i);
  });
});

import {editPreservesMidTimestamp, editAuthorCheck} from './regression';

describe('INV-edit-preserves-mid-timestamp', () => {
  it('passes when mid + timestamp identical post-edit', async() => {
    const action: any = {name: 'editRandomOwnBubble', args: {user: 'userA'}, meta: {editedMid: '100', beforeSnapshot: {mid: '100', timestamp: '5000', content: 'old'}}};
    const c: any = {
      users: {userA: {id: 'userA', page: {evaluate: vi.fn(async() => ({mid: '100', timestamp: '5000', content: 'new'}))}} as any, userB: {} as any},
      snapshots: new Map(), actionIndex: 0, relay: null
    };
    const r = await editPreservesMidTimestamp.check(c, action);
    expect(r.ok).toBe(true);
  });

  it('fails when mid changes post-edit', async() => {
    const action: any = {name: 'editRandomOwnBubble', args: {user: 'userA'}, meta: {editedMid: '100', beforeSnapshot: {mid: '100', timestamp: '5000', content: 'old'}}};
    const c: any = {
      users: {userA: {id: 'userA', page: {evaluate: vi.fn(async() => ({mid: '999', timestamp: '5000', content: 'new'}))}} as any, userB: {} as any},
      snapshots: new Map(), actionIndex: 0, relay: null
    };
    const r = await editPreservesMidTimestamp.check(c, action);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/mid/i);
  });
});

describe('INV-edit-author-check', () => {
  it('passes when every edit row has author match', async() => {
    const rows = [{mid: 1, senderPubkey: 'ABC', editAuthorPubkey: 'ABC', editedAt: 100}];
    const c: any = {
      users: {userA: {id: 'userA', page: {evaluate: vi.fn(async() => rows)}} as any, userB: {id: 'userB', page: {evaluate: vi.fn(async(): Promise<any[]> => [])}} as any},
      snapshots: new Map(), actionIndex: 0, relay: null
    };
    const r = await editAuthorCheck.check(c);
    expect(r.ok).toBe(true);
  });

  it('fails when an edit row has mismatched author', async() => {
    const rows = [{mid: 1, senderPubkey: 'ABC', editAuthorPubkey: 'XYZ', editedAt: 100}];
    const c: any = {
      users: {userA: {id: 'userA', page: {evaluate: vi.fn(async() => rows)}} as any, userB: {id: 'userB', page: {evaluate: vi.fn(async(): Promise<any[]> => [])}} as any},
      snapshots: new Map(), actionIndex: 0, relay: null
    };
    const r = await editAuthorCheck.check(c);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/author/i);
  });
});

import {virtualPeerIdStable} from './regression';

describe('INV-virtual-peer-id-stable', () => {
  it('is a no-op when action is not reloadPage', async() => {
    const action: any = {name: 'sendText'};
    const c: any = {users: {userA: {}, userB: {}}, snapshots: new Map(), actionIndex: 0, relay: null};
    const r = await virtualPeerIdStable.check(c, action);
    expect(r.ok).toBe(true);
  });

  it('fails when npub→peerId map changes across reload', async() => {
    const action: any = {name: 'reloadPage', args: {user: 'userA'}};
    const snapshots = new Map([['preReloadPeerMap-userA', {'npub1abc': 42}]]);
    const c: any = {
      users: {
        userA: {id: 'userA', page: {evaluate: vi.fn(async() => ({'npub1abc': 99}))}} as any,
        userB: {id: 'userB'}
      },
      snapshots, actionIndex: 0, relay: null
    };
    const r = await virtualPeerIdStable.check(c, action);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/peer.*changed/i);
  });
});
