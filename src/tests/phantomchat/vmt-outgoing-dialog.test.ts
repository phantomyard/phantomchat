/**
 * Regression: VMT `messages.sendMessage` for a P2P peer must create/bump the
 * sidebar dialog. Before the fix, `injectOutgoingBubble` wrote
 * `apiProxy.mirrors.messages` and dispatched `history_append` but never
 * dispatched `dialogs_multiupdate`, so:
 *   - a fresh conversation never appeared in the chat list after sending
 *     the first message (only after a full reload, when VMT.getDialogs
 *     rebuilds from message-store);
 *   - an existing conversation did not move to the top of the list nor
 *     refresh its preview on the next send.
 *
 * User-visible symptom (v0.19.2): "apro una chat, scrivo un messaggio, non
 * permane nella lista chat — nemmeno in People / Groups".
 *
 * Rule 8 (see `src/lib/phantomchat/bridge-invariants.ts`): synthetic dialogs
 * dispatched via `dialogs_multiupdate` must carry `topMessage` as the full
 * message object so `setLastMessage` can render the preview without a
 * `getMessageByPeer` round-trip that fails when `hasReachedTheEnd=false`.
 */

import '../setup';
import {describe, it, expect, vi, beforeAll, beforeEach} from 'vitest';

if(!(Number.prototype as any).toPeerId) {
  (Number.prototype as any).toPeerId = function(isChat?: boolean) {
    return isChat ? -Math.abs(this as number) : (this as number);
  };
}

const OWN_PUBKEY = '0'.repeat(64);
const PEER_PUBKEY = 'a'.repeat(64);
const PEER_ID = 1234567890123456;
const MID = 999000000001;

const dispatchEventSpy = vi.fn();
const dispatchEventSingleSpy = vi.fn();

const apiProxyStub: any = {mirrors: {messages: {}, dialogs: {}, peers: {}}};

let PhantomChatMTProtoServer: any;

beforeAll(async() => {
  // Wipe the module cache so other test files' un-mocked imports of
  // @lib/rootScope don't leak through the dynamic `await import('@lib/rootScope')`
  // calls inside virtual-mtproto-server.ts (those bypass the surface-level
  // import map mock and hit whatever was cached first). This was the root
  // cause of the vmt-outgoing-dialog flake (1 of 3 runs failed because the
  // dispatch fell through to the real, unobserved rootScope).
  vi.resetModules();
  vi.doMock('@lib/rootScope', () => ({
    default: {
      dispatchEvent: dispatchEventSpy,
      dispatchEventSingle: dispatchEventSingleSpy,
      addEventListener: vi.fn(),
      managers: {
        appMessagesManager: {
          setMessageToStorage: vi.fn().mockResolvedValue(undefined),
          invalidateHistoryCache: vi.fn().mockResolvedValue(undefined)
        }
      }
    }
  }));

  vi.doMock('@config/debug', async() => {
    const actual: any = await vi.importActual('@config/debug');
    return {
      ...actual,
      MOUNT_CLASS_TO: {...(actual?.MOUNT_CLASS_TO || {}), apiManagerProxy: apiProxyStub}
    };
  });

  vi.doMock('@lib/phantomchat/message-store', () => {
    const store = {
      saveMessage: vi.fn().mockResolvedValue(undefined),
      getConversationId: (a: string, b: string) => [a, b].sort().join(':'),
      getMessages: vi.fn().mockResolvedValue([]),
      countUnread: vi.fn().mockResolvedValue(0),
      getAllConversations: vi.fn().mockResolvedValue([]),
      getReadCursor: vi.fn().mockResolvedValue(0),
      setReadCursor: vi.fn().mockResolvedValue(undefined),
      getByEventId: vi.fn().mockResolvedValue(undefined)
    };
    return {getMessageStore: () => store};
  });

  vi.doMock('@lib/phantomchat/virtual-peers-db', () => ({
    getPubkey: vi.fn(async(peerId: number) => peerId === PEER_ID ? PEER_PUBKEY : undefined),
    getMapping: vi.fn().mockResolvedValue({peerId: PEER_ID, pubkey: PEER_PUBKEY, displayName: 'Test Peer'}),
    getDB: vi.fn(),
    storeMapping: vi.fn(),
    getAllMappings: vi.fn().mockResolvedValue([]),
    removeMapping: vi.fn(),
    updateMappingProfile: vi.fn()
  }));

  vi.doMock('@lib/phantomchat/peer-profile-cache', () => ({
    loadCachedPeerProfile: vi.fn().mockReturnValue(null),
    refreshPeerProfileFromRelays: vi.fn().mockResolvedValue(undefined),
    saveCachedPeerProfile: vi.fn(),
    clearPeerProfileCache: vi.fn()
  }));

  vi.doMock('@lib/phantomchat/group-store', () => ({
    getGroupStore: () => ({getAll: vi.fn().mockResolvedValue([])})
  }));

  vi.doMock('@lib/phantomchat/phantomchat-bridge', () => ({
    PhantomChatBridge: {
      getInstance: () => ({
        mapPubkeyToPeerId: vi.fn().mockResolvedValue(PEER_ID),
        mapEventIdToMid: vi.fn().mockResolvedValue(MID)
      })
    }
  }));

  const mod = await import('@lib/phantomchat/virtual-mtproto-server');
  PhantomChatMTProtoServer = mod.PhantomChatMTProtoServer;
});

