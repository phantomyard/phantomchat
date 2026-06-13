/**
 * Delivery Tracker Tests
 *
 * Tests for 4-state delivery tracking state machine, receipt event
 * creation/parsing, and read receipt privacy toggle.
 */

import {describe, it, expect, beforeEach, beforeAll, vi} from 'vitest';

// Mock rootScope
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: vi.fn()
  }
}));

// Mock nostr-crypto to avoid secp256k1 curve validation on fake keys
vi.mock('@lib/nostra/nostr-crypto', () => ({
  wrapNip17Receipt: vi.fn().mockReturnValue([{id: 'mock-wrap', kind: 1059, content: '', pubkey: '', created_at: 0, tags: [], sig: ''}])
}));

// ─── Dynamic module loading ───────────────────────────────────────
// Under isolate:false, rootScope and nostr-crypto mocks may be
// contaminated by other files. Use resetModules + doMock to ensure
// this file's mock factories are active.

let DeliveryTracker: any;
let DeliveryState: any;
let isReceiptEvent: any;
let parseReceipt: any;
let rootScope: any;

beforeAll(async() => {
  vi.resetModules();

  vi.doMock('@lib/rootScope', () => ({
    default: {
      dispatchEvent: vi.fn()
    }
  }));
  vi.doMock('@lib/nostra/nostr-crypto', () => ({
    wrapNip17Receipt: vi.fn().mockReturnValue([{id: 'mock-wrap', kind: 1059, content: '', pubkey: '', created_at: 0, tags: [], sig: ''}])
  }));

  const dtMod = await import('@lib/nostra/delivery-tracker');
  DeliveryTracker = dtMod.DeliveryTracker;
  isReceiptEvent = dtMod.isReceiptEvent;
  parseReceipt = dtMod.parseReceipt;

  const rsMod = await import('@lib/rootScope');
  rootScope = rsMod.default;
});

