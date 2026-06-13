/**
 * Tests for nostra-pending-flush.ts
 *
 * Verifies: enqueue/flush, history_append dispatch, periodic flush,
 * and cleanup after flush.
 */

import '../setup';
import {describe, it, expect, beforeEach, vi, afterEach} from 'vitest';

// Mock rootScope
const mockDispatchEvent = vi.fn();
vi.mock('@lib/rootScope', () => ({
  default: {
    dispatchEvent: (...args: any[]) => mockDispatchEvent(...args)
  }
}));

// Mock MOUNT_CLASS_TO — no active chat by default
let mockChat: any = null;
vi.mock('@config/debug', () => ({
  MOUNT_CLASS_TO: {
    get appImManager() {
      return mockChat ? {chat: mockChat, addEventListener: vi.fn()} : undefined;
    }
  }
}));

import {createPendingFlush} from '@lib/nostra/nostra-pending-flush';

const PEER_ID = 1000000000000001;
const makeMsg = (mid: number) => ({mid, id: mid, date: 1712345678, message: 'test'});

describe('nostra-pending-flush', () => {
  let manager: ReturnType<typeof createPendingFlush>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockChat = null;
    manager = createPendingFlush();
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  describe('enqueue', () => {
    it('stores messages for a peer', () => {
      manager.enqueue(PEER_ID, makeMsg(1));
      manager.enqueue(PEER_ID, makeMsg(2));
      expect(manager.getPendingCount(PEER_ID)).toBe(2);
    });

    it('returns 0 for unknown peer', () => {
      expect(manager.getPendingCount(999)).toBe(0);
    });
  });

  describe('flush', () => {
    it('dispatches history_append for each pending message', () => {
      manager.enqueue(PEER_ID, makeMsg(1));
      manager.enqueue(PEER_ID, makeMsg(2));
      manager.flush(PEER_ID);

      expect(mockDispatchEvent).toHaveBeenCalledTimes(2);
      expect(mockDispatchEvent).toHaveBeenCalledWith(
        'history_append',
        expect.objectContaining({peerId: PEER_ID})
      );
    });

    it('no-ops if no pending messages', () => {
      manager.flush(PEER_ID);
      expect(mockDispatchEvent).not.toHaveBeenCalled();
    });

    it('clears pending when chat is active for that peer', () => {
      mockChat = {peerId: PEER_ID};
      manager.enqueue(PEER_ID, makeMsg(1));
      manager.flush(PEER_ID);
      expect(manager.getPendingCount(PEER_ID)).toBe(0);
    });

    it('keeps pending when chat is not active for that peer', () => {
      mockChat = {peerId: 999999};
      manager.enqueue(PEER_ID, makeMsg(1));
      manager.flush(PEER_ID);
      // Still has pending because different chat is active
      expect(manager.getPendingCount(PEER_ID)).toBe(1);
    });
  });

  describe('startPeriodicFlush', () => {
    it('flushes matching peer on interval', () => {
      mockChat = {peerId: PEER_ID};
      manager.enqueue(PEER_ID, makeMsg(1));
      manager.startPeriodicFlush();

      vi.advanceTimersByTime(1000);
      expect(mockDispatchEvent).toHaveBeenCalledWith(
        'history_append',
        expect.objectContaining({peerId: PEER_ID})
      );
    });
  });

  describe('destroy', () => {
    it('clears all pending messages', () => {
      manager.enqueue(PEER_ID, makeMsg(1));
      manager.destroy();
      expect(manager.getPendingCount(PEER_ID)).toBe(0);
    });
  });
});