/**
 * Poll until `predicate()` returns truthy or `timeoutMs` elapses. The
 * injectOutgoingBubble dispatch chain awaits multiple dynamic imports
 * (rootScope + config/debug) before firing dialogs_multiupdate; on a
 * cold module cache or a busy host, those resolve well past a hardcoded
 * 20ms wait. Polling removes the timing flake (was: 1 of 3 runs failed
 * "expected 0 to be greater than or equal to 1").
 */
async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 1000, stepMs = 10): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const value = predicate();
    if(value) return value;
    await new Promise(r => setTimeout(r, stepMs));
  }
  // Last-chance evaluation so the failing assertion shows the real state.
  return predicate() as T;
}

describe('VMT sendMessage: outgoing dialog bump (regression)', () => {
  let server: any;

  beforeEach(() => {
    dispatchEventSpy.mockClear();
    dispatchEventSingleSpy.mockClear();
    for(const k of Object.keys(apiProxyStub.mirrors.dialogs)) delete apiProxyStub.mirrors.dialogs[k];
    for(const k of Object.keys(apiProxyStub.mirrors.messages)) delete apiProxyStub.mirrors.messages[k];

    server = new PhantomChatMTProtoServer();
    server.setOwnPubkey(OWN_PUBKEY);
    server.setChatAPI({
      getActivePeer: vi.fn().mockReturnValue(PEER_PUBKEY),
      connect: vi.fn().mockResolvedValue(undefined),
      sendText: vi.fn().mockResolvedValue('event-abc-1')
    });
  });

  const collectDialogCalls = () => [
    ...dispatchEventSpy.mock.calls,
    ...dispatchEventSingleSpy.mock.calls
  ].filter(c => c[0] === 'dialogs_multiupdate');

  it('dispatches dialogs_multiupdate on outgoing P2P send', async() => {
    await server.handleMethod('messages.sendMessage', {
      peer: {user_id: PEER_ID},
      message: 'ciao',
      random_id: BigInt(1)
    });

    const dialogCalls = await waitFor(() => {
      const calls = collectDialogCalls();
      return calls.length >= 1 ? calls : undefined;
    });
    expect(dialogCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('dispatched dialog carries topMessage as the full message object', async() => {
    await server.handleMethod('messages.sendMessage', {
      peer: {user_id: PEER_ID},
      message: 'rule-8-check',
      random_id: BigInt(2)
    });

    const dialogCalls = await waitFor(() => {
      const calls = collectDialogCalls();
      return calls.length >= 1 ? calls : undefined;
    });
    const payload = dialogCalls[0][1];
    expect(payload).toBeInstanceOf(Map);

    const entry = Array.from((payload as Map<any, any>).values())[0] as any;
    expect(entry?.dialog).toBeTruthy();
    expect(entry.dialog.topMessage).toBeTruthy();
    expect(entry.dialog.topMessage.message).toBe('rule-8-check');
    expect(entry.dialog.topMessage.pFlags?.out).toBe(true);
  });

  it('populates apiProxy.mirrors.dialogs so filter tabs read it without an extra getDialogs round-trip', async() => {
    await server.handleMethod('messages.sendMessage', {
      peer: {user_id: PEER_ID},
      message: 'mirror-write',
      random_id: BigInt(3)
    });

    const keys = await waitFor(() => {
      const ks = Object.keys(apiProxyStub.mirrors.dialogs);
      return ks.length >= 1 ? ks : undefined;
    });
    expect(keys.length).toBeGreaterThanOrEqual(1);

    // The dialog may be keyed by either the numeric peerId or the tweb
    // PeerId (which, for user peers, is the same number). Accept both.
    const dialog = apiProxyStub.mirrors.dialogs[keys[0]];
    expect(dialog).toBeTruthy();
    expect(dialog.top_message).toBe(MID);
    expect(dialog.unread_count).toBe(0);
  });
});
