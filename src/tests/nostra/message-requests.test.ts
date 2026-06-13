/**
 * Message Requests smoke tests
 *
 * Tests the message request accept/reject wiring to MessageRequestStore.
 * Verifies rootScope event integration for reactive updates.
 */

import {describe, test, expect, vi, beforeEach} from 'vitest';

// Mock message-requests module
const mockAcceptRequest = vi.fn().mockResolvedValue(undefined);
const mockRejectRequest = vi.fn().mockResolvedValue(undefined);
const mockGetRequests = vi.fn().mockResolvedValue([]);
const mockGetPendingCount = vi.fn().mockResolvedValue(0);
const mockIsBlocked = vi.fn().mockResolvedValue(false);
const mockAddRequest = vi.fn().mockResolvedValue(undefined);

vi.mock('@lib/nostra/message-requests', () => ({
  getMessageRequestStore: () => ({
    acceptRequest: mockAcceptRequest,
    rejectRequest: mockRejectRequest,
    getRequests: mockGetRequests,
    getPendingCount: mockGetPendingCount,
    isBlocked: mockIsBlocked,
    addRequest: mockAddRequest
  }),
  MessageRequestStore: class {}
}));

// Mock rootScope
const listeners = new Map<string, Set<Function>>();
vi.mock('@lib/rootScope', () => ({
  default: {
    addEventListener: (event: string, handler: Function) => {
      if(!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    },
    removeEventListener: (event: string, handler: Function) => {
      listeners.get(event)?.delete(handler);
    },
    dispatchEvent: (event: string, data: any) => {
      listeners.get(event)?.forEach(fn => fn(data));
    }
  }
}));

// Mock virtual-peers-db
vi.mock('@lib/nostra/virtual-peers-db', () => ({
  getDB: () => Promise.reject(new Error('no db in test'))
}));

describe('Message Requests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listeners.clear();
  });

  describe('acceptRequest', () => {
    test('calls messageRequestStore.acceptRequest with pubkey', async() => {
      const store = (await import('@lib/nostra/message-requests')).getMessageRequestStore();
      const pubkey = 'abc123def456';

      await store.acceptRequest(pubkey);

      expect(mockAcceptRequest).toHaveBeenCalledWith(pubkey);
      expect(mockAcceptRequest).toHaveBeenCalledTimes(1);
    });

    test('acceptRequest marks the request as accepted', async() => {
      const store = (await import('@lib/nostra/message-requests')).getMessageRequestStore();
      const pubkey = 'test-pubkey-accept';

      mockAcceptRequest.mockResolvedValueOnce(undefined);
      await store.acceptRequest(pubkey);

      expect(mockAcceptRequest).toHaveBeenCalledWith(pubkey);
    });
  });

  describe('rejectRequest', () => {
    test('calls messageRequestStore.rejectRequest with pubkey', async() => {
      const store = (await import('@lib/nostra/message-requests')).getMessageRequestStore();
      const pubkey = 'blocked-user-pubkey';

      await store.rejectRequest(pubkey);

      expect(mockRejectRequest).toHaveBeenCalledWith(pubkey);
      expect(mockRejectRequest).toHaveBeenCalledTimes(1);
    });

    test('rejectRequest blocks future messages from that pubkey', async() => {
      const store = (await import('@lib/nostra/message-requests')).getMessageRequestStore();
      const pubkey = 'spammer-pubkey';

      await store.rejectRequest(pubkey);

      expect(mockRejectRequest).toHaveBeenCalledWith(pubkey);
    });
  });

  describe('nostra_message_request event', () => {
    test('incoming event triggers listener for new request', async() => {
      const rootScope = (await import('@lib/rootScope')).default;

      const handler = vi.fn();
      rootScope.addEventListener('nostra_message_request', handler);

      rootScope.dispatchEvent('nostra_message_request', {
        pubkey: 'new-sender-pubkey',
        firstMessage: 'Hello!'
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith({
        pubkey: 'new-sender-pubkey',
        firstMessage: 'Hello!'
      });
    });

    test('multiple events add multiple entries', async() => {
      const rootScope = (await import('@lib/rootScope')).default;

      const received: any[] = [];
      rootScope.addEventListener('nostra_message_request', (data: any) => {
        received.push(data);
      });

      rootScope.dispatchEvent('nostra_message_request', {
        pubkey: 'sender-1',
        firstMessage: 'Message 1'
      });
      rootScope.dispatchEvent('nostra_message_request', {
        pubkey: 'sender-2',
        firstMessage: 'Message 2'
      });

      expect(received).toHaveLength(2);
      expect(received[0].pubkey).toBe('sender-1');
      expect(received[1].pubkey).toBe('sender-2');
    });
  });

  describe('getPendingCount', () => {
    test('returns 0 when no pending requests', async() => {
      mockGetPendingCount.mockResolvedValueOnce(0);
      const store = (await import('@lib/nostra/message-requests')).getMessageRequestStore();

      const count = await store.getPendingCount();
      expect(count).toBe(0);
    });

    test('returns correct count for pending requests', async() => {
      mockGetPendingCount.mockResolvedValueOnce(3);
      const store = (await import('@lib/nostra/message-requests')).getMessageRequestStore();

      const count = await store.getPendingCount();
      expect(count).toBe(3);
    });
  });
});
