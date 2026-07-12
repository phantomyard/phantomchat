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
import {MessageStore, StoredMessage} from '@lib/phantomchat/message-store';

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

  describe('reKeyEventId (offline send → canonical rumor id)', () => {
    it('migrates a row to the new eventId in place, preserving the identity triple', async() => {
      const APP = 'chat-1700000000000-0';
      const RUMOR = 'a'.repeat(64);
      await store.saveMessage(makeMsg({eventId: APP, mid: 555, twebPeerId: 42, isOutgoing: true, content: 'offline text'}));

      const ok = await store.reKeyEventId(APP, RUMOR);
      expect(ok).toBe(true);

      // Old key gone, new key resolves to the SAME row (mid/twebPeerId intact).
      expect(await store.getByEventId(APP)).toBeNull();
      const moved = await store.getByEventId(RUMOR);
      expect(moved).not.toBeNull();
      expect(moved!.mid).toBe(555);
      expect(moved!.twebPeerId).toBe(42);
      expect(moved!.isOutgoing).toBe(true);
      expect(moved!.content).toBe('offline text');
      // The old app id is retained so app-level lookups still resolve.
      expect(moved!.appMessageId).toBe(APP);
      expect(await store.getByAppMessageId(APP)).not.toBeNull();
    });

    it('returns false when the old row is missing', async() => {
      expect(await store.reKeyEventId('chat-missing-0', 'b'.repeat(64))).toBe(false);
    });

    it('returns false (no duplicate) when the new key already exists', async() => {
      await store.saveMessage(makeMsg({eventId: 'chat-x-0', mid: 1}));
      await store.saveMessage(makeMsg({eventId: 'c'.repeat(64), mid: 2}));
      expect(await store.reKeyEventId('chat-x-0', 'c'.repeat(64))).toBe(false);
      // Original still intact under its app id.
      expect(await store.getByEventId('chat-x-0')).not.toBeNull();
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

  describe('getConversationDigest (device-sync)', () => {
    it('returns count and the newest eventId by timestamp', async() => {
      const convId = uniqueConvId();
      await store.saveMessage(makeMsg({eventId: 'd1', conversationId: convId, timestamp: 100}));
      await store.saveMessage(makeMsg({eventId: 'd2', conversationId: convId, timestamp: 300}));
      await store.saveMessage(makeMsg({eventId: 'd3', conversationId: convId, timestamp: 200}));

      const digest = await store.getConversationDigest(convId);
      expect(digest.count).toBe(3);
      expect(digest.latestId).toBe('d2');
      expect(digest.latestTimestamp).toBe(300);
    });

    it('breaks a timestamp tie by highest eventId (deterministic across devices)', async() => {
      const convId = uniqueConvId();
      await store.saveMessage(makeMsg({eventId: 'aaa', conversationId: convId, timestamp: 500}));
      await store.saveMessage(makeMsg({eventId: 'zzz', conversationId: convId, timestamp: 500}));

      const digest = await store.getConversationDigest(convId);
      expect(digest.count).toBe(2);
      expect(digest.latestId).toBe('zzz');
    });

    it('returns an empty digest for an unknown conversation', async() => {
      const digest = await store.getConversationDigest('nonexistent:conv');
      expect(digest.count).toBe(0);
      expect(digest.latestId).toBe('');
      expect(digest.latestTimestamp).toBe(0);
    });

    it('scopes strictly to the given conversation', async() => {
      const conv1 = uniqueConvId();
      const conv2 = uniqueConvId();
      await store.saveMessage(makeMsg({eventId: 's1', conversationId: conv1, timestamp: 10}));
      await store.saveMessage(makeMsg({eventId: 's2', conversationId: conv2, timestamp: 20}));
      await store.saveMessage(makeMsg({eventId: 's3', conversationId: conv2, timestamp: 30}));

      expect((await store.getConversationDigest(conv1)).count).toBe(1);
      expect((await store.getConversationDigest(conv2)).count).toBe(2);
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

  describe('tombstones', () => {
    it('returns 0 for a conversation that has never been deleted', async() => {
      expect(await store.getTombstone(uniqueConvId())).toBe(0);
    });

    it('round-trips a deletion watermark', async() => {
      const conv = uniqueConvId();
      await store.setTombstone(conv, 1000);
      expect(await store.getTombstone(conv)).toBe(1000);
    });

    it('is monotonic — a lower watermark never overwrites a higher one', async() => {
      const conv = uniqueConvId();
      await store.setTombstone(conv, 2000);
      await store.setTombstone(conv, 1000); // stale re-delete
      expect(await store.getTombstone(conv)).toBe(2000);
      await store.setTombstone(conv, 3000); // newer re-delete moves forward
      expect(await store.getTombstone(conv)).toBe(3000);
    });

    it('clearTombstone removes the watermark', async() => {
      const conv = uniqueConvId();
      await store.setTombstone(conv, 1000);
      await store.clearTombstone(conv);
      expect(await store.getTombstone(conv)).toBe(0);
    });

    it('saveMessage drops a message at-or-before the watermark', async() => {
      const conv = uniqueConvId();
      await store.setTombstone(conv, 5000);

      // at the watermark — dropped
      await store.saveMessage(makeMsg({eventId: 'ts-at', conversationId: conv, timestamp: 5000}));
      expect(await store.getByEventId('ts-at')).toBeNull();

      // before the watermark — dropped
      await store.saveMessage(makeMsg({eventId: 'ts-before', conversationId: conv, timestamp: 4999}));
      expect(await store.getByEventId('ts-before')).toBeNull();
    });

    it('saveMessage lets a strictly-newer message through (revival)', async() => {
      const conv = uniqueConvId();
      await store.setTombstone(conv, 5000);

      await store.saveMessage(makeMsg({eventId: 'ts-after', conversationId: conv, timestamp: 5001}));
      expect(await store.getByEventId('ts-after')).not.toBeNull();

      // Watermark is a permanent low-water mark — NOT cleared by the revival,
      // so older replays stay suppressed even after the conversation revives.
      expect(await store.getTombstone(conv)).toBe(5000);
      await store.saveMessage(makeMsg({eventId: 'ts-old-replay', conversationId: conv, timestamp: 4000}));
      expect(await store.getByEventId('ts-old-replay')).toBeNull();
    });
  });
});
