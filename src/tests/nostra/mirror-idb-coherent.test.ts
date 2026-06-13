/**
 * Regression test for FIND-e49755c1 (mirror/IDB coherence drift).
 *
 * The fuzz invariant `INV-mirrors-idb-coherent` enumerates every integer
 * `mid` in `apiManagerProxy.mirrors.messages` and requires the corresponding
 * IndexedDB row (`nostra-messages`) to carry the same `mid`. Before the fix,
 * the sender-side send pipeline wrote the `nostra-messages` row twice:
 *
 *   1. `ChatAPI.sendMessage()` — saved a PARTIAL row ({eventId, content, …},
 *      no mid, no twebPeerId, no isOutgoing).
 *   2. `NostraMTProtoServer.sendMessage()` — after sendText() returned, saved
 *      the FULL row ({…, mid, twebPeerId, isOutgoing:true}), relying on
 *      message-store's merge logic to stitch the fields together.
 *
 * Because step 1 is awaited inside ChatAPI but `updateMessageStatus` is
 * fire-and-forget and may re-save the partial row between the two writes, the
 * mirror could end up with `mid` set (from VMT's injectOutgoingBubble) before
 * the authoritative IDB row landed — tripping the invariant.
 *
 * Fix: VMT.sendMessage now passes `{twebPeerId}` via `sendText`'s new `opts`
 * parameter so the FIRST IDB write already carries `twebPeerId` and
 * `isOutgoing:true`. VMT's subsequent save adds `mid`. The receive-side
 * partial save in `chat-api-receive.ts` likewise computes mid/twebPeerId
 * eagerly so both saves on the receiver carry them.
 *
 * This test verifies:
 *   - Sender pipeline: the single IDB row after a VMT sendMessage roundtrip
 *     contains mid, twebPeerId, and isOutgoing:true.
 *   - Receiver pipeline: the single IDB row after a chat-api-receive run
 *     contains mid, twebPeerId, and isOutgoing:false.
 */

import '../setup';
import {describe, it, expect, vi, beforeAll, afterAll} from 'vitest';

// Polyfill Number.toPeerId used by NostraPeerMapper.createTwebMessage so the
// VMT's injectOutgoingBubble call path doesn't throw unrelated errors.
if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : Math.abs(this as number);
  };
}

const PEER_PUBKEY = 'aabbcc0011223344aabbcc0011223344aabbcc0011223344aabbcc0011223344';
const OWN_PUBKEY = '1122334455667788112233445566778811223344556677881122334455667788';
const PEER_ID = 1234567890123456;
const MID = 999000000001;

// In-memory store simulating IDB merge semantics (mirrors message-store.ts).
class InMemoryStore {
  rows = new Map<string, any>();
  saveMessage = vi.fn(async(msg: any) => {
    const existing = this.rows.get(msg.eventId);
    const merged = {...(existing || {}), ...msg};
    if(existing?.mid && !msg.mid) merged.mid = existing.mid;
    if(existing?.twebPeerId && !msg.twebPeerId) merged.twebPeerId = existing.twebPeerId;
    if(existing?.isOutgoing !== undefined && msg.isOutgoing === undefined) merged.isOutgoing = existing.isOutgoing;
    if(existing?.editedAt && !msg.editedAt) merged.editedAt = existing.editedAt;
    this.rows.set(msg.eventId, merged);
  });
  getConversationId = (a: string, b: string) => [a, b].sort().join(':');
  getByEventId = vi.fn(async(id: string) => this.rows.get(id) || null);
  getAllConversationIds = vi.fn().mockResolvedValue([]);
  getMessages = vi.fn().mockResolvedValue([]);
  deleteByMid = vi.fn();
  deleteMessages = vi.fn().mockResolvedValue(undefined);
  getByAppMessageId = vi.fn().mockResolvedValue(null);
}

const store = new InMemoryStore();

// Hoisted mock references. Using vi.mock without hoisted names makes test
// ordering fragile when a sibling test file mocks the same module first with
// a different shape (e.g. message-requests.test.ts mocks virtual-peers-db).
// Follow virtual-mtproto-server.test.ts's pattern: vi.resetModules() +
// vi.doMock inside beforeAll.
let NostraMTProtoServer: any;
let handleRelayMessage: any;

