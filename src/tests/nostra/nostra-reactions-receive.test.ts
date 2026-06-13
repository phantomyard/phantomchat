// @vitest-environment jsdom
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';
import 'fake-indexeddb/auto';

describe('nostra-reactions-receive', () => {
  let recv: any;
  let store: any;
  let messageStoreMock: Map<string, {mid: number; peerId: number}>;

  beforeEach(async() => {
    vi.resetModules();
    (globalThis as any).indexedDB.deleteDatabase('nostra-reactions');
    messageStoreMock = new Map();
    const recvMod = await import('@lib/nostra/nostra-reactions-receive');
    recv = recvMod.nostraReactionsReceive;
    recv.setOwnPubkey('ownpk');
    recv.setMessageResolver(async(eventId: string) => messageStoreMock.get(eventId));
    const storeMod = await import('@lib/nostra/nostra-reactions-store');
    store = storeMod.nostraReactionsStore;
    await store.init();
  });

  afterEach(async() => {
    recv.clearBuffer();
    await store.destroy?.();
  });

  it('onKind7 persists row when target resolves immediately', async() => {
    messageStoreMock.set('evtA', {mid: 10, peerId: 1e16});
    await recv.onKind7({
      id: 'r1', kind: 7, pubkey: 'peerpk', created_at: 100,
      tags: [['e', 'evtA'], ['p', 'ownpk']],
      content: '👍'
    });
    const rows = await store.getByTarget('evtA');
    expect(rows).toHaveLength(1);
    expect(rows[0].emoji).toBe('👍');
    expect(rows[0].fromPubkey).toBe('peerpk');
  });

  it('onKind7 drops event where p tag is not me', async() => {
    messageStoreMock.set('evtA', {mid: 10, peerId: 1e16});
    await recv.onKind7({
      id: 'r1', kind: 7, pubkey: 'peerpk', created_at: 100,
      tags: [['e', 'evtA'], ['p', 'someonelse']],
      content: '👍'
    });
    const rows = await store.getByTarget('evtA');
    expect(rows).toHaveLength(0);
  });

  it('onKind7 buffers unresolved target, flushes once target arrives', async() => {
    // Target not resolvable yet.
    await recv.onKind7({
      id: 'r1', kind: 7, pubkey: 'peerpk', created_at: 100,
      tags: [['e', 'evtB'], ['p', 'ownpk']],
      content: '❤️'
    });
    expect((await store.getByTarget('evtB'))).toHaveLength(0);
    // Target arrives — simulate by calling the flush hook.
    messageStoreMock.set('evtB', {mid: 20, peerId: 1e16});
    await recv.flushPending('evtB');
    const rows = await store.getByTarget('evtB');
    expect(rows).toHaveLength(1);
    expect(rows[0].emoji).toBe('❤️');
  });

  it('onKind5 removes any reaction referenced by e tag', async() => {
    messageStoreMock.set('evtC', {mid: 30, peerId: 1e16});
    await recv.onKind7({
      id: 'r5', kind: 7, pubkey: 'peerpk', created_at: 200,
      tags: [['e', 'evtC'], ['p', 'ownpk']],
      content: '🔥'
    });
    expect((await store.getByTarget('evtC'))).toHaveLength(1);
    await recv.onKind5({
      id: 'd1', kind: 5, pubkey: 'peerpk', created_at: 201,
      tags: [['e', 'r5']],
      content: ''
    });
    expect((await store.getByTarget('evtC'))).toHaveLength(0);
  });

  it('onKind5 from non-author is ignored', async() => {
    messageStoreMock.set('evtC', {mid: 30, peerId: 1e16});
    await recv.onKind7({
      id: 'r5', kind: 7, pubkey: 'peerpk', created_at: 200,
      tags: [['e', 'evtC'], ['p', 'ownpk']],
      content: '🔥'
    });
    // attacker tries to delete peerpk's reaction
    await recv.onKind5({
      id: 'd1', kind: 5, pubkey: 'attackerpk', created_at: 201,
      tags: [['e', 'r5']],
      content: ''
    });
    expect((await store.getByTarget('evtC'))).toHaveLength(1);
  });

  // Regression for FIND-4e18d35d. When the reactor tags BOTH their own pubkey
  // (target author) AND the conversation peer, the peer's onKind7 must accept
  // the event because the peer's pubkey appears SOMEWHERE in the p-tag list —
  // it is not necessarily the first p-tag.
  it('onKind7 accepts event when ownPk matches a non-first p-tag', async() => {
    messageStoreMock.set('evtD', {mid: 40, peerId: 1e16});
    await recv.onKind7({
      id: 'r7', kind: 7, pubkey: 'peerpk', created_at: 300,
      // peerpk reacted to their OWN message — targetAuthor (first p) is peerpk;
      // ownpk appears as the SECOND p-tag for bilateral propagation.
      tags: [['e', 'evtD'], ['p', 'peerpk'], ['p', 'ownpk']],
      content: '😂'
    });
    const rows = await store.getByTarget('evtD');
    expect(rows).toHaveLength(1);
    expect(rows[0].emoji).toBe('😂');
  });
});
