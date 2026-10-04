/**
 * (#198 / #199 review) Conversation-residue wipe for durably-deleted peers.
 *
 * A delete learned from contacts sync used to tear down the mapping but leave
 * the message-store rows (including the contact-init seed) that DERIVE the
 * contact + dialog, so the deleted chat stayed on screen forever. This wipe
 * is called on every durable-log delete, idempotently.
 *
 * Kai review (2026-10-04): do NOT return early when the message store is
 * already empty — the artifact being repaired can be the independently
 * persisted tweb dialog row itself. In that state getMessages(...) is empty
 * but the dead chat still renders: the dialog-drop event must fire for EVERY
 * durable delete. deleteMessages may be conditional (it is a no-op when
 * there is nothing to delete), the dispatch may not.
 */
export interface ConversationResidueWipeDeps {
  ownPubkey: string;
  getConversationId: (ownPubkey: string, peerPubkey: string) => string;
  getMessages: (conversationId: string, limit: number) => Promise<unknown[]>;
  deleteMessages: (conversationId: string) => Promise<void>;
  loadRootScope: () => Promise<any>;
  log?: (...args: unknown[]) => void;
}

export function createConversationResidueWipe(deps: ConversationResidueWipeDeps) {
  return async(pubkey: string): Promise<void> => {
    const convId = deps.getConversationId(deps.ownPubkey, pubkey);
    const residue = await deps.getMessages(convId, 1);
    if(residue?.length) {
      await deps.deleteMessages(convId);
    }
    // Unconditional: even a zero-message conversation can still have a
    // persisted dialog row that only the conversation_deleted event drops.
    const rs: any = await deps.loadRootScope();
    rs?.dispatchEvent?.('phantomchat_conversation_deleted', {peerPubkey: pubkey, conversationId: convId});
    if(residue?.length) {
      deps.log?.('[contacts-sync] wiped conversation residue for durably-deleted peer', pubkey.slice(0, 8));
    }
  };
}