beforeAll(async() => {
  vi.resetModules();

  vi.doMock('@lib/nostra/message-store', () => ({
    getMessageStore: () => store
  }));
  vi.doMock('@lib/nostra/virtual-peers-db', () => ({
    getPubkey: vi.fn(async(id: number) => id === PEER_ID ? PEER_PUBKEY : null),
    getMapping: vi.fn().mockResolvedValue({displayName: 'Peer'}),
    getDB: vi.fn(),
    storeMapping: vi.fn(),
    getAllMappings: vi.fn().mockResolvedValue([]),
    removeMapping: vi.fn(),
    updateMappingProfile: vi.fn()
  }));
  vi.doMock('@lib/nostra/peer-profile-cache', () => ({
    loadCachedPeerProfile: vi.fn().mockReturnValue(null),
    refreshPeerProfileFromRelays: vi.fn().mockResolvedValue(undefined),
    saveCachedPeerProfile: vi.fn(),
    clearPeerProfileCache: vi.fn()
  }));
  vi.doMock('@lib/nostra/group-store', () => ({
    getGroupStore: () => ({getAll: vi.fn().mockResolvedValue([])})
  }));
  vi.doMock('@lib/nostra/nostra-bridge', () => ({
    NostraBridge: {
      getInstance: () => ({
        mapPubkeyToPeerId: vi.fn().mockResolvedValue(PEER_ID),
        mapEventIdToMid: vi.fn().mockResolvedValue(MID)
      })
    }
  }));
  vi.doMock('@lib/nostra/message-requests', () => ({
    getMessageRequestStore: () => ({
      isKnownContact: vi.fn().mockResolvedValue(true),
      isBlocked: vi.fn().mockResolvedValue(false),
      addRequest: vi.fn()
    })
  }));

  const serverMod = await import('@lib/nostra/virtual-mtproto-server');
  NostraMTProtoServer = serverMod.NostraMTProtoServer;
  const recvMod = await import('@lib/nostra/chat-api-receive');
  handleRelayMessage = recvMod.handleRelayMessage;
});

afterAll(() => {
  vi.unmock('@lib/nostra/message-store');
  vi.unmock('@lib/nostra/virtual-peers-db');
  vi.unmock('@lib/nostra/peer-profile-cache');
  vi.unmock('@lib/nostra/group-store');
  vi.unmock('@lib/nostra/nostra-bridge');
  vi.unmock('@lib/nostra/message-requests');
  vi.restoreAllMocks();
});

