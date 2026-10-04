import {describe, expect, it, vi} from 'vitest';
import {createConversationResidueWipe} from '@lib/phantomchat/contacts-residue-wipe';

const OWN = 'own'.repeat(8);
const PEER = 'peer'.repeat(8);
const CONV_ID = `p2p:${OWN}:${PEER}`;

function makeHarness(messages: unknown[]) {
  const getMessages = vi.fn().mockResolvedValue(messages);
  const deleteMessages = vi.fn().mockResolvedValue(undefined);
  const dispatchEvent = vi.fn();
  const loadRootScope = vi.fn().mockResolvedValue({dispatchEvent});
  const log = vi.fn();
  const wipe = createConversationResidueWipe({
    ownPubkey: OWN,
    getConversationId: () => CONV_ID,
    getMessages,
    deleteMessages,
    loadRootScope,
    log
  });
  return {wipe, getMessages, deleteMessages, dispatchEvent, loadRootScope, log};
}

describe('createConversationResidueWipe (#198 / #199 review)', () => {
  it('deletes the rows AND dispatches conversation_deleted when residue exists', async() => {
    const h = makeHarness([{eventId: 'seed-1', conversationId: CONV_ID}]);
    await h.wipe(PEER);
    expect(h.deleteMessages).toHaveBeenCalledWith(CONV_ID);
    expect(h.dispatchEvent).toHaveBeenCalledWith('phantomchat_conversation_deleted', {peerPubkey: PEER, conversationId: CONV_ID});
    expect(h.log).toHaveBeenCalled();
  });

  it('zero-message regression (Kai review 2026-10-04): dispatches conversation_deleted even when the message store is EMPTY — the persisted tweb dialog row is repaired by the event alone', async() => {
    const h = makeHarness([]);
    await h.wipe(PEER);
    expect(h.deleteMessages).not.toHaveBeenCalled(); // conditional: nothing to delete
    expect(h.dispatchEvent).toHaveBeenCalledWith('phantomchat_conversation_deleted', {peerPubkey: PEER, conversationId: CONV_ID});
    expect(h.log).not.toHaveBeenCalled();
  });

  it('is idempotent across repeated wipes (durable delete re-derived every pass)', async() => {
    const h = makeHarness([]);
    await h.wipe(PEER);
    await h.wipe(PEER);
    expect(h.dispatchEvent).toHaveBeenCalledTimes(2);
    expect(h.deleteMessages).not.toHaveBeenCalled();
  });
});
