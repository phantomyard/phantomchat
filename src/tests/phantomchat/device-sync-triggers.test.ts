// @vitest-environment jsdom
/**
 * Trigger wiring for the BACKGROUND reconciler (phantomchat-device-sync.ts).
 *
 * Sync is never a render gate. It's a background reconciler kicked by four proactive
 * triggers, and these assert each one is wired, scoped, and coalesced:
 *
 *   1. ALL RELAYS GREEN → FULL sync of the selected chat (Andrew's hard rule), on the
 *      RISING EDGE only — the pool fans out a state change on every socket
 *      transition, and re-syncing the world on each of them would be a storm.
 *   2. CHAT SELECTED    → recent-only sync (last 25).
 *   3. TYPING INDICATOR → recent-only sync (last 25), collapsed across a burst.
 *
 * (Trigger 4, message-received, is driven from the phantomchat-sync receive path and
 * is covered in device-sync-pull.test.ts, which exercises scheduleSync directly.)
 *
 * Two deliberate choices, both learned the hard way:
 *   - REAL timers: device-sync reaches its collaborators through dynamic `import()`,
 *     and module resolution does not advance under vi.useFakeTimers() — a faked clock
 *     never arms the debounce at all, so the suite would pass vacuously.
 *   - REAL message store over fake-indexeddb: device-sync imports it lazily from
 *     inside timer callbacks, where a doMock of the store is not reliably applied and
 *     the REAL (IndexedDB-backed) store silently leaks in. Using the real store makes
 *     that a non-question — and tests the actual have-set the sibling will receive.
 */

import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest';

const OWN = 'a'.repeat(64);

/**
 * A FRESH peer (and therefore a fresh conversationId) per test. The store is the real
 * IndexedDB-backed one, and deleting the DB between tests blocks on device-sync's own
 * open connection — so instead of wiping state, each test simply works in a
 * conversation no other test has touched.
 */
let peerN = 0;
let PEER = '';
let CONV = '';
let PEER_ID = 0;

/** > RECENT_SYNC_FLOOR_MS — how long a conversation rests between recent syncs. */
const PAST_FLOOR_MS = 2_300;

/** Seed the REAL store (over fake-indexeddb) with the conversation's history. */
async function seedStore(eventIds: string[]) {
  const {getMessageStore} = await import('@lib/phantomchat/message-store');
  const store = getMessageStore();
  let ts = 100;
  for(const eventId of eventIds) {
    await store.saveMessage({
      eventId,
      conversationId: CONV,
      senderPubkey: PEER,
      content: `msg-${eventId}`,
      type: 'text',
      timestamp: ts++,
      deliveryState: 'delivered',
      mid: ts * 1_000_000,
      twebPeerId: PEER_ID,
      isOutgoing: false
    });
  }
  return store;
}


