/**
 * Tests for message-store.ts
 *
 * Verifies: save/upsert, getMessages, getLatestTimestamp,
 * deleteMessages, deleteByMid, getByEventId, getConversationId,
 * getAllConversationIds.
 *
 * Uses fake-indexeddb for real IDB behavior without a browser.
 */

import '../setup';
import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach, afterAll, vi} from 'vitest';
import {MessageStore, StoredMessage} from '@lib/nostra/message-store';

const PK_A = 'aaaa'.repeat(16);
const PK_B = 'bbbb'.repeat(16);
const PK_C = 'cccc'.repeat(16);

let testCounter = 0;

/** Generate a unique conversation ID per test to avoid fake-indexeddb cross-contamination */
function uniqueConvId(): string {
  return `test-conv-${++testCounter}-${Date.now()}`;
}

let midCounter = 1;
function makeMsg(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    eventId: 'evt-' + Math.random().toString(36).slice(2, 10),
    conversationId: overrides.conversationId || uniqueConvId(),
    senderPubkey: PK_B,
    content: 'Hello',
    type: 'text',
    timestamp: Math.floor(Date.now() / 1000),
    deliveryState: 'delivered',
    mid: midCounter++,
    twebPeerId: 1_000_000_000_000_001,
    ...overrides
  };
}

// Each test gets a fresh MessageStore via private constructor access
// (singleton bypass for test isolation)
function freshStore(): MessageStore {
  return new MessageStore();
}

