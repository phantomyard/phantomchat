import {describe, expect, beforeEach, afterEach, it, vi} from 'vitest';
import 'fake-indexeddb/auto';
import {generateSecretKey, getPublicKey} from 'nostr-tools';

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
}
import {
  subscribePush,
  unsubscribePush,
  getRegistration,
  fetchVapidPublicKey,
  buildNip98Header
} from '@lib/nostra/nostra-push-client';
import {destroy as destroyStorage, setSubscription} from '@lib/nostra/nostra-push-storage';

const VAPID_KEY = 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function setupBrowserMocks() {
  (globalThis as any).Notification = {permission: 'granted'};
  if(typeof (globalThis as any).atob !== 'function') {
    (globalThis as any).atob = (s: string) => Buffer.from(s, 'base64').toString('binary');
  }

  const mockSubscription = {
    endpoint: 'https://fcm.googleapis.com/wp/test',
    toJSON: () => ({
      endpoint: 'https://fcm.googleapis.com/wp/test',
      keys: {p256dh: 'p256X', auth: 'authY'}
    }),
    unsubscribe: vi.fn().mockResolvedValue(true)
  };
  const mockPushManager = {
    getSubscription: vi.fn().mockResolvedValue(null),
    subscribe: vi.fn().mockResolvedValue(mockSubscription)
  };
  const mockReg = {pushManager: mockPushManager};
  (globalThis as any).navigator = {serviceWorker: {ready: Promise.resolve(mockReg)}};

  return {mockSubscription, mockPushManager};
}

function makeKeyPair(): {sk: Uint8Array; skHex: string; pkHex: string} {
  const sk = generateSecretKey();
  const skHex = bytesToHex(sk);
  const pkHex = getPublicKey(sk);
  return {sk, skHex, pkHex};
}

