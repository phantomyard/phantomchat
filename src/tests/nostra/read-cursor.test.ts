/**
 * Tests for the per-conversation read cursor stored in message-store.
 *
 * Covers:
 *   - getReadCursor default (0) + roundtrip with setReadCursor
 *   - monotonic write semantics (lower mid is rejected as a no-op)
 *   - countUnread against the cursor, outgoing skip, contact-init- skip
 */

import '../setup';
import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach} from 'vitest';
import {MessageStore, StoredMessage} from '@lib/nostra/message-store';

const OWN_PUBKEY = 'aaaa'.repeat(16);
const PEER_PUBKEY = 'bbbb'.repeat(16);

let midCounter = 10000;
let convCounter = 0;

function uniqueConvId(): string {
  return `cursor-test-${++convCounter}-${Date.now()}`;
}

function makeMsg(conversationId: string, overrides: Partial<StoredMessage> = {}): StoredMessage {
  const mid = overrides.mid ?? ++midCounter;
  return {
    eventId: overrides.eventId || ('evt-' + mid + '-' + Math.random().toString(36).slice(2, 8)),
    conversationId,
    senderPubkey: PEER_PUBKEY,
    content: 'hello',
    type: 'text',
    timestamp: Math.floor(Date.now() / 1000) + (mid % 1000),
    deliveryState: 'delivered',
    mid,
    twebPeerId: 1_000_000_000_000_001,
    isOutgoing: false,
    ...overrides
  };
}

describe('MessageStore read cursor', () => {
  let store: MessageStore;
  let convId: string;

  beforeEach(() => {
    store = new MessageStore();
    convId = uniqueConvId();
  });

  describe('getReadCursor', () => {
    it('returns 0 when no cursor has been written', async() => {
      expect(await store.getReadCursor(convId)).toBe(0);
    });
  });

  describe('setReadCursor', () => {
    it('persists the written value', async() => {
      await store.setReadCursor(convId, 42);
      expect(await store.getReadCursor(convId)).toBe(42);
    });

    it('is idempotent — writing the same value twice is a no-op', async() => {
      await store.setReadCursor(convId, 42);
      await store.setReadCursor(convId, 42);
      expect(await store.getReadCursor(convId)).toBe(42);
    });

    it('advances when the new mid is larger', async() => {
      await store.setReadCursor(convId, 10);
      await store.setReadCursor(convId, 99);
      expect(await store.getReadCursor(convId)).toBe(99);
    });

    it('rejects writes with a lower mid (monotonic)', async() => {
      await store.setReadCursor(convId, 99);
      await store.setReadCursor(convId, 10);
      expect(await store.getReadCursor(convId)).toBe(99);
    });

    it('different conversations have independent cursors', async() => {
      const convB = uniqueConvId();
      await store.setReadCursor(convId, 10);
      await store.setReadCursor(convB, 20);
      expect(await store.getReadCursor(convId)).toBe(10);
      expect(await store.getReadCursor(convB)).toBe(20);
    });
  });

  describe('countUnread', () => {
    it('returns 0 for an empty conversation', async() => {
      expect(await store.countUnread(convId, OWN_PUBKEY)).toBe(0);
    });

    it('counts incoming messages above the cursor', async() => {
      await store.saveMessage(makeMsg(convId, {mid: 1, isOutgoing: false}));
      await store.saveMessage(makeMsg(convId, {mid: 2, isOutgoing: false}));
      await store.saveMessage(makeMsg(convId, {mid: 3, isOutgoing: false}));
      expect(await store.countUnread(convId, OWN_PUBKEY)).toBe(3);
    });

    it('drops below cursor after advance', async() => {
      await store.saveMessage(makeMsg(convId, {mid: 1, isOutgoing: false}));
      await store.saveMessage(makeMsg(convId, {mid: 2, isOutgoing: false}));
      await store.saveMessage(makeMsg(convId, {mid: 3, isOutgoing: false}));
      await store.setReadCursor(convId, 2);
      expect(await store.countUnread(convId, OWN_PUBKEY)).toBe(1);
    });

    it('zero after advancing past the newest message', async() => {
      await store.saveMessage(makeMsg(convId, {mid: 1, isOutgoing: false}));
      await store.saveMessage(makeMsg(convId, {mid: 2, isOutgoing: false}));
      await store.setReadCursor(convId, 999);
      expect(await store.countUnread(convId, OWN_PUBKEY)).toBe(0);
    });

    it('does not count outgoing messages', async() => {
      await store.saveMessage(makeMsg(convId, {mid: 1, senderPubkey: OWN_PUBKEY, isOutgoing: true}));
      await store.saveMessage(makeMsg(convId, {mid: 2, senderPubkey: OWN_PUBKEY, isOutgoing: true}));
      expect(await store.countUnread(convId, OWN_PUBKEY)).toBe(0);
    });

    it('falls back to senderPubkey comparison when isOutgoing is absent', async() => {
      const legacy = makeMsg(convId, {mid: 1, senderPubkey: OWN_PUBKEY});
      delete (legacy as any).isOutgoing;
      await store.saveMessage(legacy);
      expect(await store.countUnread(convId, OWN_PUBKEY)).toBe(0);
    });

    it('skips contact-init- synthetic rows', async() => {
      await store.saveMessage(makeMsg(convId, {
        mid: 1,
        eventId: 'contact-init-' + PEER_PUBKEY.slice(0, 8),
        isOutgoing: false
      }));
      expect(await store.countUnread(convId, OWN_PUBKEY)).toBe(0);
    });

    it('mixes outgoing + incoming correctly', async() => {
      await store.saveMessage(makeMsg(convId, {mid: 1, isOutgoing: false}));
      await store.saveMessage(makeMsg(convId, {mid: 2, senderPubkey: OWN_PUBKEY, isOutgoing: true}));
      await store.saveMessage(makeMsg(convId, {mid: 3, isOutgoing: false}));
      expect(await store.countUnread(convId, OWN_PUBKEY)).toBe(2);
    });
  });
});
