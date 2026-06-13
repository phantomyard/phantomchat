/**
 * phantomchat-push-client.ts
 *
 * Main-thread API for the PhantomChat Web Push relay (default: nostr-webpush-relay
 * deployed at https://push.phantomchat.chat — see docs/PUSH-NOTIFICATIONS.md).
 *
 * Caller responsibilities:
 *   - Pass `fetchFn` so the caller can route via Tor's webtorClient.fetch
 *     when PrivacyTransport mode is active. Default is globalThis.fetch.
 *   - Pass `privkeyHex` (the user's nsec, hex) so this module can sign
 *     NIP-98 Authorization headers without owning identity-loading logic.
 *
 * Persists its subscription state via phantomchat-push-storage.
 */

import {finalizeEvent, type EventTemplate} from 'nostr-tools';
import {hexToBytes} from '@noble/hashes/utils.js';
import {
  type PushSubscriptionRecord,
  getSubscription,
  setSubscription,
  clearSubscription,
  getEndpointBase,
  setEndpointBase
} from '@lib/phantomchat/phantomchat-push-storage';

export type {PushSubscriptionRecord};
export type FetchFn = typeof fetch;

interface SubscribeOptions {
  pubkeyHex: string;
  privkeyHex: string;
  vapidPublicKey: string;
  fetchFn?: FetchFn;
  endpointBase?: string;
}

interface RegisterRequestBody {
  endpoint: string;
  keys: {p256dh: string; auth: string};
  relays?: string[];
}

interface RegisterResponse {
  subscription_id: string;
}

const LOG_PREFIX = '[PhantomChatPushClient]';

/**
 * GET /info → fetch VAPID public key. Returns null on any failure.
 *
 * A "Failed to fetch" TypeError almost always means the relay is missing
 * `Access-Control-Allow-Origin` for the PhantomChat.chat origin (see
 * docs/PUSH-NOTIFICATIONS.md → "CORS requirement"). The browser also logs
 * the underlying CORS reason just before this warning fires.
 */
export async function fetchVapidPublicKey(opts: {endpointBase?: string; fetchFn?: FetchFn} = {}): Promise<string | null> {
  let base: string | undefined;
  try {
    base = opts.endpointBase ?? (await getEndpointBase());
    const fetchFn = opts.fetchFn || globalThis.fetch.bind(globalThis);
    const res = await fetchFn(`${base}/info`, {method: 'GET'});
    if(!res.ok) {
      console.warn(LOG_PREFIX, `/info HTTP ${res.status} from ${base}`);
      return null;
    }
    const json = await res.json();
    return typeof json?.vapid_public_key === 'string' && json.vapid_public_key.length > 0 ?
      json.vapid_public_key :
      null;
  } catch(e: any) {
    const msg = e?.message ?? String(e);
    const corsLikely = /Failed to fetch|NetworkError/i.test(msg);
    console.warn(
      LOG_PREFIX,
      `/info fetch failed for ${base}:`,
      msg,
      corsLikely ? '— likely missing Access-Control-Allow-Origin on the relay (see docs/PUSH-NOTIFICATIONS.md)' : ''
    );
    return null;
  }
}

/**
 * Build a NIP-98 Authorization header value (full string starting with 'Nostr ').
 * Uses nostr-tools.finalizeEvent under the hood.
 */
export async function buildNip98Header(opts: {privkeyHex: string; method: string; url: string}): Promise<string> {
  const tmpl: EventTemplate = {
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['url', opts.url], ['method', opts.method.toUpperCase()]],
    content: ''
  };
  const evt = finalizeEvent(tmpl, hexToBytes(opts.privkeyHex));
  const json = JSON.stringify(evt);
  // base64-encode the JSON. btoa exists in browsers and modern SW context;
  // fall back to Buffer for any context where btoa is missing (e.g. Node tests).
  const b64 = typeof btoa === 'function' ?
    btoa(json) :
    (globalThis as any).Buffer.from(json, 'utf-8').toString('base64');
  return 'Nostr ' + b64;
}

/**
 * Subscribe Web Push at the browser level + register with the push relay.
 * Returns the persisted record on success, null on user-denied permission
 * or unrecoverable network failure.
 */
export async function subscribePush(opts: SubscribeOptions): Promise<PushSubscriptionRecord | null> {
  if(typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    return null;
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if(!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(opts.vapidPublicKey)
    });
  }
  const json = sub.toJSON();
  const endpoint = json.endpoint!;
  const p256dh = json.keys?.p256dh ?? '';
  const auth = json.keys?.auth ?? '';
  if(!p256dh || !auth) {
    console.warn(LOG_PREFIX, 'subscription missing keys');
    return null;
  }

  const endpointBase = opts.endpointBase ?? (await getEndpointBase());
  const fetchFn = opts.fetchFn || globalThis.fetch.bind(globalThis);
  const url = `${endpointBase}/subscription/${opts.pubkeyHex}`;
  const authorization = await buildNip98Header({privkeyHex: opts.privkeyHex, method: 'PUT', url});
  const body: RegisterRequestBody = {endpoint, keys: {p256dh, auth}};

  let registeredId: string;
  try {
    const res = await fetchFn(url, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', authorization},
      body: JSON.stringify(body)
    });
    if(!res.ok) {
      console.warn(LOG_PREFIX, 'register HTTP', res.status);
      return null;
    }
    const parsed = (await res.json()) as RegisterResponse;
    registeredId = parsed.subscription_id;
  } catch(e: any) {
    console.warn(LOG_PREFIX, 'register fetch failed:', e?.message);
    return null;
  }

  const record: PushSubscriptionRecord = {
    subscriptionId: registeredId,
    endpointBase,
    pubkey: opts.pubkeyHex,
    registeredAt: Date.now(),
    endpoint,
    keys: {p256dh, auth}
  };
  await setSubscription(record);
  return record;
}

interface UnsubscribeOptions {
  privkeyHex: string;
  fetchFn?: FetchFn;
}

export async function unsubscribePush(opts: UnsubscribeOptions): Promise<void> {
  const rec = await getSubscription();
  if(rec) {
    const fetchFn = opts.fetchFn || globalThis.fetch.bind(globalThis);
    const url = `${rec.endpointBase}/subscription/${rec.pubkey}?endpoint=${encodeURIComponent(rec.endpoint)}`;
    try {
      const authorization = await buildNip98Header({privkeyHex: opts.privkeyHex, method: 'DELETE', url});
      await fetchFn(url, {method: 'DELETE', headers: {authorization}});
    } catch(e: any) {
      console.warn(LOG_PREFIX, 'unregister fetch failed (ignoring):', e?.message);
    }
  }
  try {
    if(typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if(sub) await sub.unsubscribe();
    }
  } catch(e: any) {
    console.warn(LOG_PREFIX, 'pushManager.unsubscribe error (ignoring):', e?.message);
  }
  await clearSubscription();
}

export async function getRegistration(): Promise<PushSubscriptionRecord | null> {
  return getSubscription();
}

export async function setEndpointOverride(url: string | null): Promise<void> {
  await setEndpointBase(url);
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for(let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}
