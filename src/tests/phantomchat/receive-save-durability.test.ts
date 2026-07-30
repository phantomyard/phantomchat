/**
 * Regression: handleRelayMessage must AWAIT the incoming-message IndexedDB
 * put before completing. The relay pool holds lastSeenTimestamp until the
 * handler finishes, so "handler complete ⇒ row durable" is the contract that
 * keeps a PWA close from permanently losing a received message — the bubble
 * renders from memory either way, but with a fire-and-forget put the row
 * could be dropped while the watermark had already claimed delivery (the
 * vanishing-reply bug: there on first reopen via relay replay, gone for good
 * once the replay window moved past it).
 */

import 'fake-indexeddb/auto';
import {describe, it, expect, afterAll, vi} from 'vitest';
import {handleRelayMessage, ReceiveContext} from '@lib/phantomchat/chat-api-receive';
import {getMessageStore} from '@lib/phantomchat/message-store';
import type {DecryptedMessage} from '@lib/phantomchat/nostr-relay';

vi.mock('@lib/phantomchat/message-requests', () => ({
  getMessageRequestStore: () => ({
    isBlocked: async() => false,
    isKnownContact: async() => true,
    addRequest: async() => {}
  })
}));

vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn()
  }
}));

// The incoming save resolves mid/twebPeerId through the bridge — stub it so
// this suite doesn't drag the whole bridge/transport graph in.
vi.mock('@lib/phantomchat/phantomchat-bridge', () => ({
  PhantomChatBridge: {
    getInstance: () => ({
      mapPubkeyToPeerId: async() => 424242,
      storePeerMapping: async() => {},
      mapEventIdToMid: async(_id: string, tsSec: number) => tsSec * 1000000 + 1
    })
  }
}));

afterAll(() => {
  vi.unmock('@lib/rootScope');
  vi.unmock('@lib/phantomchat/message-requests');
  vi.unmock('@lib/phantomchat/phantomchat-bridge');
  vi.restoreAllMocks();
});

const SENDER_PUB = 'd'.repeat(64);
const OWN_PUB = 'e'.repeat(64);

function makeCtx(overrides: Partial<ReceiveContext> = {}): ReceiveContext {
  const log = Object.assign(((..._args: any[]) => {}) as any, {
    warn: (..._args: any[]) => {},
    error: (..._args: any[]) => {}
  });
  return {
    ownId: OWN_PUB,
    history: [],
    activePeer: SENDER_PUB,
    deliveryTracker: null,
    offlineQueue: null,
    onMessage: null,
    onEdit: null,
    log,
    ...overrides
  };
}

function textRumor(idHex: string, text: string): DecryptedMessage {
  return {
    id: idHex,
    from: SENDER_PUB,
    content: JSON.stringify({
      id: 'chat-dur-1',
      from: SENDER_PUB,
      to: OWN_PUB,
      type: 'text',
      content: text,
      timestamp: Date.now()
    }),
    // Anchor to wall-clock: rumors outside the created_at skew window are
    // dropped before the save path is ever reached.
    timestamp: Math.floor(Date.now() / 1000),
    rumorKind: 14,
    tags: [['p', OWN_PUB]]
  };
}

describe('handleRelayMessage — incoming save durability', () => {
  it('does not complete until the IndexedDB put has committed', async() => {
    const store = getMessageStore();
    const original = store.saveMessage.bind(store);

    let markStarted!: () => void;
    let openGate!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const gate = new Promise<void>((resolve) => { openGate = resolve; });

    const spy = vi.spyOn(store, 'saveMessage').mockImplementation(async(msg: any) => {
      markStarted();
      await gate; // hold the put open — this IS the PWA-close window
      return original(msg);
    });

    try {
      const rumor = textRumor('f'.repeat(64), 'durable hello');
      const resultPromise = handleRelayMessage(rumor, makeCtx());

      await started; // the put has been initiated…
      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      // …but the handler must still be in flight while the put is.
      expect(settled).toBe(false);

      openGate();
      const result = await resultPromise;
      expect(result.action).toBe('received');
      expect(settled).toBe(true);

      // And the row is genuinely durable with its identity triple.
      const row = await store.getByEventId(rumor.id);
      expect(row?.content).toBe('durable hello');
      expect(row?.mid).toBeDefined();
      expect(row?.twebPeerId).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('still completes (and notifies) when the put itself fails', async() => {
    // A failed save must not wedge the handler: the bubble lives in memory
    // and the caller's watermark handling must be able to move on.
    const store = getMessageStore();
    const spy = vi.spyOn(store, 'saveMessage').mockRejectedValue(new Error('idb boom'));
    const onMessage = vi.fn();

    try {
      const rumor = textRumor('1'.repeat(64), 'lost write');
      const result = await handleRelayMessage(rumor, makeCtx({onMessage}));

      expect(result.action).toBe('received');
      expect(onMessage).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
