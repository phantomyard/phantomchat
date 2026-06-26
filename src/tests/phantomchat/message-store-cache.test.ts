/**
 * Perf (Phase 2 — receive-path caching, part 2): the in-memory tombstone cache
 * and the dedup seen-set in MessageStore. getTombstone + the getByEventId dedup
 * run on every incoming message; both are now served from memory. These tests
 * use the REAL store over fake-indexeddb and verify cache correctness, monotonic
 * + clear invalidation, the seen-set fast path, and cross-tab tombstone
 * propagation (so the delete-boomerang suppression never goes stale).
 */
import 'fake-indexeddb/auto';
import {describe, it, expect} from 'vitest';
import {MessageStore} from '@lib/phantomchat/message-store';

let n = 0;
const uniq = () => `${Date.now()}-${n++}`;
const msg = (eventId: string, conversationId: string, timestamp: number) => ({
  eventId,
  conversationId,
  senderPubkey: 'a'.repeat(64),
  content: 'hi',
  type: 'text' as const,
  timestamp,
  deliveryState: 'delivered' as const,
  mid: timestamp * 1000,
  twebPeerId: 123
});

describe('MessageStore tombstone cache', () => {
  it('serves the watermark from cache after a write', async() => {
    const s = new MessageStore();
    const c = 'conv-' + uniq();
    expect(await s.getTombstone(c)).toBe(0);
    await s.setTombstone(c, 100);
    expect(await s.getTombstone(c)).toBe(100);
  });

  it('is monotonic — a lower write never lowers the cached watermark', async() => {
    const s = new MessageStore();
    const c = 'conv-' + uniq();
    await s.setTombstone(c, 100);
    await s.setTombstone(c, 50);
    expect(await s.getTombstone(c)).toBe(100);
  });

  it('clearTombstone resets the cached watermark to 0', async() => {
    const s = new MessageStore();
    const c = 'conv-' + uniq();
    await s.setTombstone(c, 100);
    expect(await s.getTombstone(c)).toBe(100);
    await s.clearTombstone(c);
    expect(await s.getTombstone(c)).toBe(0);
  });

  it('a fresh store (cold cache) reads the persisted watermark from IDB', async() => {
    const c = 'conv-' + uniq();
    await new MessageStore().setTombstone(c, 200);
    expect(await new MessageStore().getTombstone(c)).toBe(200);
  });

  it('a read-only store still gets a cross-tab delete (no stale 0)', async() => {
    if(typeof BroadcastChannel === 'undefined') return;
    const c = 'conv-' + uniq();
    const reader = new MessageStore();
    const writer = new MessageStore();
    expect(await reader.getTombstone(c)).toBe(0); // cold → caches 0 + activates listener
    await writer.setTombstone(c, 300); // another tab deletes → broadcasts
    await new Promise((r) => setTimeout(r, 30));
    expect(await reader.getTombstone(c)).toBe(300); // cache updated cross-tab
  });
});

describe('MessageStore dedup seen-set', () => {
  it('marks an eventId seen after saveMessage', async() => {
    const s = new MessageStore();
    const ev = 'ev-' + uniq();
    expect(s.hasSeenEventId(ev)).toBe(false);
    await s.saveMessage(msg(ev, 'conv-' + uniq(), 1_700_000_000));
    expect(s.hasSeenEventId(ev)).toBe(true);
  });

  it('records a hit on getByEventId so the next dedup is a fast path', async() => {
    const ev = 'ev-' + uniq();
    await new MessageStore().saveMessage(msg(ev, 'conv-' + uniq(), 1_700_000_000));
    const reader = new MessageStore(); // cold seen-set
    expect(reader.hasSeenEventId(ev)).toBe(false);
    expect(await reader.getByEventId(ev)).toBeTruthy();
    expect(reader.hasSeenEventId(ev)).toBe(true);
  });

  it('does not mark an unknown eventId as seen', async() => {
    const reader = new MessageStore();
    const ev = 'ev-' + uniq();
    expect(await reader.getByEventId(ev)).toBeNull();
    expect(reader.hasSeenEventId(ev)).toBe(false);
  });
});