describe('nostra-push-client', () => {
  beforeEach(async() => {
    await destroyStorage();
    indexedDB.deleteDatabase('nostra-push');
  });
  afterEach(async() => {
    await destroyStorage();
    vi.restoreAllMocks();
  });

  describe('buildNip98Header', () => {
    it('produces a "Nostr <base64>" header that decodes to a kind-27235 event', async() => {
      const {skHex, pkHex} = makeKeyPair();
      const url = `https://push.nostra.chat/subscription/${pkHex}`;
      const h = await buildNip98Header({privkeyHex: skHex, method: 'PUT', url});
      expect(h.startsWith('Nostr ')).toBe(true);
      const b64 = h.slice('Nostr '.length);
      const json = Buffer.from(b64, 'base64').toString('utf-8');
      const evt = JSON.parse(json);
      expect(evt.kind).toBe(27235);
      expect(evt.pubkey).toBe(pkHex);
      const tagUrl = evt.tags.find((t: string[]) => t[0] === 'url')?.[1];
      const tagMethod = evt.tags.find((t: string[]) => t[0] === 'method')?.[1];
      expect(tagUrl).toBe(url);
      expect(tagMethod).toBe('PUT');
      expect(typeof evt.sig).toBe('string');
      expect(evt.sig.length).toBe(128);
    });
  });

  describe('fetchVapidPublicKey', () => {
    it('returns the key on 200', async() => {
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        json: async() => ({vapid_public_key: VAPID_KEY, version: '0.1.0'})
      });
      const k = await fetchVapidPublicKey({endpointBase: 'https://push.nostra.chat', fetchFn});
      expect(k).toBe(VAPID_KEY);
      expect(fetchFn).toHaveBeenCalledWith('https://push.nostra.chat/info', {method: 'GET'});
    });

    it('returns null on non-ok', async() => {
      const fetchFn = vi.fn().mockResolvedValue({ok: false, json: async() => ({})});
      expect(await fetchVapidPublicKey({endpointBase: 'https://x', fetchFn})).toBeNull();
    });

    it('returns null on missing field', async() => {
      const fetchFn = vi.fn().mockResolvedValue({ok: true, json: async() => ({version: '0.1.0'})});
      expect(await fetchVapidPublicKey({endpointBase: 'https://x', fetchFn})).toBeNull();
    });
  });

  describe('subscribePush', () => {
    it('returns null when permission not granted', async() => {
      (globalThis as any).Notification = {permission: 'denied'};
      const {skHex, pkHex} = makeKeyPair();
      const out = await subscribePush({pubkeyHex: pkHex, privkeyHex: skHex, vapidPublicKey: VAPID_KEY});
      expect(out).toBeNull();
    });

    it('PUTs the right URL + body + NIP-98 header on 200, persists record', async() => {
      setupBrowserMocks();
      const {skHex, pkHex} = makeKeyPair();
      const fetchFn = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async() => ({subscription_id: 'sub_xyz'})
      });
      const rec = await subscribePush({
        pubkeyHex: pkHex,
        privkeyHex: skHex,
        vapidPublicKey: VAPID_KEY,
        fetchFn
      });
      expect(rec).toBeTruthy();
      expect(rec!.subscriptionId).toBe('sub_xyz');
      expect(rec!.pubkey).toBe(pkHex);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe(`https://push.nostra.chat/subscription/${pkHex}`);
      expect(init.method).toBe('PUT');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(typeof init.headers.authorization).toBe('string');
      expect(init.headers.authorization.startsWith('Nostr ')).toBe(true);

      const body = JSON.parse(init.body);
      expect(body).toEqual({
        endpoint: 'https://fcm.googleapis.com/wp/test',
        keys: {p256dh: 'p256X', auth: 'authY'}
      });

      // Persisted to IDB
      const stored = await getRegistration();
      expect(stored?.subscriptionId).toBe('sub_xyz');
    });

    it('returns null on register HTTP failure and does NOT persist', async() => {
      setupBrowserMocks();
      const {skHex, pkHex} = makeKeyPair();
      const fetchFn = vi.fn().mockResolvedValue({ok: false, status: 500, json: async() => ({})});
      const out = await subscribePush({
        pubkeyHex: pkHex,
        privkeyHex: skHex,
        vapidPublicKey: VAPID_KEY,
        fetchFn
      });
      expect(out).toBeNull();
      expect(await getRegistration()).toBeNull();
    });
  });

  describe('unsubscribePush', () => {
    it('issues DELETE with NIP-98 auth and clears storage', async() => {
      setupBrowserMocks();
      const {skHex, pkHex} = makeKeyPair();

      // Pre-seed storage with a subscription record
      await setSubscription({
        subscriptionId: 'sub_del',
        endpointBase: 'https://push.nostra.chat',
        pubkey: pkHex,
        registeredAt: 1700000000_000,
        endpoint: 'https://fcm.googleapis.com/wp/test',
        keys: {p256dh: 'p256X', auth: 'authY'}
      });

      const fetchFn = vi.fn().mockResolvedValue({ok: true, status: 200});
      // navigator.serviceWorker mock for unsubscribe call
      const mockSub = {unsubscribe: vi.fn().mockResolvedValue(true)};
      (globalThis as any).navigator = {
        serviceWorker: {
          ready: Promise.resolve({pushManager: {getSubscription: vi.fn().mockResolvedValue(mockSub)}})
        }
      };

      await unsubscribePush({privkeyHex: skHex, fetchFn});

      expect(fetchFn).toHaveBeenCalledTimes(1);
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toContain(`/subscription/${pkHex}`);
      expect(url).toContain('endpoint=' + encodeURIComponent('https://fcm.googleapis.com/wp/test'));
      expect(init.method).toBe('DELETE');
      expect(init.headers.authorization.startsWith('Nostr ')).toBe(true);

      expect(await getRegistration()).toBeNull();
      expect(mockSub.unsubscribe).toHaveBeenCalled();
    });

    it('is a no-op when no record exists (still clears any local pushManager subscription gracefully)', async() => {
      const {skHex} = makeKeyPair();
      const fetchFn = vi.fn();
      // No storage setup. navigator may be undefined in test env — ensure no crash.
      delete (globalThis as any).navigator;
      await unsubscribePush({privkeyHex: skHex, fetchFn});
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });
});
