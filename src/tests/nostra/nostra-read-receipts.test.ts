/**
 * Tests for nostra-read-receipts.ts
 *
 * Verifies: batch markRead, dedup via markedRead Set, skip conditions.
 */

import '../setup';
import {describe, it, expect, beforeEach, vi} from 'vitest';

const mockMarkRead = vi.fn().mockResolvedValue(undefined);
const mockGetPubkey = vi.fn().mockResolvedValue('bbbb'.repeat(16));
const mockGetMessages = vi.fn().mockResolvedValue([]);

vi.mock('@lib/nostra/virtual-peers-db', () => ({
  getPubkey: (...args: any[]) => mockGetPubkey(...args)
}));

vi.mock('@lib/nostra/message-store', () => ({
  getMessageStore: () => ({
    getConversationId: vi.fn().mockReturnValue('aaa:bbb'),
    getMessages: (...args: any[]) => mockGetMessages(...args)
  })
}));

import {createReadReceiptSender} from '@lib/nostra/nostra-read-receipts';

const OWN_PUBKEY = 'aaaa'.repeat(16);
const PEER_PUBKEY = 'bbbb'.repeat(16);
const PEER_ID = 1000000000000001;

describe('nostra-read-receipts', () => {
  let sender: ReturnType<typeof createReadReceiptSender>;

  beforeEach(() => {
    vi.clearAllMocks();
    sender = createReadReceiptSender();
    // Set up window globals
    (window as any).__nostraOwnPubkey = OWN_PUBKEY;
    (window as any).__nostraChatAPI = {markRead: mockMarkRead};
  });

  it('sends read receipts for incoming messages', async() => {
    mockGetMessages.mockResolvedValueOnce([
      {senderPubkey: PEER_PUBKEY, eventId: 'evt-1'},
      {senderPubkey: PEER_PUBKEY, eventId: 'evt-2'},
      {senderPubkey: OWN_PUBKEY, eventId: 'evt-3'} // own msg, should skip
    ]);

    await sender.sendForPeer(PEER_ID);

    expect(mockMarkRead).toHaveBeenCalledTimes(2);
    expect(mockMarkRead).toHaveBeenCalledWith('evt-1', PEER_PUBKEY);
    expect(mockMarkRead).toHaveBeenCalledWith('evt-2', PEER_PUBKEY);
  });

  it('deduplicates — does not re-send for same eventId', async() => {
    mockGetMessages.mockResolvedValue([
      {senderPubkey: PEER_PUBKEY, eventId: 'evt-1'}
    ]);

    await sender.sendForPeer(PEER_ID);
    await sender.sendForPeer(PEER_ID);

    expect(mockMarkRead).toHaveBeenCalledTimes(1);
    expect(sender.isMarked('evt-1')).toBe(true);
  });

  it('skips if no own pubkey', async() => {
    (window as any).__nostraOwnPubkey = undefined;
    await sender.sendForPeer(PEER_ID);
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it('skips if no chatAPI', async() => {
    (window as any).__nostraChatAPI = undefined;
    await sender.sendForPeer(PEER_ID);
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it('skips if peer pubkey not found', async() => {
    mockGetPubkey.mockResolvedValueOnce(undefined);
    await sender.sendForPeer(PEER_ID);
    expect(mockMarkRead).not.toHaveBeenCalled();
  });

  it('skips messages without eventId', async() => {
    mockGetMessages.mockResolvedValueOnce([
      {senderPubkey: PEER_PUBKEY, eventId: undefined}
    ]);
    await sender.sendForPeer(PEER_ID);
    expect(mockMarkRead).not.toHaveBeenCalled();
  });
});