describe('DeliveryTracker', () => {
  let tracker: any;
  const mockPublishFn = vi.fn().mockResolvedValue(undefined);
  const fakePrivateKey = new Uint8Array(32).fill(1);
  const fakePublicKey = 'aaaa'.repeat(16); // 64-char hex

  beforeEach(() => {
    vi.clearAllMocks();
    // Clear localStorage mock
    if(typeof localStorage !== 'undefined') {
      localStorage.removeItem('nostra:read-receipts-enabled');
    }
    tracker = new DeliveryTracker({
      privateKey: fakePrivateKey,
      publicKey: fakePublicKey,
      publishFn: mockPublishFn
    });
  });

  // ─── State Transitions ──────────────────────────────────────────

  describe('state transitions', () => {
    it('should follow sending -> sent -> delivered -> read (no backwards)', () => {
      const eventId = 'evt-1';
      tracker.markSending(eventId);
      expect(tracker.getState(eventId)?.state).toBe('sending');

      tracker.markSent(eventId);
      expect(tracker.getState(eventId)?.state).toBe('sent');

      // Simulate delivery receipt
      tracker.handleReceipt({
        kind: 14,
        content: '',
        pubkey: 'sender123',
        created_at: Math.floor(Date.now() / 1000),
        tags: [['e', eventId], ['receipt-type', 'delivery']],
        id: 'receipt-1'
      });
      expect(tracker.getState(eventId)?.state).toBe('delivered');

      // Simulate read receipt
      tracker.handleReceipt({
        kind: 14,
        content: '',
        pubkey: 'sender123',
        created_at: Math.floor(Date.now() / 1000),
        tags: [['e', eventId], ['receipt-type', 'read']],
        id: 'receipt-2'
      });
      expect(tracker.getState(eventId)?.state).toBe('read');
    });

    it('should not transition backwards (delivered -> sent is no-op)', () => {
      const eventId = 'evt-2';
      tracker.markSending(eventId);
      tracker.markSent(eventId);

      // Force to delivered
      tracker.handleReceipt({
        kind: 14, content: '', pubkey: 'x', created_at: 0,
        tags: [['e', eventId], ['receipt-type', 'delivery']], id: 'r1'
      });
      expect(tracker.getState(eventId)?.state).toBe('delivered');

      // Try to go back to sent -- should remain delivered
      tracker.markSent(eventId);
      expect(tracker.getState(eventId)?.state).toBe('delivered');
    });
  });

  // ─── markSent ───────────────────────────────────────────────────

  describe('markSent', () => {
    it('should transition sending -> sent', () => {
      tracker.markSending('evt-3');
      tracker.markSent('evt-3');
      expect(tracker.getState('evt-3')?.state).toBe('sent');
      expect(tracker.getState('evt-3')?.sentAt).toBeDefined();
    });

    it('should emit nostra_delivery_update on markSent', () => {
      tracker.markSending('evt-4');
      tracker.markSent('evt-4');
      expect(rootScope.dispatchEvent).toHaveBeenCalledWith(
        'nostra_delivery_update',
        {eventId: 'evt-4', state: 'sent'}
      );
    });
  });

  // ─── handleDeliveryReceipt ──────────────────────────────────────

  describe('handleDeliveryReceipt', () => {
    it('should transition sent -> delivered', () => {
      tracker.markSending('evt-5');
      tracker.markSent('evt-5');
      tracker.handleReceipt({
        kind: 14, content: '', pubkey: 'x', created_at: 0,
        tags: [['e', 'evt-5'], ['receipt-type', 'delivery']], id: 'r2'
      });
      expect(tracker.getState('evt-5')?.state).toBe('delivered');
      expect(tracker.getState('evt-5')?.deliveredAt).toBeDefined();
    });
  });

  // ─── handleReadReceipt ──────────────────────────────────────────

  describe('handleReadReceipt', () => {
    it('should transition delivered -> read', () => {
      tracker.markSending('evt-6');
      tracker.markSent('evt-6');
      tracker.handleReceipt({
        kind: 14, content: '', pubkey: 'x', created_at: 0,
        tags: [['e', 'evt-6'], ['receipt-type', 'delivery']], id: 'r3'
      });
      tracker.handleReceipt({
        kind: 14, content: '', pubkey: 'x', created_at: 0,
        tags: [['e', 'evt-6'], ['receipt-type', 'read']], id: 'r4'
      });
      expect(tracker.getState('evt-6')?.state).toBe('read');
      expect(tracker.getState('evt-6')?.readAt).toBeDefined();
    });

    it('should be a no-op when readReceiptsEnabled=false', () => {
      tracker.setReadReceiptsEnabled(false);

      tracker.markSending('evt-7');
      tracker.markSent('evt-7');
      tracker.handleReceipt({
        kind: 14, content: '', pubkey: 'x', created_at: 0,
        tags: [['e', 'evt-7'], ['receipt-type', 'delivery']], id: 'r5'
      });
      // Now try read receipt -- should be ignored
      tracker.handleReceipt({
        kind: 14, content: '', pubkey: 'x', created_at: 0,
        tags: [['e', 'evt-7'], ['receipt-type', 'read']], id: 'r6'
      });
      expect(tracker.getState('evt-7')?.state).toBe('delivered');
    });
  });

  // ─── createDeliveryReceipt ──────────────────────────────────────

  describe('sendDeliveryReceipt', () => {
    it('should call publishFn with a gift-wrapped receipt event', async() => {
      await tracker.sendDeliveryReceipt('orig-evt-1', 'bbbb'.repeat(16));
      expect(mockPublishFn).toHaveBeenCalledTimes(1);
    });
  });

  // ─── createReadReceipt ──────────────────────────────────────────

  describe('sendReadReceipt', () => {
    it('should return without publishing when readReceiptsEnabled=false', async() => {
      tracker.setReadReceiptsEnabled(false);
      await tracker.sendReadReceipt('orig-evt-2', 'bbbb'.repeat(16));
      expect(mockPublishFn).not.toHaveBeenCalled();
    });

    it('should publish when readReceiptsEnabled=true', async() => {
      tracker.setReadReceiptsEnabled(true);
      await tracker.sendReadReceipt('orig-evt-3', 'bbbb'.repeat(16));
      expect(mockPublishFn).toHaveBeenCalledTimes(1);
    });
  });
});

// ─── Static Helpers ─────────────────────────────────────────────

describe('isReceiptEvent', () => {
  it('should return true for events with receipt-type tag', () => {
    const rumor = {
      kind: 14, content: '', pubkey: 'x', created_at: 0,
      tags: [['e', 'some-id'], ['receipt-type', 'delivery']], id: 'r'
    };
    expect(isReceiptEvent(rumor)).toBe(true);
  });

  it('should return false for regular messages (no infinite loops)', () => {
    const rumor = {
      kind: 14, content: 'hello', pubkey: 'x', created_at: 0,
      tags: [['p', 'recipient']], id: 'r'
    };
    expect(isReceiptEvent(rumor)).toBe(false);
  });
});

describe('parseReceipt', () => {
  it('should extract originalEventId and receiptType from tags', () => {
    const rumor = {
      kind: 14, content: '', pubkey: 'x', created_at: 0,
      tags: [['e', 'orig-123'], ['receipt-type', 'read']], id: 'r'
    };
    const result = parseReceipt(rumor);
    expect(result).toEqual({originalEventId: 'orig-123', receiptType: 'read'});
  });

  it('should return null for non-receipt events', () => {
    const rumor = {
      kind: 14, content: 'hello', pubkey: 'x', created_at: 0,
      tags: [['p', 'someone']], id: 'r'
    };
    expect(parseReceipt(rumor)).toBeNull();
  });
});
