/**
 * phantomchat-delivery-ui.ts
 *
 * Handles delivery status UI updates (sent → delivered → read) on message bubbles.
 * Listens to phantomchat_delivery_update events and updates bubble DOM + icons.
 * Extracted from phantomchat-onboarding-integration.ts for testability.
 */

import {MOUNT_CLASS_TO} from '@config/debug';
import rootScope from '@lib/rootScope';

export interface DeliveryUIManager {
  /** Start listening for delivery updates */
  attach(): void;
}

/**
 * Apply delivery state to a bubble element.
 * Returns true if the bubble was found and updated.
 *
 * State → icon mapping (matches Telegram UX):
 *   sent       → single check (clock removed; relay accepted)
 *   delivered  → double checks (peer's client confirmed receipt)
 *   read       → double checks + is-p2p-read class for blue tint
 *
 * Without the 'sent' transition the bubble was stuck on the clock spinner
 * whenever a delivery receipt was delayed or lost (slow network, peer
 * offline) — even though the relay had accepted the publish. FIND-9fa52e43.
 */
export async function applyBubbleState(mid: string, state: 'sent' | 'delivered' | 'read'): Promise<boolean> {
  const bubble = document.querySelector<HTMLElement>(`.bubble[data-mid="${CSS.escape(mid)}"]`);
  if(!bubble) return false;

  // Don't downgrade — once a bubble has been marked read/delivered, a late
  // 'sent' echo from a slow second-relay must not flip the icon backwards.
  if(state === 'sent' && (bubble.classList.contains('is-read') || bubble.classList.contains('is-p2p-read'))) {
    return true;
  }

  bubble.classList.remove('is-sending', 'is-error');
  if(state === 'sent') {
    bubble.classList.remove('is-read');
    bubble.classList.add('is-sent');
  } else {
    bubble.classList.remove('is-sent');
    bubble.classList.add('is-read');
    if(state === 'read') bubble.classList.add('is-p2p-read');
  }

  const Icon = (await import('@components/icon')).default;
  const iconName = state === 'sent' ? 'check' : 'checks';
  bubble.querySelectorAll<HTMLElement>('.time, .time-inner').forEach((element) => {
    const existing = element.querySelector('.time-sending-status');
    const newIcon = Icon(iconName as any, 'time-sending-status');
    if(existing) existing.replaceWith(newIcon);
    else element.prepend(newIcon);
  });
  return true;
}

/**
 * Refresh the chat list preview after a sent message.
 * Worker's send shortcut returns emptyUpdates, so tweb never triggers
 * the normal updateNewMessage → dialog_update flow.
 */
async function refreshDialogPreview(numericPeerId: number): Promise<void> {
  const {PhantomChatPeerMapper} = await import('@lib/phantomchat/phantomchat-peer-mapper');
  const mapper = new PhantomChatPeerMapper();
  const {getMessageStore} = await import('@lib/phantomchat/message-store');
  const store = getMessageStore();
  const ownPk = (window as any).__phantomchatOwnPubkey;
  const {getPubkey} = await import('@lib/phantomchat/virtual-peers-db');
  const peerPk = await getPubkey(numericPeerId);
  if(!ownPk || !peerPk) return;

  const convId = store.getConversationId(ownPk, peerPk);
  const latest = (await store.getMessages(convId, 1))[0];
  if(!latest) return;

  // Identity-triple contract: `latest.mid` is authoritative. Bail out if
  // missing rather than spawn a ghost mid with a stale-timestamp hash
  // (root cause of FIND-e49755c1 residual).
  if(latest.mid == null) {
    console.error('[PhantomChatDeliveryUI] refreshDialogPreview: stored message missing mid — upstream write path is broken', {eventId: latest.eventId, timestamp: latest.timestamp});
    return;
  }
  const mid = latest.mid;
  const isOut = latest.isOutgoing ?? (latest.senderPubkey === ownPk);
  const msg = mapper.createTwebMessage({
    mid,
    peerId: numericPeerId,
    fromPeerId: isOut ? undefined : numericPeerId,
    date: latest.timestamp,
    text: latest.content,
    isOutgoing: isOut
  });

  const proxy = MOUNT_CLASS_TO.apiManagerProxy;
  if(proxy?.mirrors?.messages) {
    const storageKey = `${numericPeerId}_history`;
    if(!proxy.mirrors.messages[storageKey]) proxy.mirrors.messages[storageKey] = {};
    proxy.mirrors.messages[storageKey][mid] = msg;
  }

  const dialog = mapper.createTwebDialog({
    peerId: numericPeerId,
    topMessage: mid,
    topMessageDate: latest.timestamp,
    unreadCount: 0
  });
  const dispatchFn = () => rootScope.dispatchEvent('dialogs_multiupdate' as any, new Map([[
    (numericPeerId as any).toPeerId ? (numericPeerId as any).toPeerId(false) : numericPeerId,
    {dialog}
  ]]));
  dispatchFn();
  setTimeout(dispatchFn, 300);
}

