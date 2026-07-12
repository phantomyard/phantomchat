// @vitest-environment jsdom
/**
 * Regression test for the device-sync CONTROL-ENVELOPE REPLAY STORM.
 *
 * Digest / sync-req / sync-res envelopes ride the gift-wrap path, so relays STORE
 * them. A reconnecting device replays the whole backlog — which used to be acted on
 * as if every replayed envelope were a live pulse. Two failures fell out of that:
 *
 *   1. STORM: every replayed digest ran a compare and could fire a sync request.
 *   2. PHANTOM SIBLING: a replayed digest advanced `lastSiblingActivityAt`, so the
 *      sync-before-render barrier armed and HARD-BLOCKED incoming messages for its
 *      full ceiling — waiting on a pull no live device would ever answer.
 *
 * These assert the freshness gate, the dedup window, the change-gated heartbeat,
 * and the reciprocal re-advertise that keeps catch-up alive despite that gate.
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

const OWN = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const CONV = [OWN, PEER].sort().join(':');
const PEER_ID = 123;

/** Older than CONTROL_FRESHNESS_MS (120s) — i.e. a replayed backlog envelope. */
const STALE = () => Date.now() - 10 * 60_000;
const FRESH = () => Date.now();

function row(eventId: string, timestamp: number) {
  return {
    eventId,
    conversationId: CONV,
    senderPubkey: PEER,
    content: `msg-${eventId}`,
    type: 'text',
    timestamp,
    deliveryState: 'delivered',
    isOutgoing: false
  };
}

function makeStore(rows: any[], latestId = '') {
  const byId = new Map(rows.map((r) => [r.eventId, r]));
  return {
    getConversationId: (a: string, b: string) => [a, b].sort().join(':'),
    getConversationDigest: vi.fn(async() => ({count: byId.size, latestId, latestTimestamp: 0})),
    getConversationEventIds: vi.fn(async() => Array.from(byId.keys())),
    getMessages: vi.fn(async() => Array.from(byId.values())),
    getByEventId: vi.fn(async(id: string) => byId.get(id) ?? null),
    saveMessage: vi.fn(async(m: any) => { byId.set(m.eventId, m); })
  };
}

/**
 * Boot device-sync against a mocked pool + store. `openChat` drives the real
 * `peer_changed` path so `activePeerPubkey` is set — the reciprocal re-advertise
 * only speaks for the OPEN chat, so it can't be tested without it.
 */
async function boot(store: any) {
  vi.resetModules();
  const captured: any = {};
  const pool = {
    isConnected: () => true,
    setOnDigest: (cb: any) => { captured.digest = cb; },
    setOnSyncRequest: (cb: any) => { captured.req = cb; },
    setOnSyncResponse: (cb: any) => { captured.res = cb; },
    addStateChangeListener: () => {},
    publishSyncRequest: vi.fn(async(_p: any) => {}),
    publishSyncResponse: vi.fn(async(_p: any) => {}),
    publishSelfDigest: vi.fn(async(_p: any) => {})
  };
  (window as any).__phantomchatChatAPI = {relayPool: pool};

  const listeners: any = {};
  vi.doMock('@lib/phantomchat/message-store', () => ({getMessageStore: () => store}));
  vi.doMock('@lib/appImManager', () => ({
    default: {addEventListener: (ev: string, cb: any) => { listeners[ev] = cb; }}
  }));
  vi.doMock('@lib/phantomchat/virtual-peers-db', () => ({
    getAllMappings: async() => [{peerId: PEER_ID, pubkey: PEER}]
  }));
  vi.doMock('@lib/rootScope', () => ({default: {addEventListener: () => {}, dispatchEvent: () => {}, managers: {}}}));
  vi.doMock('@lib/phantomchat/phantomchat-bridge', () => ({
    PhantomChatBridge: {getInstance: () => ({
      mapPubkeyToPeerId: async() => PEER_ID,
      mapEventIdToMid: async(_id: string, ts: number) => ts * 1_000_000
    })}
  }));

  const mod = await import('@lib/phantomchat/phantomchat-device-sync');
  await mod.initDeviceSync(OWN);
  const deviceId = (window as any).__phantomchatDeviceSync.deviceId as string;

  const openChat = async() => {
    await listeners['peer_changed']?.(PEER_ID);
    await new Promise((r) => setTimeout(r, 0));
    pool.publishSelfDigest.mockClear(); // ignore the chat-open advertisement
  };

  return {mod, pool, captured, deviceId, openChat};
}

