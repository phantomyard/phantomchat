/**
 * Regression tests for PhantomChatBridge.backfillPeerMappingsFromHistory.
 *
 * Bug: the Virtual MTProto send path resolves the recipient strictly from the
 * IndexedDB reverse-mapping. A peer we only ever *received* from — or any peer
 * after an identity reload — never had its mapping persisted, so sending
 * dropped silently at the `!peerPubkey` guard ("VMT returned no
 * phantomchatMid") while receiving kept working. The backfill rebuilds those
 * mappings from local message history on identity load.
 */

import '../setup';
import {PhantomChatBridge} from '../../lib/phantomchat/phantomchat-bridge';
import * as messageStoreModule from '../../lib/phantomchat/message-store';
import * as vdb from '../../lib/phantomchat/virtual-peers-db';

const OWN = 'a'.repeat(64);
const PEER1 = 'b'.repeat(64);
const PEER2 = 'c'.repeat(64);

/** conversationId is [pubkeyA, pubkeyB].sort().join(':') — match prod. */
function convId(a: string, b: string): string {
  return [a, b].sort().join(':');
}

describe('PhantomChatBridge.backfillPeerMappingsFromHistory', () => {
  let bridge: PhantomChatBridge;
  let storeMappingSpy: ReturnType<typeof vi.spyOn>;
  let getMessageStoreSpy: ReturnType<typeof vi.spyOn>;
  let conversationIds: string[];

  function mockStore() {
    getMessageStoreSpy = vi.spyOn(messageStoreModule, 'getMessageStore').mockReturnValue({
      getAllConversationIds: vi.fn().mockImplementation(async () => conversationIds)
    } as unknown as messageStoreModule.MessageStore);
  }

  beforeEach(() => {
    (PhantomChatBridge as unknown as {_instance: PhantomChatBridge | null})._instance = null;
    bridge = PhantomChatBridge.getInstance();
    (bridge as unknown as {pubkeyCache: Map<string, number>}).pubkeyCache.clear();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    storeMappingSpy = vi.spyOn(vdb, 'storeMapping').mockResolvedValue(undefined) as any;
    conversationIds = [];
    mockStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (PhantomChatBridge as unknown as {_instance: PhantomChatBridge | null})._instance = null;
  });

  it('persists a mapping for a peer we only ever received from', async () => {
    conversationIds = [convId(OWN, PEER1)];

    const restored = await bridge.backfillPeerMappingsFromHistory(OWN);

    expect(restored).toBe(1);
    expect(storeMappingSpy).toHaveBeenCalledTimes(1);
    expect(storeMappingSpy.mock.calls[0][0]).toBe(PEER1);
  });

  it('backfills every distinct peer across multiple conversations', async () => {
    conversationIds = [convId(OWN, PEER1), convId(OWN, PEER2)];

    const restored = await bridge.backfillPeerMappingsFromHistory(OWN);

    expect(restored).toBe(2);
    const persisted = storeMappingSpy.mock.calls.map((c) => c[0]).sort();
    expect(persisted).toEqual([PEER1, PEER2].sort());
  });

  it('never persists our own pubkey', async () => {
    conversationIds = [convId(OWN, PEER1)];

    await bridge.backfillPeerMappingsFromHistory(OWN);

    const persisted = storeMappingSpy.mock.calls.map((c) => c[0]);
    expect(persisted).not.toContain(OWN);
  });

  it('skips peers already present in the cache (no redundant writes)', async () => {
    conversationIds = [convId(OWN, PEER1)];
    // Simulate init() having pre-loaded this mapping from IndexedDB.
    (bridge as unknown as {pubkeyCache: Map<string, number>}).pubkeyCache.set(PEER1, 123456789);

    const restored = await bridge.backfillPeerMappingsFromHistory(OWN);

    expect(restored).toBe(0);
    expect(storeMappingSpy).not.toHaveBeenCalled();
  });

  it('skips group/non-1:1 conversation ids without throwing', async () => {
    // 32-hex group id (no colon) and a three-pubkey join must both be ignored.
    conversationIds = ['71859748a99f4707b32fb28868f5e097', [OWN, PEER1, PEER2].join(':')];

    const restored = await bridge.backfillPeerMappingsFromHistory(OWN);

    expect(restored).toBe(0);
    expect(storeMappingSpy).not.toHaveBeenCalled();
  });

  it('deduplicates a peer that appears in more than one conversation id', async () => {
    // Same peer should only be persisted once even if it shows up twice.
    conversationIds = [convId(OWN, PEER1), convId(OWN, PEER1)];

    const restored = await bridge.backfillPeerMappingsFromHistory(OWN);

    expect(restored).toBe(1);
    expect(storeMappingSpy).toHaveBeenCalledTimes(1);
  });

  it('continues past a single failing peer (best-effort)', async () => {
    conversationIds = [convId(OWN, PEER1), convId(OWN, PEER2)];
    // First storeMapping rejects, second succeeds.
    storeMappingSpy
      .mockRejectedValueOnce(new Error('idb write failed'))
      .mockResolvedValueOnce(undefined);

    const restored = await bridge.backfillPeerMappingsFromHistory(OWN);

    expect(restored).toBe(1);
    expect(storeMappingSpy).toHaveBeenCalledTimes(2);
  });

  it('returns 0 when there is no local history', async () => {
    conversationIds = [];

    const restored = await bridge.backfillPeerMappingsFromHistory(OWN);

    expect(restored).toBe(0);
    expect(storeMappingSpy).not.toHaveBeenCalled();
  });

  it('does not throw when the message store itself fails', async () => {
    getMessageStoreSpy.mockReturnValue({
      getAllConversationIds: vi.fn().mockRejectedValue(new Error('db open failed'))
    } as unknown as messageStoreModule.MessageStore);

    await expect(bridge.backfillPeerMappingsFromHistory(OWN)).resolves.toBe(0);
  });
});