const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn` holds (a scheduled sync is debounced, so it lands a beat later). */
async function waitFor(fn: () => boolean, ms = 4_000): Promise<boolean> {
  const t0 = Date.now();
  while(Date.now() - t0 < ms) {
    if(fn()) return true;
    await wait(25);
  }
  return fn();
}

/** Boot device-sync with every trigger source captured so we can fire them by hand. */
async function boot(eventIds: string[]) {
  vi.resetModules();
  const store = await seedStore(eventIds);
  const captured: any = {};

  // The mocked buses are REGISTRIES, not last-one-wins slots. A bus that only kept the
  // most recent callback made a listener leak invisible — a second registration simply
  // overwrote the first and the tests stayed green. Here every listener is retained, and
  // `captured[ev]` fans a dispatch out to ALL of them, so a duplicate registration shows
  // up as duplicate work and `counts()` can assert teardown actually removed them.
  const listeners: Record<string, any[]> = {};
  const addListener = (ev: string, cb: any) => {
    (listeners[ev] ||= []).push(cb);
    captured[ev] = (payload: any) => (listeners[ev] || []).map((f) => f(payload));
  };
  const removeListener = (ev: string, cb: any) => {
    const arr = listeners[ev] || [];
    const i = arr.indexOf(cb);
    if(i !== -1) arr.splice(i, 1);
  };
  const relayListeners: any[] = [];

  const pool = {
    isConnected: () => true,
    setOnDigest: (cb: any) => { captured.digest = cb; },
    setOnSyncRequest: (cb: any) => { captured.req = cb; },
    setOnSyncResponse: (cb: any) => { captured.res = cb; },
    addStateChangeListener: (cb: any) => {
      relayListeners.push(cb);
      captured.relayState = (c: number, t: number) => relayListeners.map((f) => f(c, t));
    },
    removeStateChangeListener: (cb: any) => {
      const i = relayListeners.indexOf(cb);
      if(i !== -1) relayListeners.splice(i, 1);
    },
    publishSyncRequest: vi.fn(async(_p: any) => {}),
    publishSyncResponse: vi.fn(async(_p: any) => {}),
    publishSelfDigest: vi.fn(async(_p: any) => {})
  };
  (window as any).__phantomchatChatAPI = {relayPool: pool};

  vi.doMock('@lib/appImManager', () => ({
    default: {addEventListener: addListener, removeEventListener: removeListener}
  }));
  vi.doMock('@lib/phantomchat/virtual-peers-db', () => ({
    getAllMappings: async() => [{peerId: PEER_ID, pubkey: PEER}]
  }));
  vi.doMock('@lib/rootScope', () => ({
    default: {
      addEventListener: addListener,
      removeEventListener: removeListener,
      dispatchEvent: () => {},
      managers: {}
    }
  }));

  /** How many live callbacks each bus is holding right now. */
  const counts = () => ({
    peer_changed: (listeners['peer_changed'] || []).length,
    peer_typings: (listeners['peer_typings'] || []).length,
    relayState: relayListeners.length
  });
  vi.doMock('@lib/phantomchat/phantomchat-bridge', () => ({
    PhantomChatBridge: {getInstance: () => ({
      mapPubkeyToPeerId: async() => PEER_ID,
      mapEventIdToMid: async(_id: string, ts: number) => ts * 1_000_000
    })}
  }));

  const mod = await import('@lib/phantomchat/phantomchat-device-sync');
  // Reset first: vi.resetModules() does not reliably hand back a FRESH instance of a
  // module reached through dynamic import, so module-level state (all-relays-green,
  // the full-synced set, timers) can survive into the next test and make a chat-open
  // look like a full sync. Destroy makes the starting state explicit either way.
  mod.destroyDeviceSync();
  await mod.initDeviceSync(OWN);
  teardown = () => mod.destroyDeviceSync();
  const deviceId = (window as any).__phantomchatDeviceSync.deviceId as string;

  /** The user selects the P2P chat (appImManager `peer_changed`). */
  const selectChat = async() => { await captured['peer_changed'](PEER_ID); };

  /**
   * A FRESH digest from another of our devices — the proof of life every scheduled
   * sync waits for. It advertises EXACTLY what we hold, so it grants liveness without
   * also tripping the digest-driven "I'm behind" pull (a separate path, covered in
   * device-sync-pull.test.ts). Any request we then see is the TRIGGER's doing.
   */
  const siblingPulses = async() => {
    const digest = await store.getConversationDigest(CONV);
    await captured.digest({
      deviceId: 'sibling',
      conv: CONV,
      count: digest.count,
      latestId: digest.latestId,
      sentAt: Date.now()
    });
  };

  /** The sibling answers our request, which ends the run's retry backoff. */
  const siblingAnswers = async() => {
    await captured.res({deviceId: 'sibling', targetId: deviceId, conv: CONV, rows: [], seq: 0, last: true});
  };

  const requests = () => pool.publishSyncRequest.mock.calls.map((c: any[]) => c[0]);

  return {mod, pool, captured, deviceId, store, selectChat, siblingPulses, siblingAnswers, requests, counts};
}

let teardown: (() => void) | null = null;

describe('device-sync proactive triggers', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    peerN++;
    PEER = peerN.toString(16).padStart(2, '0').repeat(32); // fresh 64-hex peer
    CONV = [OWN, PEER].sort().join(':');
    PEER_ID = 1_000 + peerN;
  });
  afterEach(() => {
    teardown?.();   // kill in-flight debounces/backoffs — they must not leak forward
    teardown = null;
    delete (window as any).__phantomchatChatAPI;
    delete (window as any).__phantomchatDeviceSync;
    vi.resetModules();
  });

  it('TRIGGER 1 — all relays green FULL-syncs the selected chat', async() => {
    const {pool, captured, selectChat, siblingPulses, requests} = await boot(['m1', 'm2']);

    await selectChat();
    captured.relayState(3, 3);   // every socket connected — the hard rule fires
    await siblingPulses();       // …and a sibling is live to answer it

    expect(await waitFor(() => requests().length > 0)).toBe(true);

    // The full scope supersedes the chat-open recent sync — one request, whole conv.
    expect(pool.publishSyncRequest).toHaveBeenCalledTimes(1);
    const req = requests()[0];
    expect(req.recentOnly).toBeUndefined();     // FULL scope, not just the tail
    expect(req.conv).toBe(CONV);                // scoped to the SELECTED chat
    expect(req.haveIds).toEqual(['m1', 'm2']);  // whole-conversation have-set
  }, 15_000);

  it('TRIGGER 1 — partial connectivity does NOT full-sync', async() => {
    const {captured, selectChat, siblingPulses, requests} = await boot(['m1']);

    await selectChat();
    captured.relayState(2, 3);   // two of three — not green
    await siblingPulses();

    expect(await waitFor(() => requests().length > 0)).toBe(true);
    // Only the chat-open (recent) sync ran. No full sync without every relay up.
    expect(requests().every((r: any) => r.recentOnly === true)).toBe(true);
  }, 15_000);

  it('TRIGGER 1 — fires on the rising edge only, not on every green notification', async() => {
    const {pool, captured, selectChat, siblingPulses, siblingAnswers, requests} = await boot(['m1']);

    await selectChat();
    captured.relayState(3, 3);
    await siblingPulses();
    expect(await waitFor(() => requests().length > 0)).toBe(true);
    await siblingAnswers();      // end the retry backoff so any re-ask is OUR bug
    const after = pool.publishSyncRequest.mock.calls.length;

    // The pool keeps fanning out state changes while green — none may re-sync.
    captured.relayState(3, 3);
    captured.relayState(3, 3);
    await wait(1_200);

    expect(pool.publishSyncRequest.mock.calls.length).toBe(after);
  }, 15_000);

  it('TRIGGER 2 — selecting a chat syncs its recent tail', async() => {
    const {pool, siblingPulses, selectChat, requests} = await boot(['m1']);

    await siblingPulses();
    await selectChat();

    expect(await waitFor(() => requests().length > 0)).toBe(true);
    expect(pool.publishSyncRequest).toHaveBeenCalledTimes(1);
    const req = requests()[0];
    expect(req.recentOnly).toBe(true);
    expect(req.limit).toBe(25);
    expect(req.targetId).toBe('');   // broadcast — any live sibling may answer
  }, 15_000);

  it('TRIGGER 3 — a typing indicator syncs the recent tail', async() => {
    const {pool, captured, selectChat, siblingPulses, siblingAnswers, requests} = await boot(['m1']);

    await siblingPulses();
    await selectChat();
    expect(await waitFor(() => requests().length > 0)).toBe(true);
    await siblingAnswers();
    pool.publishSyncRequest.mockClear();
    await wait(PAST_FLOOR_MS);       // the chat-open sync's floor has expired

    captured['peer_typings']({peerId: PEER_ID});    // the OPEN chat's peer types at us

    expect(await waitFor(() => requests().length > 0)).toBe(true);
    expect(requests()[0].recentOnly).toBe(true);
  }, 20_000);

  it('TRIGGER 3 — typing in an UNRELATED chat buys the open chat nothing', async() => {
    const {pool, captured, selectChat, siblingPulses, siblingAnswers, requests} = await boot(['m1']);

    await siblingPulses();
    await selectChat();
    expect(await waitFor(() => requests().length > 0)).toBe(true);
    await siblingAnswers();
    pool.publishSyncRequest.mockClear();
    pool.publishSelfDigest.mockClear();
    await wait(PAST_FLOOR_MS);

    // `peer_typings` is a GLOBAL bus event — it fires for every peer the client
    // tracks. A stranger typing in some other conversation is not evidence about
    // the open one, and must not buy it a sync (nor a digest advertising it).
    for(let i = 0; i < 8; i++) captured['peer_typings']({peerId: PEER_ID + 777});
    await wait(1_200);   // well past the trailing debounce

    expect(pool.publishSyncRequest).not.toHaveBeenCalled();
    expect(pool.publishSelfDigest).not.toHaveBeenCalled();

    // ...and the filter is a filter, not a mute: the open chat's own peer still works.
    captured['peer_typings']({peerId: PEER_ID});
    expect(await waitFor(() => requests().length > 0)).toBe(true);
    expect(requests()[0].recentOnly).toBe(true);
  }, 20_000);

  it('TRIGGER 3 — a typing STORM still costs exactly one sync', async() => {
    const {pool, captured, selectChat, siblingPulses, siblingAnswers, requests} = await boot(['m1']);

    await siblingPulses();
    await selectChat();
    expect(await waitFor(() => requests().length > 0)).toBe(true);
    await siblingAnswers();
    pool.publishSyncRequest.mockClear();
    await wait(PAST_FLOOR_MS);

    // The shape of the real log: a burst of typing edges inside one second. Each one
    // is a trigger; the debounce must fold them into a single sync.
    for(let i = 0; i < 8; i++) captured['peer_typings']({peerId: PEER_ID});
    expect(await waitFor(() => requests().length > 0)).toBe(true);
    await siblingAnswers();
    await wait(800);

    expect(pool.publishSyncRequest).toHaveBeenCalledTimes(1);
  }, 20_000);

  it('LIFECYCLE — destroy unregisters every listener it installed', async() => {
    const {mod, counts} = await boot(['m1']);

    // The typing trigger registers behind a dynamic import, so it lands a tick after
    // init resolves — wait for it rather than racing it.
    expect(await waitFor(() => counts().peer_typings === 1)).toBe(true);

    // init wired all three buses...
    expect(counts()).toEqual({peer_changed: 1, peer_typings: 1, relayState: 1});

    mod.destroyDeviceSync();

    // ...and destroy must hand every one of them back. The buses (rootScope,
    // appImManager, the relay pool) are long-lived singletons that outlive us.
    expect(counts()).toEqual({peer_changed: 0, peer_typings: 0, relayState: 0});
  }, 15_000);

  it('LIFECYCLE — destroy unwires the pool control callbacks', async() => {
    const {mod, pool, captured} = await boot(['m1']);

    // init routes all three control envelope types...
    expect(typeof captured.digest).toBe('function');
    expect(typeof captured.req).toBe('function');
    expect(typeof captured.res).toBe('function');

    mod.destroyDeviceSync();

    // ...and destroy must hand them back. These are SINGLE-SLOT on the pool, so they
    // never stacked — they just stayed wired, holding the dead session's closure.
    expect(captured.digest).toBeNull();
    expect(captured.req).toBeNull();
    expect(captured.res).toBeNull();
    expect(pool.publishSyncRequest).not.toHaveBeenCalled();
  }, 15_000);

  it('LIFECYCLE — a control envelope in flight across destroy is dropped', async() => {
    const {mod, pool, captured} = await boot(['m1']);

    // Grab the handler the pool is holding BEFORE teardown — this is the envelope that
    // was already in the pool's hands when the user logged out. Unwiring can't reach it;
    // only the epoch pin can. Control envelopes are stored gift-wraps, so a reconnect
    // replays the backlog and this is a live path, not a theoretical one.
    const inFlightDigest = captured.digest;
    const inFlightReq = captured.req;

    mod.destroyDeviceSync();
    pool.publishSyncRequest.mockClear();
    pool.publishSelfDigest.mockClear();
    pool.publishSyncResponse.mockClear();

    await inFlightDigest({deviceId: 'sibling', conv: PEER, count: 99, latestId: 'm99', sentAt: Date.now()});
    await inFlightReq({deviceId: 'sibling', targetId: 'whoever', conv: PEER, haveIds: [], sentAt: Date.now()});
    await wait(1_200);

    // Nothing reaches the relays for the session we just tore down.
    expect(pool.publishSyncRequest).not.toHaveBeenCalled();
    expect(pool.publishSyncResponse).not.toHaveBeenCalled();
    expect(pool.publishSelfDigest).not.toHaveBeenCalled();
  }, 15_000);

  it('LIFECYCLE — re-init does not accumulate listeners across account switches', async() => {
    const {mod, counts} = await boot(['m1']);

    // Logout → login, twice. This is the real path: destroy then init, repeatedly.
    for(let i = 0; i < 2; i++) {
      mod.destroyDeviceSync();
      await mod.initDeviceSync(OWN);
    }
    expect(await waitFor(() => counts().peer_typings === 1)).toBe(true);
    expect(counts()).toEqual({peer_changed: 1, peer_typings: 1, relayState: 1});

    // And the path that skips destroy entirely — a bare re-init must be self-cleaning
    // too, or it stacks a second full set of callbacks on the buses.
    await mod.initDeviceSync(OWN);
    expect(await waitFor(() => counts().peer_typings === 1)).toBe(true);
    expect(counts()).toEqual({peer_changed: 1, peer_typings: 1, relayState: 1});
  }, 15_000);

  it('LIFECYCLE — a stale generation does no work after teardown', async() => {
    const {mod, pool, captured, selectChat, siblingPulses, requests} = await boot(['m1']);

    await siblingPulses();
    await selectChat();
    expect(await waitFor(() => requests().length > 0)).toBe(true);

    mod.destroyDeviceSync();
    pool.publishSyncRequest.mockClear();
    pool.publishSelfDigest.mockClear();

    // Every trigger source, fired at a torn-down module. The leak's real cost was here:
    // a surviving callback keeps publishing to the relays for an account we logged out of.
    captured['peer_typings']?.({peerId: PEER_ID});
    captured.relayState?.(3, 3);
    document.dispatchEvent(new Event('visibilitychange'));
    await wait(1_200);

    expect(pool.publishSyncRequest).not.toHaveBeenCalled();
    expect(pool.publishSelfDigest).not.toHaveBeenCalled();
  }, 20_000);
});
