/**
 * #189 — BEHAVIOURAL re-add tests for addP2PContact (Robert's review blocker).
 *
 * The contacts-sync caller passes NO deliberate stamp, so the non-deliberate
 * path must keep its historical clear-then-store order: storing before the
 * guards are cleared runs into the tombstone guard with the tombstone still
 * in place — the sync re-add is suppressed and a deliberate re-add on
 * another device does not materialise here in one pass (at best it lands one
 * reconcile later, with UI state and IndexedDB disagreeing in between).
 *
 * The deliberate path keeps the #186 order: stamped store FIRST (atomic
 * proof), guards cleared only after the stamped mapping is committed.
 *
 * Unlike add-p2p-contact.test.ts (source-regex assertions), this file runs
 * the REAL addP2PContact against the REAL virtual-peers-db and message-store
 * under fake-indexeddb. Only the tweb/bridge surroundings are mocked; the
 * bridge's storePeerMapping delegates to the real storeMapping.
 */
import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll, beforeEach, vi} from 'vitest';

const OWN_PUBKEY = 'd'.repeat(64);
const PEER_SYNC = 'e'.repeat(64);       // contacts-sync re-add target
const PEER_DELIB = 'f'.repeat(64);     // deliberate re-add target
const PEER_FAIL = '9'.repeat(64);      // store-failure abort target
const PEER_ID = 1000000000000001;

// ─── Mock bridge + tweb surroundings (hoisted) ───────────────────

const state = vi.hoisted(() => ({
  instance: null as any,
  injectP2PUser: vi.fn(),
  schedulePublish: vi.fn(),
  dispatchDialogUpdate: vi.fn(),
  // Test hook: force the bridge's storePeerMapping result to a fixed value
  // (null = delegate to the real storeMapping).
  forceStoreResult: null as boolean | null
}));

vi.mock('@lib/phantomchat/phantomchat-bridge', () => ({
  PhantomChatBridge: class {
    static getInstance() { return state.instance; }
  }
}));

vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn(),
    addEventListener: vi.fn(),
    managers: {appUsersManager: {injectP2PUser: (...a: any[]) => state.injectP2PUser(...a)}}
  }
}));

vi.mock('@config/debug', async() => {
  const actual = await vi.importActual<typeof import('@config/debug')>('@config/debug');
  return {...actual, MOUNT_CLASS_TO: {}};
});

vi.mock('@lib/phantomchat/phantomchat-message-handler', () => ({
  dispatchDialogUpdate: (...a: any[]) => state.dispatchDialogUpdate(...a)
}));

vi.mock('@lib/phantomchat/phantomchat-sync-triggers', () => ({
  schedulePublish: (...a: any[]) => state.schedulePublish(...a)
}));

vi.mock('@lib/phantomchat/phantomchat-peer-mapper', () => ({
  PhantomChatPeerMapper: class {
    createTwebUser() { return {}; }
    mapEventId = async(): Promise<number> => 111;
    createTwebMessage() { return {}; }
    createTwebDialog() { return {}; }
  }
}));

// kind-0 background fetch is fire-and-forget; stub the relay round-trip.
vi.mock('@lib/phantomchat/peer-profile-cache', () => ({
  refreshPeerProfileFromRelays: vi.fn(async(): Promise<void> => {}),
  loadCachedPeerProfile: vi.fn((): null => null)
}));

// ─── Real modules under test ─────────────────────────────────────

let addP2PContact: any;
let db: any;
let getMessageStore: any;

beforeAll(async() => {
  // tweb augments Number.prototype.toPeerId in the app; the mocked mapper
  // never needs a real conversion — identity is enough.
  (Number.prototype as any).toPeerId = function(this: number) { return this.valueOf(); };

  db = await import('@lib/phantomchat/virtual-peers-db');
  const ms = await import('@lib/phantomchat/message-store');
  getMessageStore = ms.getMessageStore;
  ({addP2PContact} = await import('@lib/phantomchat/add-p2p-contact'));

  state.instance = {
    mapPubkeyToPeerId: async() => PEER_ID,
    storePeerMapping: (pk: string, pid: number, name?: string, opts?: any) => {
      if(state.forceStoreResult !== null) return state.forceStoreResult;
      return db.storeMapping(pk, pid, name, undefined, opts);
    },
    deriveAvatarFromPubkeySync: () => 'avatar'
  };

  (globalThis as any).window.__phantomchatOwnPubkey = OWN_PUBKEY;
});

beforeEach(() => {
  state.injectP2PUser.mockClear();
  state.schedulePublish.mockClear();
  state.dispatchDialogUpdate.mockClear();
  state.forceStoreResult = null;
});

/** Install BOTH deletion guards: durable row + conversation tombstone. */
async function installGuards(peerPubkey: string) {
  const now = Date.now();
  await db.recordDeletedPeer(peerPubkey, now);
  const mstore = getMessageStore();
  const convId = mstore.getConversationId(OWN_PUBKEY, peerPubkey);
  await mstore.setTombstone(convId, Math.floor(now / 1000));
  // Sanity: with both guards in place an automatic store is suppressed.
  expect(await db.storeMapping(peerPubkey, PEER_ID)).toBe(false);
}

describe('addP2PContact re-add paths (#186/#189) — behavioural', () => {
  it('contacts-sync re-add (no stamp): tombstone + durable row present → mapping exists after ONE pass', async() => {
    await installGuards(PEER_SYNC);

    const result = await addP2PContact({
      pubkey: PEER_SYNC,
      source: 'contacts-sync' // deliberately NOT a user gesture — no stamp
    });

    expect(result.hexPubkey).toBe(PEER_SYNC);
    expect(result.isNew).toBe(true);
    const mapping = await db.getMapping(PEER_SYNC);
    expect(mapping).toBeTruthy();
    expect(mapping.peerId).toBe(PEER_ID);
    // A sync restore must NOT mint a deliberate stamp (the remote's own
    // stamp rides the merged entry, not this call)…
    expect(mapping.deliberateAddAt).toBeUndefined();
    // …and must not republish (reconcile already owns that).
    expect(state.schedulePublish).not.toHaveBeenCalled();
  });

  it('deliberate re-add (UI gesture): stamped mapping lands atomically and clears the durable row', async() => {
    await installGuards(PEER_DELIB);

    const result = await addP2PContact({
      pubkey: PEER_DELIB,
      deliberate: true,
      source: 'contacts-tab'
    });

    const mapping = await db.getMapping(PEER_DELIB);
    expect(mapping).toBeTruthy();
    expect(mapping.deliberateAddAt).toBeGreaterThan(0);
    expect(await db.getDeletedPeer(PEER_DELIB)).toBe(0);
    // The stamp is sync content now — a deliberate gesture always republishes.
    expect(state.schedulePublish).toHaveBeenCalledWith('contacts');
    expect(result.isNew).toBe(true);
  });

  it('a suppressed storeMapping ABORTS the deliberate re-add with the durable delete fact intact', async() => {
    await installGuards(PEER_FAIL);
    state.forceStoreResult = false; // simulate a guard/DB refusal

    await expect(addP2PContact({
      pubkey: PEER_FAIL,
      deliberate: true,
      source: 'contacts-tab'
    })).rejects.toThrow();

    // Nothing was cleared and nothing was built over the missing mapping.
    expect(await db.getMapping(PEER_FAIL)).toBeUndefined();
    expect(await db.getDeletedPeer(PEER_FAIL)).toBeGreaterThan(0);
    expect(state.injectP2PUser).not.toHaveBeenCalled();
    expect(state.dispatchDialogUpdate).not.toHaveBeenCalled();
  });
});
