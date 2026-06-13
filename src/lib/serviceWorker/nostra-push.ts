/**
 * nostra-push.ts (Service Worker)
 *
 * Handles incoming Web Push events shaped for Nostra. Discriminator: payload
 * has `app === 'nostra-webpush-relay'`. Per preview level:
 *   A — show generic notification, never read privkey.
 *   B — read privkey, decrypt NIP-44 gift-wrap, render sender name + body.
 *   C — read privkey, decrypt, render sender name + "[encrypted]".
 *
 * Aggregation: rate-limit per peerId in a 5-minute window.
 */

declare const self: ServiceWorkerGlobalScope;

import {
  AGGREGATION_WINDOW_MS,
  AggregationEntry,
  clearAggregationFor,
  getAggregationState,
  getPreviewLevel,
  setAggregationState
} from '@lib/nostra/nostra-push-storage';
import {loadIdentitySW} from '@lib/nostra/nostra-identity-sw';
import {hexToBytes} from '@noble/hashes/utils.js';

interface NostraPushPayload {
  app: 'nostra-webpush-relay';
  version: 1;
  event_id: string;
  recipient_pubkey: string;
  nostra_event: string; // serialized full kind 1059 event
}

const DEFAULT_TITLE = 'Nostra.chat';
const DEFAULT_BODY = 'New message';

export async function onNostraPush(event: ExtendableEvent & {data: PushMessageData}): Promise<void> {
  let payload: NostraPushPayload;
  try {
    payload = event.data.json() as NostraPushPayload;
  } catch{
    return;
  }
  if(payload.app !== 'nostra-webpush-relay') return;

  const previewLevel = await getPreviewLevel();

  let peerKey = payload.event_id;
  let title = DEFAULT_TITLE;
  let body = DEFAULT_BODY;

  if(previewLevel !== 'A') {
    try {
      const decrypted = await tryDecrypt(payload);
      if(decrypted) {
        peerKey = decrypted.senderPubkey;
        title = decrypted.senderName;
        body = previewLevel === 'C' ? '[encrypted]' : truncate(decrypted.text, 80);
      }
    } catch(e: any) {
      console.warn('[NostraPushSW] decrypt failed:', e?.message);
    }
  }

  await showAggregated({peerKey, title, body, payload});
}

interface DecryptedRumor {
  senderPubkey: string;
  senderName: string;
  text: string;
}

async function tryDecrypt(payload: NostraPushPayload): Promise<DecryptedRumor | null> {
  const identity = await loadIdentitySW();
  if(!identity) return null;
  if(!payload.nostra_event) return null;
  const evt = JSON.parse(payload.nostra_event);
  const {unwrapNip17Message} = await import('@lib/nostra/nostr-crypto');
  const privkeyBytes = hexToBytes(identity.privateKey);
  const rumor = unwrapNip17Message(evt, privkeyBytes);
  if(!rumor) return null;
  const senderName = await resolveSenderName(rumor.pubkey);
  const text = typeof rumor.content === 'string' ? rumor.content : '';
  return {
    senderPubkey: rumor.pubkey,
    senderName: senderName || shortenPubkey(rumor.pubkey),
    text
  };
}

async function resolveSenderName(pubkey: string): Promise<string | null> {
  try {
    const db = await openVirtualPeersDB();
    return await new Promise<string | null>((resolve) => {
      try {
        const tx = db.transaction('peers', 'readonly');
        const req = tx.objectStore('peers').get(pubkey);
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const r = req.result;
          if(r && typeof r.displayName === 'string' && r.displayName.length) {
            resolve(r.displayName);
          } else { resolve(null); }
        };
      } catch{ resolve(null); }
    });
  } catch{ return null; }
}

function openVirtualPeersDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nostra-virtual-peers');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

interface ShowAggregatedArgs {
  peerKey: string;
  title: string;
  body: string;
  payload: NostraPushPayload;
}

async function showAggregated(args: ShowAggregatedArgs): Promise<void> {
  const state = await getAggregationState();
  const now = Date.now();
  const tag = 'nostra-' + args.peerKey;
  const entry: AggregationEntry = state[args.peerKey] || {ts: 0, count: 0, tag};
  let body = args.body;
  if(now - entry.ts < AGGREGATION_WINDOW_MS) {
    entry.count += 1;
    body = `${entry.count} new messages from ${args.title}`;
  } else {
    entry.count = 1;
  }
  entry.ts = now;
  entry.tag = tag;
  state[args.peerKey] = entry;
  await setAggregationState(state);

  await self.registration.showNotification(args.title, {
    body,
    tag: entry.tag,
    icon: '/assets/img/logo_filled_rounded.png',
    badge: '/assets/img/logo_filled_rounded.png',
    data: {
      app: 'nostra',
      peerKey: args.peerKey,
      eventId: args.payload.event_id
    }
  });
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function shortenPubkey(pk: string): string {
  return pk.length > 16 ? `${pk.slice(0, 8)}…${pk.slice(-4)}` : pk;
}

/** Notification click handler — opens or focuses Nostra to the right peer. */
export async function onNostraNotificationClick(event: NotificationEvent): Promise<void> {
  const data = event.notification.data;
  if(!data || data.app !== 'nostra') return;
  event.notification.close();
  if(typeof data.peerKey === 'string') {
    await clearAggregationFor(data.peerKey).catch(() => { /* ignore */ });
  }
  const url = `/?p=${encodeURIComponent(data.peerKey)}&m=${encodeURIComponent(data.eventId)}`;
  const all = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
  for(const client of all) {
    try {
      await (client as WindowClient).focus();
      (client as WindowClient).postMessage({type: 'nostra-push-open', url});
      return;
    } catch{ /* ignore */ }
  }
  await self.clients.openWindow(url);
}
