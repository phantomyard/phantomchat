// @vitest-environment jsdom
/**
 * Behavioral test for device-sync PULL side (phantomchat-device-sync.ts),
 * Increment 2. Covers the request/response contract:
 *
 *  - a SYNC REQUEST aimed at THIS device is answered with exactly the rows we
 *    hold that the requester's have-set is missing (strict set difference);
 *  - a request NOT aimed at us is ignored;
 *  - a SYNC RESPONSE aimed at us ingests only rows we don't already hold
 *    (strict union — never clobbers an existing eventId);
 *  - a response NOT aimed at us is ignored.
 */

import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

const OWN = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const CONV = [OWN, PEER].sort().join(':');

function row(eventId: string, timestamp: number, outgoing = false) {
  return {
    eventId,
    conversationId: CONV,
    senderPubkey: outgoing ? OWN : PEER,
    content: `msg-${eventId}`,
    type: 'text',
    timestamp,
    deliveryState: outgoing ? 'sent' : 'delivered',
    isOutgoing: outgoing
  };
}

function makeStore(rows: any[]) {
  const byId = new Map(rows.map((r) => [r.eventId, r]));
  return {
    getConversationId: (a: string, b: string) => [a, b].sort().join(':'),
    getConversationDigest: vi.fn(async() => ({count: rows.length, latestId: '', latestTimestamp: 0})),
    getConversationEventIds: vi.fn(async() => rows.map((r) => r.eventId)),
    getMessages: vi.fn(async() => rows.slice()),
    getByEventId: vi.fn(async(id: string) => byId.get(id) ?? null),
    saveMessage: vi.fn(async(m: any) => { byId.set(m.eventId, m); })
  };
}

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

  vi.doMock('@lib/phantomchat/message-store', () => ({getMessageStore: () => store}));
  vi.doMock('@lib/appImManager', () => ({default: {addEventListener: () => {}}}));
  vi.doMock('@lib/rootScope', () => ({default: {addEventListener: () => {}, dispatchEvent: () => {}, managers: {}}}));
  vi.doMock('@lib/phantomchat/phantomchat-bridge', () => ({
    PhantomChatBridge: {getInstance: () => ({
      mapPubkeyToPeerId: async() => 123,
      mapEventIdToMid: async(id: string, ts: number) => ts * 1_000_000
    })}
  }));

  const mod = await import('@lib/phantomchat/phantomchat-device-sync');
  await mod.initDeviceSync(OWN);
  const deviceId = (window as any).__phantomchatDeviceSync.deviceId as string;
  return {mod, pool, captured, deviceId};
}

describe('device-sync pull (request/response, strict union)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });
  afterEach(() => {
    delete (window as any).__phantomchatChatAPI;
    delete (window as any).__phantomchatDeviceSync;
  });

  it('answers a request aimed at us with only the rows the requester is missing', async() => {
    const store = makeStore([row('m1', 10), row('m2', 20), row('m3', 30)]);
    const {captured, pool, deviceId} = await boot(store);

    // Requester already has m1; expects m2 + m3 back.
    await captured.req({deviceId: 'requester', targetId: deviceId, conv: CONV, haveIds: ['m1']});

    expect(pool.publishSyncResponse).toHaveBeenCalledTimes(1);
    const sent = pool.publishSyncResponse.mock.calls[0][0] as any;
    expect(sent.targetId).toBe('requester');
    expect(sent.last).toBe(true);
    expect(sent.rows.map((r: any) => r.eventId)).toEqual(['m2', 'm3']); // oldest-first
  });

  it('ignores a request NOT aimed at this device', async() => {
    const store = makeStore([row('m1', 10)]);
    const {captured, pool} = await boot(store);
    await captured.req({deviceId: 'requester', targetId: 'someone-else', conv: CONV, haveIds: []});
    expect(pool.publishSyncResponse).not.toHaveBeenCalled();
  });

  it('sends nothing when the requester already holds everything', async() => {
    const store = makeStore([row('m1', 10), row('m2', 20)]);
    const {captured, pool, deviceId} = await boot(store);
    await captured.req({deviceId: 'requester', targetId: deviceId, conv: CONV, haveIds: ['m1', 'm2']});
    expect(pool.publishSyncResponse).not.toHaveBeenCalled();
  });

  it('ingests only new rows from a response aimed at us (strict union)', async() => {
    const store = makeStore([row('m1', 10)]); // we already hold m1
    const {captured, deviceId} = await boot(store);

    await captured.res({
      deviceId: 'holder',
      targetId: deviceId,
      conv: CONV,
      rows: [row('m1', 10), row('m2', 20)], // m1 dup, m2 new
      seq: 0,
      last: true
    });

    // m1 already existed → not re-saved; m2 saved exactly once.
    const saved = store.saveMessage.mock.calls.map((c: any[]) => c[0].eventId);
    expect(saved).toEqual(['m2']);
  });

  it('ignores a response NOT aimed at this device', async() => {
    const store = makeStore([]);
    const {captured} = await boot(store);
    await captured.res({deviceId: 'holder', targetId: 'someone-else', conv: CONV, rows: [row('m2', 20)], seq: 0, last: true});
    expect(store.saveMessage).not.toHaveBeenCalled();
  });
});
