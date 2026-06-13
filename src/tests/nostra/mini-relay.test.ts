// @ts-nocheck
/**
 * Tests for MiniRelay NIP-01 protocol handler
 *
 * Verifies: EVENT handling, REQ/subscription management, CLOSE,
 * store-and-forward for offline contacts.
 *
 * Uses fake-indexeddb for real IDB behavior without a browser.
 */

import '../setup';
import 'fake-indexeddb/auto';
import {describe, it, expect, beforeEach, afterAll, vi} from 'vitest';
import {RelayStore, NostrEvent} from '@lib/nostra/relay-store';
import {MiniRelay, MAX_EVENT_AGE, MAX_EVENT_SIZE, RATE_LIMIT_PER_SECOND} from '@lib/nostra/mini-relay';

// ─── Helpers ───────────────────────────────────────────────────────

let dbCounter = 0;

function uniqueDb(): string {
  return `mini-relay-test-${Date.now()}-${++dbCounter}`;
}

const PK_A = 'aaaa'.repeat(16);
const PK_B = 'bbbb'.repeat(16);
const PK_C = 'cccc'.repeat(16);

let evCounter = 0;

function makeEvent(overrides: Partial<NostrEvent> = {}): NostrEvent {
  const id = overrides.id || `ev-${++evCounter}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    pubkey: PK_A,
    kind: 1059,
    created_at: Math.floor(Date.now() / 1000),
    content: 'hello',
    tags: [],
    sig: 'sig' + id,
    ...overrides
  };
}

function makeRelay(contactPubkeys: string[] = []) {
  const store = new RelayStore(uniqueDb());
  const sent: Array<{peerId: string; msg: string}> = [];
  const sendFn = vi.fn((peerId: string, msg: string) => {
    sent.push({peerId, msg});
  });
  const relay = new MiniRelay(store, contactPubkeys, sendFn);
  return {relay, store, sent, sendFn};
}

function parseSent(sent: Array<{peerId: string; msg: string}>, peerId?: string) {
  return sent
    .filter((s) => !peerId || s.peerId === peerId)
    .map((s) => JSON.parse(s.msg));
}

// ─── Test Suite ────────────────────────────────────────────────────

afterAll(() => {
  vi.restoreAllMocks();
});

// ────────────────────────────────────────────────────────────────────
// EVENT tests
// ────────────────────────────────────────────────────────────────────

describe('MiniRelay — EVENT: valid event', () => {
  it('responds OK to a valid kind 1059 EVENT', async() => {
    const {relay, sent} = makeRelay();
    const event = makeEvent({kind: 1059});
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    const msgs = parseSent(sent, 'peer-1');
    const ok = msgs.find((m) => m[0] === 'OK');
    expect(ok).toBeDefined();
    expect(ok[1]).toBe(event.id);
    expect(ok[2]).toBe(true);
  });
});

describe('MiniRelay — EVENT: kind rejection', () => {
  it('rejects non-1059 kinds with OK false', async() => {
    const {relay, sent} = makeRelay();
    const event = makeEvent({kind: 1}); // text note — not allowed
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    const msgs = parseSent(sent, 'peer-1');
    const ok = msgs.find((m) => m[0] === 'OK');
    expect(ok).toBeDefined();
    expect(ok[2]).toBe(false);
    expect(ok[3]).toMatch(/blocked/);
  });
});

describe('MiniRelay — EVENT: age rejection', () => {
  it('rejects events older than 72 hours', async() => {
    const {relay, sent} = makeRelay();
    const oldTimestamp = Math.floor(Date.now() / 1000) - MAX_EVENT_AGE - 1;
    const event = makeEvent({kind: 1059, created_at: oldTimestamp});
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    const msgs = parseSent(sent, 'peer-1');
    const ok = msgs.find((m) => m[0] === 'OK');
    expect(ok).toBeDefined();
    expect(ok[2]).toBe(false);
    expect(ok[3]).toMatch(/too old/);
  });
});

describe('MiniRelay — EVENT: size rejection', () => {
  it('rejects events larger than 64KB', async() => {
    const {relay, sent} = makeRelay();
    // Create event where JSON serialization exceeds MAX_EVENT_SIZE
    const bigContent = 'x'.repeat(MAX_EVENT_SIZE + 1000);
    const event = makeEvent({kind: 1059, content: bigContent});
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    const msgs = parseSent(sent, 'peer-1');
    const ok = msgs.find((m) => m[0] === 'OK');
    expect(ok).toBeDefined();
    expect(ok[2]).toBe(false);
    expect(ok[3]).toMatch(/too large/);
  });
});

describe('MiniRelay — EVENT: deduplication', () => {
  it('deduplicates events — second publish returns OK true with "duplicate"', async() => {
    const {relay, sent} = makeRelay();
    const event = makeEvent({kind: 1059});

    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    const msgs = parseSent(sent, 'peer-1');
    const okMsgs = msgs.filter((m) => m[0] === 'OK');
    expect(okMsgs).toHaveLength(2);

    // First: accepted
    expect(okMsgs[0][2]).toBe(true);
    expect(okMsgs[0][3]).not.toMatch(/duplicate/);

    // Second: duplicate
    expect(okMsgs[1][2]).toBe(true);
    expect(okMsgs[1][3]).toMatch(/duplicate/);
  });
});

// ────────────────────────────────────────────────────────────────────
// REQ tests
// ────────────────────────────────────────────────────────────────────

describe('MiniRelay — REQ: returns matching events + EOSE', () => {
  it('sends stored events matching the filter and EOSE', async() => {
    const {relay, store, sent} = makeRelay();

    // Pre-populate store with events
    const ev1 = makeEvent({kind: 1059, pubkey: PK_A});
    const ev2 = makeEvent({kind: 1059, pubkey: PK_B});
    await store.saveEvent(ev1);
    await store.saveEvent(ev2);

    await relay.handleMessage('peer-1', JSON.stringify(['REQ', 'sub1', {kinds: [1059], authors: [PK_A]}]));

    const msgs = parseSent(sent, 'peer-1');
    const eventMsgs = msgs.filter((m) => m[0] === 'EVENT');
    expect(eventMsgs).toHaveLength(1);
    expect(eventMsgs[0][2].id).toBe(ev1.id);

    const eose = msgs.find((m) => m[0] === 'EOSE');
    expect(eose).toBeDefined();
    expect(eose[1]).toBe('sub1');
  });
});

describe('MiniRelay — REQ: push new events to active subscriptions', () => {
  it('forwards new events from other peers to matching subscriptions', async() => {
    const {relay, sent} = makeRelay();

    // Peer 2 subscribes to kind 1059
    await relay.handleMessage('peer-2', JSON.stringify(['REQ', 'sub2', {kinds: [1059]}]));

    // Clear EOSE and any initial messages
    sent.length = 0;

    // Peer 1 publishes an event
    const event = makeEvent({kind: 1059});
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    // Peer 2 should receive the event
    const peer2Msgs = parseSent(sent, 'peer-2');
    const eventMsgs = peer2Msgs.filter((m) => m[0] === 'EVENT');
    expect(eventMsgs).toHaveLength(1);
    expect(eventMsgs[0][2].id).toBe(event.id);
    expect(eventMsgs[0][1]).toBe('sub2');

    // Peer 1 should NOT receive its own event back via subscription
    const peer1Msgs = parseSent(sent, 'peer-1');
    const peer1EventPushes = peer1Msgs.filter((m) => m[0] === 'EVENT');
    expect(peer1EventPushes).toHaveLength(0);
  });
});

describe('MiniRelay — REQ: subscription limits', () => {
  it('rejects subscriptions beyond MAX_SUBS_PER_PEER', async() => {
    const {relay, sent} = makeRelay();
    const MAX = 20;

    // Add exactly MAX subscriptions
    for(let i = 0; i < MAX; i++) {
      await relay.handleMessage('peer-1', JSON.stringify(['REQ', `sub${i}`, {kinds: [1059]}]));
    }

    // Clear messages so far
    sent.length = 0;

    // One more should be rejected
    await relay.handleMessage('peer-1', JSON.stringify(['REQ', 'subOVER', {kinds: [1059]}]));

    const msgs = parseSent(sent, 'peer-1');
    const notice = msgs.find((m) => m[0] === 'NOTICE');
    expect(notice).toBeDefined();
    expect(notice[1]).toMatch(/too many/);
  });
});

// ────────────────────────────────────────────────────────────────────
// CLOSE tests
// ────────────────────────────────────────────────────────────────────

describe('MiniRelay — CLOSE: removes subscription', () => {
  it('stops pushing events to a closed subscription', async() => {
    const {relay, sent} = makeRelay();

    // Subscribe
    await relay.handleMessage('peer-2', JSON.stringify(['REQ', 'sub-to-close', {kinds: [1059]}]));
    // Close the subscription
    await relay.handleMessage('peer-2', JSON.stringify(['CLOSE', 'sub-to-close']));

    // Clear messages
    sent.length = 0;

    // Peer 1 publishes
    const event = makeEvent({kind: 1059});
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    // Peer 2 should NOT receive any events (subscription was closed)
    const peer2Msgs = parseSent(sent, 'peer-2');
    const eventMsgs = peer2Msgs.filter((m) => m[0] === 'EVENT');
    expect(eventMsgs).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// Store-and-forward tests
// ────────────────────────────────────────────────────────────────────

describe('MiniRelay — store-and-forward: enqueue for offline contact', () => {
  it('enqueues event for offline contact with matching p-tag', async() => {
    const {relay, store} = makeRelay([PK_B]); // PK_B is a contact

    const event = makeEvent({
      kind: 1059,
      tags: [['p', PK_B]]
    });
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    // PK_B is offline (not connected), so event should be in forward queue
    const queue = await store.getForwardQueue(PK_B);
    expect(queue).toHaveLength(1);
    expect(queue[0].eventId).toBe(event.id);
    expect(queue[0].targetPubkey).toBe(PK_B);
  });
});

describe('MiniRelay — store-and-forward: skip non-contacts', () => {
  it('does not enqueue for non-contact p-tag recipients', async() => {
    const {relay, store} = makeRelay([PK_B]); // only PK_B is a contact, not PK_C

    const event = makeEvent({
      kind: 1059,
      tags: [['p', PK_C]] // PK_C is NOT a contact
    });
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    const queueC = await store.getForwardQueue(PK_C);
    expect(queueC).toHaveLength(0);
  });
});

describe('MiniRelay — store-and-forward: flush on peer connect', () => {
  it('flushes forward queue when the target peer connects', async() => {
    const {relay, store, sent} = makeRelay([PK_B]);

    // Save an event to the store
    const event = makeEvent({
      kind: 1059,
      tags: [['p', PK_B]]
    });
    await store.saveEvent(event);

    // Manually enqueue it (simulating an earlier offline forward)
    await store.enqueueForward(PK_B, event.id);

    // PK_B connects on peer-2
    await relay.onPeerConnected('peer-2', PK_B);

    // The queued event should have been forwarded
    const peer2Msgs = parseSent(sent, 'peer-2');
    const eventMsgs = peer2Msgs.filter((m) => m[0] === 'EVENT');
    expect(eventMsgs).toHaveLength(1);
    expect(eventMsgs[0][2].id).toBe(event.id);

    // Queue should be empty now
    const queue = await store.getForwardQueue(PK_B);
    expect(queue).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// Rate limiting tests
// ────────────────────────────────────────────────────────────────────

describe('MiniRelay — rate limiting', () => {
  // Only fake Date.now() — do NOT fake timers/setTimeout/Promise,
  // as fake-indexeddb relies on real macrotask scheduling.
  beforeEach(() => {
    vi.useFakeTimers({toFake: ['Date']});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should reject events after exceeding 10/second rate limit', async() => {
    const {relay, sent} = makeRelay();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);

    // Send RATE_LIMIT_PER_SECOND valid events (all within the same 1s window)
    for(let i = 0; i < RATE_LIMIT_PER_SECOND; i++) {
      const event = makeEvent({kind: 1059, created_at: Math.floor(now / 1000)});
      await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));
    }

    // First 10 should be OK true
    const okMsgs = parseSent(sent, 'peer-1').filter((m) => m[0] === 'OK');
    expect(okMsgs).toHaveLength(RATE_LIMIT_PER_SECOND);
    for(const ok of okMsgs) {
      expect(ok[2]).toBe(true);
    }

    // 11th event should be rate-limited
    sent.length = 0;
    const extra = makeEvent({kind: 1059, created_at: Math.floor(now / 1000)});
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', extra]));

    const rateLimitedMsgs = parseSent(sent, 'peer-1').filter((m) => m[0] === 'OK');
    expect(rateLimitedMsgs).toHaveLength(1);
    expect(rateLimitedMsgs[0][2]).toBe(false);
    expect(rateLimitedMsgs[0][3]).toMatch(/rate-limited/);
  });

  it('should reset rate limit after 1 second window', async() => {
    const {relay, sent} = makeRelay();
    const now = 1_700_000_000_000;
    vi.setSystemTime(now);

    // Send 10 events to fill the window
    for(let i = 0; i < RATE_LIMIT_PER_SECOND; i++) {
      const event = makeEvent({kind: 1059, created_at: Math.floor(now / 1000)});
      await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));
    }

    // Advance Date by 1001ms (past the 1s window) without blocking promises
    vi.setSystemTime(now + 1001);
    sent.length = 0;

    // Next event should succeed (new window)
    const newNow = now + 1001;
    const event = makeEvent({kind: 1059, created_at: Math.floor(newNow / 1000)});
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));

    const okMsgs = parseSent(sent, 'peer-1').filter((m) => m[0] === 'OK');
    expect(okMsgs).toHaveLength(1);
    expect(okMsgs[0][2]).toBe(true);
    expect(okMsgs[0][3]).not.toMatch(/rate-limited/);
  });
});

// ────────────────────────────────────────────────────────────────────
// REQ with multiple filters
// ────────────────────────────────────────────────────────────────────

describe('MiniRelay — REQ with multiple filters', () => {
  it('should match events against any of the provided filters', async() => {
    const {relay, store, sent} = makeRelay();

    const evAlice = makeEvent({kind: 1059, pubkey: PK_A});
    const evBob = makeEvent({kind: 1059, pubkey: PK_B});
    const evCarol = makeEvent({kind: 1059, pubkey: PK_C});
    await store.saveEvent(evAlice);
    await store.saveEvent(evBob);
    await store.saveEvent(evCarol);

    // REQ with two filters: one for alice, one for bob
    await relay.handleMessage('peer-1', JSON.stringify([
      'REQ', 'sub-multi',
      {authors: [PK_A]},
      {authors: [PK_B]}
    ]));

    const msgs = parseSent(sent, 'peer-1');
    const eventMsgs = msgs.filter((m) => m[0] === 'EVENT');
    const ids = eventMsgs.map((m) => m[2].id);

    expect(ids).toContain(evAlice.id);
    expect(ids).toContain(evBob.id);
    expect(ids).not.toContain(evCarol.id);

    const eose = msgs.find((m) => m[0] === 'EOSE');
    expect(eose).toBeDefined();
    expect(eose[1]).toBe('sub-multi');
  });
});

// ────────────────────────────────────────────────────────────────────
// Peer disconnect cleanup
// ────────────────────────────────────────────────────────────────────

describe('MiniRelay — peer disconnect', () => {
  it('should clean up subscriptions on peer disconnect', async() => {
    const {relay, sent} = makeRelay();

    // peer-1 subscribes
    await relay.handleMessage('peer-1', JSON.stringify(['REQ', 'sub-disc', {kinds: [1059]}]));
    sent.length = 0;

    // peer-2 sends an event — peer-1 should receive it
    const ev1 = makeEvent({kind: 1059});
    await relay.handleMessage('peer-2', JSON.stringify(['EVENT', ev1]));

    const before = parseSent(sent, 'peer-1').filter((m) => m[0] === 'EVENT');
    expect(before).toHaveLength(1);
    sent.length = 0;

    // Disconnect peer-1
    relay.onPeerDisconnected('peer-1');

    // peer-2 sends another event — peer-1 should NOT receive it
    const ev2 = makeEvent({kind: 1059});
    await relay.handleMessage('peer-2', JSON.stringify(['EVENT', ev2]));

    const after = parseSent(sent, 'peer-1').filter((m) => m[0] === 'EVENT');
    expect(after).toHaveLength(0);
  });

  it('should clean up rate limit window on peer disconnect', async() => {
    const {relay, sent} = makeRelay();
    // Only fake Date — not timers, so IDB promises resolve normally
    vi.useFakeTimers({toFake: ['Date']});
    const now = 1_700_000_100_000;
    vi.setSystemTime(now);

    // Send 9 events from peer-1 (almost at limit)
    for(let i = 0; i < RATE_LIMIT_PER_SECOND - 1; i++) {
      const event = makeEvent({kind: 1059, created_at: Math.floor(now / 1000)});
      await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));
    }

    // Disconnect peer-1 (clears rate window)
    relay.onPeerDisconnected('peer-1');
    sent.length = 0;

    // Reconnect with same peer id — should get a fresh window (10 events allowed)
    for(let i = 0; i < RATE_LIMIT_PER_SECOND; i++) {
      const event = makeEvent({kind: 1059, created_at: Math.floor(now / 1000)});
      await relay.handleMessage('peer-1', JSON.stringify(['EVENT', event]));
    }

    const okMsgs = parseSent(sent, 'peer-1').filter((m) => m[0] === 'OK');
    // All 10 should succeed (no rate-limit triggered)
    const rateLimited = okMsgs.filter((m) => m[2] === false && String(m[3]).includes('rate-limited'));
    expect(rateLimited).toHaveLength(0);
    expect(okMsgs).toHaveLength(RATE_LIMIT_PER_SECOND);

    vi.useRealTimers();
  });
});

// ────────────────────────────────────────────────────────────────────
// Malformed input
// ────────────────────────────────────────────────────────────────────

describe('MiniRelay — malformed input', () => {
  it('should handle invalid JSON gracefully', async() => {
    const {relay, sent} = makeRelay();
    await relay.handleMessage('peer-1', 'not-json{{{');
    const notices = parseSent(sent, 'peer-1').filter((m) => m[0] === 'NOTICE');
    expect(notices).toHaveLength(1);
    expect(notices[0][1]).toMatch(/invalid JSON/i);
  });

  it('should handle non-array message', async() => {
    const {relay, sent} = makeRelay();
    await relay.handleMessage('peer-1', '"just a string"');
    const notices = parseSent(sent, 'peer-1').filter((m) => m[0] === 'NOTICE');
    expect(notices).toHaveLength(1);
  });

  it('should handle unknown command', async() => {
    const {relay, sent} = makeRelay();
    await relay.handleMessage('peer-1', JSON.stringify(['UNKNOWN_CMD', 'data']));
    const notices = parseSent(sent, 'peer-1').filter((m) => m[0] === 'NOTICE');
    expect(notices).toHaveLength(1);
    expect(notices[0][1]).toContain('unknown');
  });

  it('should handle empty array', async() => {
    const {relay, sent} = makeRelay();
    await relay.handleMessage('peer-1', '[]');
    const notices = parseSent(sent, 'peer-1').filter((m) => m[0] === 'NOTICE');
    expect(notices).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────────
// Forward immediate delivery (contact online)
// ────────────────────────────────────────────────────────────────────

describe('MiniRelay — forward immediate delivery', () => {
  it('should forward event immediately when target contact is connected', async() => {
    const {relay, store, sent} = makeRelay([PK_B]);

    // Connect bob as a peer
    await relay.onPeerConnected('peer-bob', PK_B);
    sent.length = 0;

    // Alice sends event with p-tag for bob
    const event = makeEvent({
      kind: 1059,
      pubkey: PK_A,
      tags: [['p', PK_B]]
    });
    await relay.handleMessage('peer-alice', JSON.stringify(['EVENT', event]));

    // peer-bob should receive the forwarded event immediately
    const bobMsgs = parseSent(sent, 'peer-bob').filter((m) => m[0] === 'EVENT');
    expect(bobMsgs).toHaveLength(1);
    expect(bobMsgs[0][2].id).toBe(event.id);

    // Forward queue should be empty (not enqueued since bob is online)
    const queue = await store.getForwardQueue(PK_B);
    expect(queue).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// CLOSE edge cases
// ────────────────────────────────────────────────────────────────────

describe('MiniRelay — CLOSE edge cases', () => {
  it('should handle closing non-existent subscription gracefully', async() => {
    const {relay, sent} = makeRelay();
    // CLOSE a subId that was never created — should not throw, no messages sent
    await relay.handleMessage('peer-1', JSON.stringify(['CLOSE', 'nonexistent-sub']));
    expect(sent).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
// updateContacts changes forwarding behavior
// ────────────────────────────────────────────────────────────────────

describe('MiniRelay — updateContacts', () => {
  it('should forward for newly added contacts', async() => {
    const {relay, store} = makeRelay([PK_A]); // only alice initially

    // Send event with p-tag for bob — should NOT enqueue (not a contact yet)
    const ev1 = makeEvent({kind: 1059, pubkey: PK_A, tags: [['p', PK_B]]});
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', ev1]));

    const queueBefore = await store.getForwardQueue(PK_B);
    expect(queueBefore).toHaveLength(0);

    // Add bob to contacts
    relay.updateContacts([PK_A, PK_B]);

    // Send another event with p-tag for bob — should now enqueue
    const ev2 = makeEvent({kind: 1059, pubkey: PK_A, tags: [['p', PK_B]]});
    await relay.handleMessage('peer-1', JSON.stringify(['EVENT', ev2]));

    const queueAfter = await store.getForwardQueue(PK_B);
    expect(queueAfter).toHaveLength(1);
    expect(queueAfter[0].eventId).toBe(ev2.id);
  });
});