describe('device-sync — stored-control-envelope replay storm', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => {
    delete (window as any).__phantomchatChatAPI;
    delete (window as any).__phantomchatDeviceSync;
    vi.resetModules();
  });

  it('ignores a REPLAYED digest — no compare, no sync request', async() => {
    const store = makeStore([row('m1', 10)]);
    const {captured, pool} = await boot(store);
    store.getConversationDigest.mockClear();

    // The backlog: the same digest, over and over, all long expired. This is the
    // ~50-line `← digest count=384` burst Andrew saw on every reload.
    for(let i = 0; i < 50; i++) {
      await captured.digest({deviceId: 'sibling', conv: CONV, count: 384, latestId: 'old', sentAt: STALE()});
    }

    expect(store.getConversationDigest).not.toHaveBeenCalled();
    expect(pool.publishSyncRequest).not.toHaveBeenCalled();
  });

  it('a REPLAYED digest does not fake a live sibling — the render barrier stays open', async() => {
    const store = makeStore([row('m1', 10)]);
    const {mod, captured, pool} = await boot(store);

    // Only stale digests heard: no device is actually online.
    await captured.digest({deviceId: 'sibling', conv: CONV, count: 384, latestId: 'old', sentAt: STALE()});

    // The barrier must NOT arm — an incoming message renders immediately rather
    // than hard-blocking for the full 5s ceiling on a pull nobody will answer.
    const t0 = Date.now();
    await mod.syncRecentBeforeRender(PEER);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(pool.publishSyncRequest).not.toHaveBeenCalled();
  });

  it('a FRESH digest still arms the barrier (the gate is freshness, not a mute)', async() => {
    const store = makeStore([row('m1', 10)]);
    const {mod, captured, pool, deviceId} = await boot(store);

    await captured.digest({deviceId: 'sibling', conv: CONV, count: 1, latestId: '', sentAt: FRESH()});

    let resolved = false;
    const barrier = mod.syncRecentBeforeRender(PEER).then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 0));

    expect(pool.publishSyncRequest).toHaveBeenCalledTimes(1);
    expect(resolved).toBe(false);

    await captured.res({deviceId: 'sibling', targetId: deviceId, conv: CONV, rows: [], seq: 0, last: true});
    await barrier;
    expect(resolved).toBe(true);
  });

  it('does not answer a REPLAYED sync request', async() => {
    const store = makeStore([row('m1', 10), row('m2', 20)]);
    const {captured, pool} = await boot(store);

    await captured.req({deviceId: 'requester', targetId: '', conv: CONV, haveIds: [], recentOnly: true, limit: 25, sentAt: STALE()});
    expect(pool.publishSyncResponse).not.toHaveBeenCalled();

    // ...but a live one is still answered.
    await captured.req({deviceId: 'requester', targetId: '', conv: CONV, haveIds: [], recentOnly: true, limit: 25, sentAt: FRESH()});
    expect(pool.publishSyncResponse).toHaveBeenCalledTimes(1);
  });

  it('collapses byte-identical digests arriving together (multi-relay fan-in)', async() => {
    const store = makeStore([row('m1', 10)]);
    const {captured} = await boot(store);
    store.getConversationDigest.mockClear();

    const d = {deviceId: 'sibling', conv: CONV, count: 1, latestId: 'x', sentAt: FRESH()};
    await captured.digest({...d});
    await captured.digest({...d});
    await captured.digest({...d});

    // Compared once, not three times.
    expect(store.getConversationDigest).toHaveBeenCalledTimes(1);
  });

  it('idle heartbeat does not re-publish an unchanged digest, but a forced trigger does', async() => {
    const store = makeStore([row('m1', 10)], 'm1');
    const {mod, pool, openChat} = await boot(store);
    await openChat();

    // chat-open has already advertised this digest (openChat clears the spy after).
    // Every heartbeat that follows on an idle, unchanged chat must write NOTHING —
    // this is what stopped the 45s stream of stored garbage to the relays.
    await mod.publishActiveDigest();
    await mod.publishActiveDigest();
    await mod.publishActiveDigest();
    expect(pool.publishSelfDigest).not.toHaveBeenCalled();

    // An explicit trigger (chat-open / reconnect / foreground / local send) must
    // still speak even when unchanged — a freshly-connected sibling is waiting on
    // exactly that advertisement.
    await mod.publishActiveDigest({force: true});
    expect(pool.publishSelfDigest).toHaveBeenCalledTimes(1);

    // And a CHANGED digest gets through the gate on a plain heartbeat.
    pool.publishSelfDigest.mockClear();
    store.getConversationDigest.mockResolvedValue({count: 9, latestId: 'm9', latestTimestamp: 0});
    await mod.publishActiveDigest();
    expect(pool.publishSelfDigest).toHaveBeenCalledTimes(1);
  });

  it('re-advertises when a live sibling reports FEWER messages than we hold', async() => {
    const store = makeStore([row('m1', 10), row('m2', 20), row('m3', 30)], 'm3');
    const {captured, pool, openChat} = await boot(store);
    await openChat();

    // Sibling is behind us. With the heartbeat change-gated, staying quiet would
    // strand it forever — it only pulls when it hears someone advertise MORE.
    await captured.digest({deviceId: 'sibling', conv: CONV, count: 1, latestId: 'm1', sentAt: FRESH()});
    await new Promise((r) => setTimeout(r, 0));

    expect(pool.publishSelfDigest).toHaveBeenCalledTimes(1);
    const sent = pool.publishSelfDigest.mock.calls[0][0] as any;
    expect(sent.conv).toBe(CONV);
    expect(sent.count).toBe(3);

    // We are ahead, so we must NOT have asked the sibling for anything.
    expect(pool.publishSyncRequest).not.toHaveBeenCalled();
  });
});
