/**
 * Tests for per-conversation retention cap in message-store.ts (#107).
 *
 * Verifies: cap enforcement on insert, oldest-by-timestamp pruning (not
 * insertion order — backfill inserts old rows late), upsert-updates never
 * trigger pruning, per-conversation isolation, and the opt-out.
 *
 * Uses fake-indexeddb for real IDB behavior without a browser.
 */

import '../setup';
import 'fake-indexeddb/auto';
import {describe, it, expect} from 'vitest';
import {MessageStore, StoredMessage, MESSAGE_CAP_PER_CHAT} from '@lib/phantomchat/message-store';

const PK_B = 'bbbb'.repeat(16);

let testCounter = 0;
function uniqueConvId(): string {
  return `test-retention-${++testCounter}-${Date.now()}`;
}

let midCounter = 1;
function makeMsg(conversationId: string, timestamp: number, tag: string): StoredMessage {
  return {
    eventId: `evt-${tag}-` + Math.random().toString(36).slice(2, 10),
    conversationId,
    senderPubkey: PK_B,
    content: `msg ${tag}`,
    type: 'text',
    timestamp,
    deliveryState: 'delivered',
    mid: midCounter++,
    twebPeerId: 1_000_000_000_000_001
  };
}

const BASE_TS = 1_700_000_000;

describe('MessageStore retention cap (#107)', () => {
  it('exports a default cap of 500 per chat', () => {
    expect(MESSAGE_CAP_PER_CHAT).toBe(500);
    expect((new MessageStore() as any).messageCap).toBe(500);
  });

  it('prunes oldest beyond the cap on insert', async () => {
    const store = new MessageStore({messageCap: 5});
    const conv = uniqueConvId();
    for(let i = 0; i < 7; i++) {
      await store.saveMessage(makeMsg(conv, BASE_TS + i, `m${i}`));
    }
    const all = await store.getMessages(conv, 100);
    expect(all).toHaveLength(5);
    // Newest-first; the two oldest (m0, m1) are gone
    expect(all.map((m) => m.content)).toEqual(['msg m6', 'msg m5', 'msg m4', 'msg m3', 'msg m2']);
  });

  it('prunes by timestamp, not insertion order (backfill-safe)', async () => {
    const store = new MessageStore({messageCap: 5});
    const conv = uniqueConvId();
    // Live traffic first: newest 5 messages
    for(let i = 5; i < 10; i++) {
      await store.saveMessage(makeMsg(conv, BASE_TS + i, `live${i}`));
    }
    // Backfill arrives late with OLDER timestamps — these must be pruned,
    // not the newer live rows that were inserted first.
    await store.saveMessage(makeMsg(conv, BASE_TS + 1, 'old1'));
    await store.saveMessage(makeMsg(conv, BASE_TS + 2, 'old2'));
    const all = await store.getMessages(conv, 100);
    expect(all).toHaveLength(5);
    expect(all.every((m) => m.content.startsWith('msg live'))).toBe(true);
  });

  it('upsert-update never prunes and does not inflate the count', async () => {
    const store = new MessageStore({messageCap: 5});
    const conv = uniqueConvId();
    for(let i = 0; i < 5; i++) {
      await store.saveMessage(makeMsg(conv, BASE_TS + i, `m${i}`));
    }
    // Edit the newest row in place (same eventId) — count stays 5, no prune
    const newest = (await store.getMessages(conv, 1))[0];
    await store.saveMessage({...newest, content: 'edited', editedAt: BASE_TS + 100});
    const all = await store.getMessages(conv, 100);
    expect(all).toHaveLength(5);
    expect(all[0].content).toBe('edited');
  });

  it('caps each conversation independently', async () => {
    const store = new MessageStore({messageCap: 3});
    const convA = uniqueConvId();
    const convB = uniqueConvId();
    for(let i = 0; i < 6; i++) {
      await store.saveMessage(makeMsg(convA, BASE_TS + i, `a${i}`));
    }
    for(let i = 0; i < 3; i++) {
      await store.saveMessage(makeMsg(convB, BASE_TS + i, `b${i}`));
    }
    expect(await store.getMessages(convA, 100)).toHaveLength(3);
    expect(await store.getMessages(convB, 100)).toHaveLength(3);
  });

  it('holds the cap at steady state across many inserts', async () => {
    const store = new MessageStore({messageCap: 10});
    const conv = uniqueConvId();
    for(let i = 0; i < 50; i++) {
      await store.saveMessage(makeMsg(conv, BASE_TS + i, `s${i}`));
    }
    const all = await store.getMessages(conv, 100);
    expect(all).toHaveLength(10);
    expect(all[0].content).toBe('msg s49'); // newest survived
    expect(all[9].content).toBe('msg s40'); // everything older pruned
  });

  it('messageCap: Infinity disables pruning', async () => {
    const store = new MessageStore({messageCap: Infinity});
    const conv = uniqueConvId();
    for(let i = 0; i < 12; i++) {
      await store.saveMessage(makeMsg(conv, BASE_TS + i, `x${i}`));
    }
    expect(await store.getMessages(conv, 100)).toHaveLength(12);
  });
});