describe('MessageStore', () => {
  let store: MessageStore;

  beforeEach(() => {
    store = freshStore();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe('getConversationId', () => {
    it('sorts pubkeys alphabetically', () => {
      const id1 = store.getConversationId(PK_A, PK_B);
      const id2 = store.getConversationId(PK_B, PK_A);
      expect(id1).toBe(id2);
      expect(id1).toContain(':');
    });

    it('different pairs give different IDs', () => {
      const id1 = store.getConversationId(PK_A, PK_B);
      const id2 = store.getConversationId(PK_A, PK_C);
      expect(id1).not.toBe(id2);
    });
  });

  describe('saveMessage + getByEventId', () => {
    it('saves and retrieves a message', async() => {
      const msg = makeMsg({eventId: 'evt-save-1'});
      await store.saveMessage(msg);
      const result = await store.getByEventId('evt-save-1');
      expect(result).not.toBeNull();
      expect(result!.content).toBe('Hello');
      expect(result!.senderPubkey).toBe(PK_B);
    });

    it('returns null for non-existent eventId', async() => {
      const result = await store.getByEventId('evt-nonexistent');
      expect(result).toBeNull();
    });

    it('upserts by eventId (merge preserves mid)', async() => {
      const msg = makeMsg({eventId: 'evt-upsert', mid: 12345});
      await store.saveMessage(msg);

      // Save again without mid — should preserve existing mid
      const update = makeMsg({eventId: 'evt-upsert', content: 'Updated', mid: undefined});
      await store.saveMessage(update);

      const result = await store.getByEventId('evt-upsert');
      expect(result!.content).toBe('Updated');
      expect(result!.mid).toBe(12345); // preserved from first save
    });

    it('upserts preserves isOutgoing', async() => {
      const msg = makeMsg({eventId: 'evt-out', isOutgoing: true});
      await store.saveMessage(msg);

      const update = makeMsg({eventId: 'evt-out', isOutgoing: undefined});
      await store.saveMessage(update);

      const result = await store.getByEventId('evt-out');
      expect(result!.isOutgoing).toBe(true);
    });
  });

  describe('getMessages', () => {
    it('returns messages for a conversation sorted by timestamp desc', async() => {
      const convId = uniqueConvId();
      await store.saveMessage(makeMsg({eventId: 'e1', conversationId: convId, timestamp: 100}));
      await store.saveMessage(makeMsg({eventId: 'e2', conversationId: convId, timestamp: 300}));
      await store.saveMessage(makeMsg({eventId: 'e3', conversationId: convId, timestamp: 200}));

      const msgs = await store.getMessages(convId, 10);
      expect(msgs).toHaveLength(3);
      expect(msgs[0].timestamp).toBe(300);
      expect(msgs[1].timestamp).toBe(200);
      expect(msgs[2].timestamp).toBe(100);
    });

    it('respects limit', async() => {
      const convId = uniqueConvId();
      for(let i = 0; i < 5; i++) {
        await store.saveMessage(makeMsg({eventId: `lim-${i}`, conversationId: convId, timestamp: i}));
      }
      const msgs = await store.getMessages(convId, 2);
      expect(msgs).toHaveLength(2);
    });

    it('does not return messages from other conversations', async() => {
      const conv1 = uniqueConvId();
      const conv2 = uniqueConvId();
      await store.saveMessage(makeMsg({eventId: 'x1', conversationId: conv1}));
      await store.saveMessage(makeMsg({eventId: 'x2', conversationId: conv2}));

      const msgs = await store.getMessages(conv1, 10);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].eventId).toBe('x1');
    });

    it('supports before parameter for pagination', async() => {
      const convId = uniqueConvId();
      await store.saveMessage(makeMsg({eventId: 'p1', conversationId: convId, timestamp: 100}));
      await store.saveMessage(makeMsg({eventId: 'p2', conversationId: convId, timestamp: 200}));
      await store.saveMessage(makeMsg({eventId: 'p3', conversationId: convId, timestamp: 300}));

      const msgs = await store.getMessages(convId, 10, 250);
      expect(msgs).toHaveLength(2);
      expect(msgs[0].timestamp).toBe(200);
      expect(msgs[1].timestamp).toBe(100);
    });
  });

  describe('getLatestTimestamp', () => {
    it('returns max timestamp for a conversation', async() => {
      const convId = uniqueConvId();
      await store.saveMessage(makeMsg({eventId: 'ts1', conversationId: convId, timestamp: 100}));
      await store.saveMessage(makeMsg({eventId: 'ts2', conversationId: convId, timestamp: 500}));
      await store.saveMessage(makeMsg({eventId: 'ts3', conversationId: convId, timestamp: 300}));

      const latest = await store.getLatestTimestamp(convId);
      expect(latest).toBe(500);
    });

    it('returns 0 for empty conversation', async() => {
      const latest = await store.getLatestTimestamp('nonexistent:conv');
      expect(latest).toBe(0);
    });
  });

  describe('deleteMessages', () => {
    it('deletes all messages in a conversation', async() => {
      const convId = uniqueConvId();
      await store.saveMessage(makeMsg({eventId: 'del1', conversationId: convId}));
      await store.saveMessage(makeMsg({eventId: 'del2', conversationId: convId}));

      await store.deleteMessages(convId);

      const msgs = await store.getMessages(convId, 10);
      expect(msgs).toHaveLength(0);
    });

    it('deletes specific eventIds only', async() => {
      const convId = uniqueConvId();
      await store.saveMessage(makeMsg({eventId: 'keep', conversationId: convId}));
      await store.saveMessage(makeMsg({eventId: 'remove', conversationId: convId}));

      await store.deleteMessages(convId, ['remove']);

      const msgs = await store.getMessages(convId, 10);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].eventId).toBe('keep');
    });
  });

  describe('deleteByMid', () => {
    it('deletes a message by its tweb mid', async() => {
      const convId = uniqueConvId();
      await store.saveMessage(makeMsg({eventId: 'mid-1', conversationId: convId, mid: 99999}));
      await store.saveMessage(makeMsg({eventId: 'mid-2', conversationId: convId, mid: 88888}));

      await store.deleteByMid(99999);

      const result = await store.getByEventId('mid-1');
      expect(result).toBeNull();
      const kept = await store.getByEventId('mid-2');
      expect(kept).not.toBeNull();
    });

    it('no-ops for non-existent mid', async() => {
      // Should not throw
      await store.deleteByMid(999999);
    });
  });

  describe('getAllConversationIds', () => {
    it('returns distinct conversation IDs', async() => {
      const conv1 = uniqueConvId();
      const conv2 = uniqueConvId();
      await store.saveMessage(makeMsg({eventId: 'ac1', conversationId: conv1}));
      await store.saveMessage(makeMsg({eventId: 'ac2', conversationId: conv1}));
      await store.saveMessage(makeMsg({eventId: 'ac3', conversationId: conv2}));

      const ids = await store.getAllConversationIds();
      // At least these 2 — may have more from other tests (shared fake-indexeddb)
      expect(ids).toContain(conv1);
      expect(ids).toContain(conv2);
    });
  });
});