export function createDeliveryUI(): DeliveryUIManager {
  // Map from tracker eventId (chat-XXX-N) to the bubble's data-mid.
  const eventIdToBubbleMid = new Map<string, string>();

  const handleSent = async(eventId: string) => {
    const tracked = new Set(eventIdToBubbleMid.values());
    const captureLatest = () => {
      const bubbles = document.querySelectorAll<HTMLElement>('.bubble.is-out[data-mid]');
      for(let i = bubbles.length - 1; i >= 0; i--) {
        const mid = bubbles[i].dataset.mid;
        if(!mid || tracked.has(mid)) continue;
        eventIdToBubbleMid.set(eventId, mid);
        return true;
      }
      return false;
    };
    if(!captureLatest()) {
      for(const delay of [100, 300, 800, 2000]) {
        await new Promise((r) => setTimeout(r, delay));
        if(captureLatest()) break;
      }
    }

    // Flip the bubble's clock spinner to a single check now that the relay
    // has accepted the publish. Without this the bubble waits on the
    // delivery receipt to clear the spinner — and stays stuck on the clock
    // forever if the receipt is delayed (slow network, peer offline) or
    // lost. FIND-9fa52e43: bubble showed time-sending-status 40+ seconds
    // after recipient confirmed receipt because no delivery receipt
    // round-tripped back. The 'sent' state now provides an honest
    // intermediate UI signal between sending and delivered.
    const mid = eventIdToBubbleMid.get(eventId);
    if(mid) {
      await applyBubbleState(mid, 'sent');
    }

    // Refresh chat list preview
    try {
      const im = MOUNT_CLASS_TO.appImManager;
      const chatPid = im?.chat?.peerId;
      if(chatPid) {
        await refreshDialogPreview(+chatPid);
      }
    } catch{ /* non-critical */ }
  };

  const handleDeliveredOrRead = async(eventId: string, state: 'delivered' | 'read') => {
    const mapHit = eventIdToBubbleMid.has(eventId);
    let mid = eventIdToBubbleMid.get(eventId);
    if(!mid) {
      const {getMessageStore: gms2} = await import('@lib/phantomchat/message-store');
      // A receipt's eventId is EITHER the rumor id (NIP-17 plain-text sends —
      // the row's `eventId`) OR the app message id (legacy envelope sends —
      // the row's `appMessageId`). Look up by both.
      const stored = (await gms2().getByEventId(eventId)) || (await gms2().getByAppMessageId(eventId));
      // Prefer the row's AUTHORITATIVE `mid`. Re-hashing the eventId is wrong
      // for rekeyed (rumor-id) receipts: the bubble mid is derived from the APP
      // message id (chat-api mapEventIdToMid(messageId)), not the rumor id, so
      // mapEventId(rumorId) would point at a phantom bubble and the ✓✓ would
      // never land. This bites only when the in-memory map misses — e.g. a fast
      // delivery receipt that races ahead of the 'sent' handler that populates
      // it. FIND-rekey-tick.
      if(stored?.mid != null) {
        mid = String(stored.mid);
      } else {
        const {PhantomChatPeerMapper} = await import('@lib/phantomchat/phantomchat-peer-mapper');
        const mapper = new PhantomChatPeerMapper();
        const ts = stored?.timestamp ?? Math.floor(Date.now() / 1000);
        const hashed = await mapper.mapEventId(eventId, ts);
        if(hashed) mid = String(hashed);
      }
    }
    if(!mid) {
      console.debug('[PhantomChatDeliveryUI] %s receipt could not resolve a bubble', state, {eventId, mapHit});
      return;
    }

    let applied = await applyBubbleState(mid, state);
    if(!applied) {
      for(const delay of [300, 800, 2000]) {
        await new Promise((r) => setTimeout(r, delay));
        if(await applyBubbleState(mid, state)) {applied = true; break;}
      }
    }
    console.debug('[PhantomChatDeliveryUI] %s receipt → bubble %s (mapHit=%s, applied=%s)', state, mid, mapHit, applied, {eventId});
  };

  return {
    attach() {
      rootScope.addEventListener('phantomchat_delivery_update', async(data: any) => {
        try {
          const state = data?.state;
          const eventId = data?.eventId;
          if(!eventId || !state) return;

          if(state === 'sent') {
            await handleSent(eventId);
            return;
          }

          if(state === 'delivered' || state === 'read') {
            await handleDeliveredOrRead(eventId, state);
          }
        } catch(err) {
          console.warn('[PhantomChatDeliveryUI] phantomchat_delivery_update handler error:', err);
        }
      });
    }
  };
}
