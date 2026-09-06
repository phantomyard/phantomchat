/**
 * Unit tests for the tombstone guard in storeMapping (PR #138).
 *
 * The guard is the resurrection fix's choke point: every automatic path
 * that re-persists peer mappings (contacts-sync apply, history backfill,
 * receive-path persistence, kind 0 upgrades) funnels through storeMapping,
 * so a tombstoned (deleted-contact) peer must never have its mapping
 * re-created there. Deliberate re-adds (addP2PContact) clear the tombstone
 * first; the strictly-newer-message revive path passes allowTombstoned.
 *
 * Also pins the atomic read-modify-write: a caller that re-stores an
 * existing mapping without a displayName must not wipe the stored name.
 */

import 'fake-indexeddb/auto';
import '../setup';
import {describe, it, expect, beforeAll} from 'vitest';

const OWN_PUBKEY = 'd'.repeat(64);
const PEER_PUBKEY = 'a'.repeat(64);
const PEER_PUBKEY_2 = 'b'.repeat(64);

let storeMapping: any;
let getMapping: any;
let getAllMappings: any;
let getMessageStore: any;

beforeAll(async() => {
  // The guard reads the runtime own-pubkey global (set by onboarding in the
  // real app). Provide a minimal window stub before importing the modules.
  (globalThis as any).window = {__phantomchatOwnPubkey: OWN_PUBKEY};

  const vpdb = await import('@lib/phantomchat/virtual-peers-db');
  storeMapping = vpdb.storeMapping;
  getMapping = vpdb.getMapping;
  getAllMappings = vpdb.getAllMappings;
  const ms = await import('@lib/phantomchat/message-store');
  getMessageStore = ms.getMessageStore;
});

describe('storeMapping tombstone guard', () => {
  it('refuses to re-create a mapping for a tombstoned peer', async() => {
    const mstore = getMessageStore();
    const convId = mstore.getConversationId(OWN_PUBKEY, PEER_PUBKEY);
    await mstore.setTombstone(convId, Math.floor(Date.now() / 1000));

    const result = await storeMapping(PEER_PUBKEY, 1000000000000001);
    // Suppressed writes report false so callers must not cache the mapping.
    expect(result).toBe(false);
    expect(await getMapping(PEER_PUBKEY)).toBeUndefined();
    expect(await getAllMappings()).toHaveLength(0);
  });

  it('still persists a normal new mapping', async() => {
    const result = await storeMapping(PEER_PUBKEY_2, 1000000000000002, 'Ghost Bot');
    expect(result).toBe(true);
    const mapping = await getMapping(PEER_PUBKEY_2);
    expect(mapping?.peerId).toBe(1000000000000002);
    expect(mapping?.displayName).toBe('Ghost Bot');
  });

  it('allowTombstoned revive path persists the mapping', async() => {
    const mstore = getMessageStore();
    const convId = mstore.getConversationId(OWN_PUBKEY, PEER_PUBKEY);
    await mstore.setTombstone(convId, Math.floor(Date.now() / 1000));

    const result = await storeMapping(PEER_PUBKEY, 1000000000000001, undefined, undefined, {allowTombstoned: true});
    expect(result).toBe(true);
    expect((await getMapping(PEER_PUBKEY))?.peerId).toBe(1000000000000001);
  });

  it('idempotent re-store without a name preserves the stored name (atomic RMW)', async() => {
    // The receive path stores (pubkey, peerId) on EVERY inbound message —
    // a blind put would wipe the display name. The read-modify-write now
    // happens inside a single transaction.
    await storeMapping(PEER_PUBKEY_2, 1000000000000002);
    const mapping = await getMapping(PEER_PUBKEY_2);
    expect(mapping?.displayName).toBe('Ghost Bot');
    expect(mapping?.addedAt).toBeDefined();
  });
});
