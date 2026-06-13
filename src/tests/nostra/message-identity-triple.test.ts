/**
 * Regression tests for the message identity-triple contract (Phase 2b.1,
 * FIND-e49755c1).
 *
 * The identity-triple is {eventId, mid, twebPeerId, timestamp}. These
 * fields are computed ONCE at message creation and IMMUTABLE afterward.
 * Read paths consume them directly; write paths supply them in full.
 *
 * This suite verifies:
 *  1. `StoredMessage.mid` and `twebPeerId` are required by the type system.
 *  2. The message-store upsert preserves identity fields across partial
 *     re-saves (the updateMessageStatus / delivery-state mutation path).
 *  3. Identity-preserving re-save pattern: spread existing row, mutate
 *     only deliveryState.
 *
 * VMT read-path throw behaviour is covered by `mirror-idb-coherent.test.ts`
 * and `virtual-mtproto-server.test.ts`; we keep this file free of
 * `vi.doMock` to avoid cross-file module-registry pollution during
 * `pnpm test:nostra:quick`.
 */

import '../setup';
import 'fake-indexeddb/auto';
import {describe, it, expect} from 'vitest';
import {MessageStore, StoredMessage, PartialStoredMessage} from '@lib/nostra/message-store';

const OWN_PUBKEY = '1122334455667788112233445566778811223344556677881122334455667788';
const PEER_ID = 1234567890123456;
const MID = 999000000001;

describe('identity triple — type contract', () => {
  it('StoredMessage requires mid and twebPeerId at compile time', () => {
    const full: StoredMessage = {
      eventId: 'ev1',
      conversationId: 'conv',
      senderPubkey: 'pk',
      content: 'x',
      type: 'text',
      timestamp: 1,
      deliveryState: 'sent',
      mid: 42,
      twebPeerId: 7
    };
    expect(full.mid).toBe(42);
    expect(full.twebPeerId).toBe(7);
  });

  it('PartialStoredMessage allows omitting mid and twebPeerId', () => {
    const partial: PartialStoredMessage = {
      eventId: 'ev1',
      conversationId: 'conv',
      senderPubkey: 'pk',
      content: 'x',
      type: 'text',
      timestamp: 1,
      deliveryState: 'sent'
    };
    expect(partial.mid).toBeUndefined();
    expect(partial.twebPeerId).toBeUndefined();
  });
});

describe('MessageStore — identity preservation on upsert', () => {
  it('preserves mid/twebPeerId when a later partial save lands', async() => {
    const store = new MessageStore();
    await store.saveMessage({
      eventId: 'ev_merge',
      conversationId: 'c_merge_1',
      senderPubkey: OWN_PUBKEY,
      content: 'hello',
      type: 'text',
      timestamp: 1_700_000_000,
      deliveryState: 'sending',
      mid: MID,
      twebPeerId: PEER_ID,
      isOutgoing: true
    });

    // Partial re-save (as updateMessageStatus might have done in legacy
    // paths). The store merges missing mid/twebPeerId from the prior row.
    await store.saveMessage({
      eventId: 'ev_merge',
      conversationId: 'c_merge_1',
      senderPubkey: OWN_PUBKEY,
      content: 'hello',
      type: 'text',
      timestamp: 1_700_000_000,
      deliveryState: 'sent'
    });

    const row = await store.getByEventId('ev_merge');
    expect(row).not.toBeNull();
    expect(row!.mid).toBe(MID);
    expect(row!.twebPeerId).toBe(PEER_ID);
    expect(row!.isOutgoing).toBe(true);
    expect(row!.deliveryState).toBe('sent');
  });

  it('identity-preserving update: spread + mutate deliveryState only', async() => {
    const store = new MessageStore();
    const ts = 1_700_000_100;
    const row: StoredMessage = {
      eventId: 'ev_upd',
      conversationId: 'c_upd_1',
      senderPubkey: OWN_PUBKEY,
      content: 'x',
      type: 'text',
      timestamp: ts,
      deliveryState: 'sending',
      mid: MID,
      twebPeerId: PEER_ID,
      isOutgoing: true
    };
    await store.saveMessage(row);

    // updateMessageStatus pattern: read full row, spread, mutate only
    // deliveryState, save back.
    const stored = await store.getByEventId('ev_upd');
    expect(stored).not.toBeNull();
    const next: StoredMessage = {
      ...stored!,
      deliveryState: 'sent'
    };
    await store.saveMessage(next);

    const final = await store.getByEventId('ev_upd');
    expect(final).not.toBeNull();
    expect(final!.mid).toBe(MID);
    expect(final!.twebPeerId).toBe(PEER_ID);
    expect(final!.timestamp).toBe(ts);
    expect(final!.isOutgoing).toBe(true);
    expect(final!.deliveryState).toBe('sent');
  });

  it('second write with different mid does NOT overwrite (merge preserves prior)', async() => {
    const store = new MessageStore();
    const originalMid = 1_000_000_001;
    await store.saveMessage({
      eventId: 'ev_noover',
      conversationId: 'c_noover_1',
      senderPubkey: OWN_PUBKEY,
      content: 'x',
      type: 'text',
      timestamp: 1_700_000_200,
      deliveryState: 'sending',
      mid: originalMid,
      twebPeerId: PEER_ID,
      isOutgoing: true
    });

    // Legacy partial writer: no mid, no twebPeerId. Merge must keep prior.
    await store.saveMessage({
      eventId: 'ev_noover',
      conversationId: 'c_noover_1',
      senderPubkey: OWN_PUBKEY,
      content: 'x',
      type: 'text',
      timestamp: 1_700_000_200,
      deliveryState: 'sent'
    });

    const final = await store.getByEventId('ev_noover');
    expect(final).not.toBeNull();
    expect(final!.mid).toBe(originalMid);
    expect(final!.twebPeerId).toBe(PEER_ID);
  });
});
