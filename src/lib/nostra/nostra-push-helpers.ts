/**
 * nostra-push-helpers.ts
 *
 * Shared helpers for the push notification subsystem — usable from both the
 * Settings UI (NostraBackgroundNotifications) and the onboarding integration.
 */

import {getEndpointBase} from '@lib/nostra/nostra-push-storage';
import {fetchVapidPublicKey} from '@lib/nostra/nostra-push-client';

/**
 * Fetch (and localStorage-cache) the VAPID public key for the configured
 * push relay endpoint. Returns null on any failure.
 *
 * The cache key is scoped to the endpoint URL so that changing the endpoint
 * in Advanced settings forces a fresh fetch.
 */
export async function resolveVapidKey(): Promise<string | null> {
  try {
    const base = await getEndpointBase();
    const cacheKey = `nostra-push-vapid-${base}`;
    if(typeof localStorage !== 'undefined') {
      const cached = localStorage.getItem(cacheKey);
      if(cached) return cached;
    }
    const key = await fetchVapidPublicKey({endpointBase: base});
    if(!key) return null;
    if(typeof localStorage !== 'undefined') {
      try { localStorage.setItem(cacheKey, key); } catch{ /* ignore */ }
    }
    return key;
  } catch{
    return null;
  }
}
