/**
 * nostra-read-receipts.ts
 *
 * Batch send read receipts for incoming messages when a peer's chat opens.
 * Queries message-store for the conversation, then calls chatAPI.markRead()
 * for each unseen incoming eventId.
 * Extracted from nostra-onboarding-integration.ts for testability.
 */

export interface ReadReceiptSender {
  /** Send read receipts for all unread incoming messages in a conversation */
  sendForPeer(numericPeerId: number): Promise<void>;
  /** Check if an eventId was already marked (for testing) */
  isMarked(eventId: string): boolean;
}

export function createReadReceiptSender(): ReadReceiptSender {
  const markedRead = new Set<string>();

  return {
    async sendForPeer(numericPeerId: number) {
      const ownPk = (window as any).__nostraOwnPubkey;
      if(!ownPk) return;
      const ca = (window as any).__nostraChatAPI;
      if(!ca || typeof ca.markRead !== 'function') return;

      const {getPubkey} = await import('@lib/nostra/virtual-peers-db');
      const peerPubkey = await getPubkey(numericPeerId);
      if(!peerPubkey) return;

      const {getMessageStore} = await import('@lib/nostra/message-store');
      const store = getMessageStore();
      const convId = store.getConversationId(ownPk, peerPubkey);
      const messages = await store.getMessages(convId, 50);

      for(const msg of messages) {
        if(msg.senderPubkey !== peerPubkey) continue;
        // Prefer the parsed app id so the sender's tracker matches (same key as delivery receipts).
        const receiptId = msg.appMessageId || msg.eventId;
        if(!receiptId || markedRead.has(receiptId)) continue;
        markedRead.add(receiptId);
        try {
          await ca.markRead(receiptId, peerPubkey);
        } catch{
          // non-critical
        }
      }
    },

    isMarked(eventId: string) {
      return markedRead.has(eventId);
    }
  };
}