describe('FIND-e49755c1 — mirror/IDB coherence', () => {
  it('sender pipeline: VMT.sendMessage → IDB row has mid + twebPeerId + isOutgoing:true', async() => {
    store.rows.clear();
    store.saveMessage.mockClear();

    const mockChatAPI = {
      getActivePeer: vi.fn().mockReturnValue(PEER_PUBKEY),
      connect: vi.fn().mockResolvedValue(undefined),
      // Simulates ChatAPI's authoritative save: full identity triple
      // (mid + twebPeerId + isOutgoing) computed via NostraBridge — exactly
      // what `chat-api.ts:607-635` does in production. VMT no longer
      // performs a "second save" with mid; the architectural contract is
      // that ChatAPI lands a complete row before sendText resolves.
      sendText: vi.fn().mockImplementation(async(content: string, opts?: {twebPeerId?: number; timestampSec?: number}) => {
        const eventId = 'ev_send_001';
        const timestampSec = opts?.timestampSec ?? Math.floor(Date.now() / 1000);
        const {NostraBridge} = await import('@lib/nostra/nostra-bridge');
        const mid = await NostraBridge.getInstance().mapEventIdToMid(eventId, timestampSec);
        const row: any = {
          eventId,
          conversationId: [OWN_PUBKEY, PEER_PUBKEY].sort().join(':'),
          senderPubkey: OWN_PUBKEY,
          content,
          type: 'text',
          timestamp: timestampSec,
          deliveryState: 'sent',
          mid
        };
        if(opts?.twebPeerId !== undefined) {
          row.twebPeerId = opts.twebPeerId;
          row.isOutgoing = true;
        }
        await store.saveMessage(row);
        return eventId;
      })
    };

    const server = new NostraMTProtoServer();
    server.setOwnPubkey(OWN_PUBKEY);
    server.setChatAPI(mockChatAPI);

    await server.handleMethod('messages.sendMessage', {
      peer: {user_id: PEER_ID},
      message: 'hello',
      random_id: BigInt(1)
    });

    // Assert VMT pins the seconds-precision timestamp alongside twebPeerId.
    // Without this pinning the ChatAPI row's `timestamp` could land in a
    // DIFFERENT second than VMT's `mapEventId(eventId, now)` second, and the
    // downstream `latest.mid ?? mapEventId(eventId, latest.timestamp)`
    // fallback (refreshDialogPreview / getDialogs / getHistory) would compute
    // a DIFFERENT mid and inject a ghost into the mirror with no IDB row.
    // This is the FIND-e49755c1 residual closure contract.
    expect(mockChatAPI.sendText).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({twebPeerId: PEER_ID, timestampSec: expect.any(Number)})
    );
    const sendTextCall = mockChatAPI.sendText.mock.calls[0];
    const sendOpts = sendTextCall[1];
    expect(typeof sendOpts.timestampSec).toBe('number');
    expect(sendOpts.timestampSec).toBeGreaterThan(1_700_000_000);

    const row = store.rows.get('ev_send_001');
    expect(row).toBeDefined();
    expect(row.mid).toBe(MID);
    expect(row.twebPeerId).toBe(PEER_ID);
    expect(row.isOutgoing).toBe(true);
    expect(row.content).toBe('hello');
  });

  it('receiver pipeline: chat-api-receive → IDB row has mid + twebPeerId + isOutgoing:false', async() => {
    store.rows.clear();
    store.saveMessage.mockClear();

    // Simulate an incoming DecryptedMessage. timestamp must be within
    // MAX_CREATED_AT_SKEW_SECONDS (3d) of wall clock or chat-api-receive
    // drops it.
    const now = Math.floor(Date.now() / 1000);
    const msg: any = {
      id: 'rumor_hex_001',
      from: PEER_PUBKEY,
      content: JSON.stringify({id: `chat-${now}-1`, content: 'hello back'}),
      timestamp: now,
      tags: [],
      rumorKind: 14
    };

    const ctx: any = {
      ownId: OWN_PUBKEY,
      history: [],
      activePeer: PEER_PUBKEY,
      deliveryTracker: null,
      offlineQueue: null,
      onMessage: null,
      onEdit: null,
      log: Object.assign(() => {}, {warn: () => {}, error: () => {}})
    };

    await handleRelayMessage(msg, ctx);

    // Give the fire-and-forget save a tick.
    await new Promise((r) => setTimeout(r, 10));

    const row = store.rows.get('rumor_hex_001');
    expect(row).toBeDefined();
    expect(row.mid).toBe(MID);
    expect(row.twebPeerId).toBe(PEER_ID);
    expect(row.isOutgoing).toBe(false);
    expect(row.senderPubkey).toBe(PEER_PUBKEY);
    expect(row.deliveryState).toBe('delivered');
  });

  it('race-safe merge: partial save after full save preserves mid via message-store merge', async() => {
    store.rows.clear();
    // Simulate the order: VMT's full save lands first, then ChatAPI's stale
    // updateMessageStatus save (partial, no mid) arrives. Final row must
    // still carry mid.
    await store.saveMessage({
      eventId: 'ev_race',
      conversationId: 'c',
      senderPubkey: OWN_PUBKEY,
      content: 't',
      type: 'text',
      timestamp: 1,
      deliveryState: 'sent',
      mid: MID,
      twebPeerId: PEER_ID,
      isOutgoing: true
    });
    await store.saveMessage({
      eventId: 'ev_race',
      conversationId: 'c',
      senderPubkey: OWN_PUBKEY,
      content: 't',
      type: 'text',
      timestamp: 1,
      deliveryState: 'sent'
    });
    const row = store.rows.get('ev_race');
    expect(row.mid).toBe(MID);
    expect(row.twebPeerId).toBe(PEER_ID);
    expect(row.isOutgoing).toBe(true);
  });
});
