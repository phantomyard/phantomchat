/**
 * PhantomChatSync
 *
 * Listens to incoming messages from ChatAPI and persists them to the
 * message store, then dispatches events for real-time rendering.
 */

import {PhantomChatPeerMapper} from './phantomchat-peer-mapper';
import {getMessageStore, StoredMessage} from './message-store';
import type {ChatMessage} from './chat-api';
import type {IncomingEdit} from './chat-api-receive';

const LOG_PREFIX = '[PhantomChatSync]';

type DispatchFn = (event: string, data: any) => void;

export class PhantomChatSync {
  private ownPubkey: string;
  private dispatch: DispatchFn;
  private mapper: PhantomChatPeerMapper;

  constructor(ownPubkey: string, dispatch: DispatchFn) {
    this.ownPubkey = ownPubkey;
    this.dispatch = dispatch;
    this.mapper = new PhantomChatPeerMapper();
  }

  /**
   * Called when ChatAPI receives an incoming message.
   * Persists to message store and dispatches phantomchat_new_message event.
   *
   * IMPORTANT: We use `msg.relayEventId` (rumor hex id) as the canonical
   * storage key, NOT `msg.id` (which is `chat-XXX-N` parsed from the content
   * JSON). chat-api-receive already stored the message with `eventId = rumor id`,
   * so we must use the same eventId to hit the upsert path instead of creating
   * a duplicate row that would produce two bubbles with different mids.
   */
  async onIncomingMessage(msg: ChatMessage, senderPubkey: string): Promise<void> {
    // Self-echo: our OWN message arriving back via the NIP-17 self-wrap (the
    // multi-device sync copy). chat-api-receive's handleSelfEcho has ALREADY
    // persisted this as an OUTGOING row keyed by the rumor id, so we must NOT
    // re-persist it here. Doing so wrote an isOutgoing:false row in a self↔self
    // conversation (own↔own) keyed by the rumor id — a phantom duplicate that
    // (a) was never the visible bubble and (b) is exactly the row a delivery
    // receipt resolves to (receipts reference the rumor id), so the delivered
    // tick landed on a bogus incoming row and the real bubble stayed ✓.
    // We still dispatch a render event (keyed to the REAL peer = msg.to) so a
    // genuine cross-device echo paints live; the row itself is owned by
    // handleSelfEcho. FIND-selfwrap-dup.
    const isSelfEcho = senderPubkey === this.ownPubkey;
    const renderPubkey = isSelfEcho ? (msg.to || senderPubkey) : senderPubkey;
    const peerId = await this.mapper.mapPubkey(renderPubkey);
    const storageEventId = msg.relayEventId || msg.id;
    const mid = await this.mapper.mapEventId(storageEventId, Math.floor(msg.timestamp));
    // msg.timestamp is already in UNIX seconds (from rumor.created_at)
    const timestamp = Math.floor(msg.timestamp);

    if(!isSelfEcho) {
      const store = getMessageStore();
      const conversationId = store.getConversationId(this.ownPubkey, senderPubkey);

      await store.saveMessage({
        eventId: storageEventId,
        appMessageId: msg.id,
        conversationId,
        senderPubkey,
        content: msg.content,
        type: msg.type === 'text' ? 'text' : 'file',
        timestamp,
        deliveryState: 'delivered',
        mid,
        twebPeerId: peerId,
        isOutgoing: false,
        ...(msg.fileMetadata ? {fileMetadata: msg.fileMetadata} : {})
      });
    }

    // Sync-before-render barrier: for a genuine incoming message, if one of our
    // OWN devices is live, do a recent-only catch-up from it and BLOCK on it before
    // painting — so the new bubble lands on top of an up-to-date tail (and any media
    // a sibling already holds), never above a gap. No-op / non-blocking when no
    // sibling is live. Guarded so a sync failure can never swallow the render.
    if(!isSelfEcho) {
      try {
        const {syncRecentBeforeRender} = await import('./phantomchat-device-sync');
        await syncRecentBeforeRender(senderPubkey);
      } catch(err) {
        console.debug(LOG_PREFIX, 'syncRecentBeforeRender skipped:', (err as Error)?.message);
      }
    }

    console.log(LOG_PREFIX, 'dispatching phantomchat_new_message', {peerId, mid, selfEcho: isSelfEcho});
    this.dispatch('phantomchat_new_message', {peerId, mid, senderPubkey, message: msg, timestamp});
  }

  /**
   * Called when ChatAPI receives an incoming edit (a rumor carrying the
   * 'phantomchat-edit' marker tag). The message-store row has already been
   * updated by chat-api-receive; here we resolve peerId/mid and dispatch
   * the rootScope event so the UI re-renders the bubble.
   */
  async onIncomingEdit(edit: IncomingEdit): Promise<void> {
    const peerId = await this.mapper.mapPubkey(edit.senderPubkey);
    const store = getMessageStore();
    let original: StoredMessage | null = null;
    try {
      original = await store.getByAppMessageId(edit.originalAppMessageId);
    } catch{
      original = null;
    }
    const mid = original?.mid;
    if(!mid) {
      console.log(LOG_PREFIX, 'edit has no resolvable mid; skipping dispatch', edit.originalAppMessageId);
      return;
    }

    console.log(LOG_PREFIX, 'dispatching phantomchat_message_edit', {peerId, mid});
    this.dispatch('phantomchat_message_edit', {
      peerId,
      mid,
      senderPubkey: edit.senderPubkey,
      originalEventId: edit.originalAppMessageId,
      newContent: edit.newContent,
      editedAt: edit.editedAt
    });
  }

  /**
   * Called when a kind 0 profile is fetched or updated.
   * Dispatches phantomchat_profile_update event.
   */
  async onProfileUpdate(pubkey: string, profile: {name?: string, display_name?: string, about?: string, picture?: string}): Promise<void> {
    const peerId = await this.mapper.mapPubkey(pubkey);
    const displayName = profile.display_name || profile.name;

    console.log(LOG_PREFIX, 'dispatching phantomchat_profile_update', {peerId, pubkey});
    this.dispatch('phantomchat_profile_update', {peerId, pubkey, displayName, about: profile.about, picture: profile.picture});
  }
}
