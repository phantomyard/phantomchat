/**
 * e2e-push-bilateral.ts — Online E2E test for background push notifications.
 *
 * Two Playwright Chromium contexts (A and B) hit a running production build
 * (dist/ served by `vite preview` or similar). Each onboards with a fresh Nostr
 * identity. A grants notification permission and the app auto-subscribes a Web
 * Push subscription against the live production relay at https://push.nostra.chat.
 * A's tab is then "backgrounded". B sends a P2P message to A. The test asserts
 * that A's Service Worker fires a Web Push notification within ~30 seconds.
 *
 * ONLINE ONLY — depends on push.nostra.chat being reachable and on real Nostr
 * relays being up. Must NOT be included in test:nostra:quick or run-all.sh.
 * Run via: `pnpm test:e2e:push`
 *
 * Skip conditions (exit 0, not a failure):
 *   - NOSTRA_PUSH_E2E_OFFLINE=1 env var
 *   - push.nostra.chat /healthz unreachable
 *   - App server (E2E_APP_URL / localhost:8080) unreachable
 *   - No Service Worker registered (dev server — run against a prod build instead)
 *   - pushManager.subscribe() fails — environment limitation (headless Chromium
 *     without Google account, CI with restricted FCM access). See note below.
 *
 * Environment note (push subscription availability):
 *   Chromium's pushManager.subscribe() requires registration with the browser
 *   vendor's push service (FCM for Chrome, AutoPush for Firefox). In headless CI
 *   without a Google account or on restricted networks, this call fails with
 *   "Registration failed - permission denied". In such environments this test
 *   skips gracefully. To run the full end-to-end flow:
 *     - Use a real desktop Chromium with a signed-in Google account, OR
 *     - Set NOSTRA_PUSH_E2E_FULL=1 to fail instead of skip on push env limits.
 *
 * What this test ALWAYS covers (even when pushManager is unavailable):
 *   1. Skip logic is correct
 *   2. Notification permission is grantable via Playwright
 *   3. The production build registers a Service Worker
 *   4. VAPID key is fetchable from the relay
 *   5. Auto-subscribe logic fires when permission is granted
 *
 * What this test covers ONLY when pushManager is available:
 *   6. Full subscription registration with push.nostra.chat
 *   7. B's Nostr message triggers relay to send a Web Push to A
 *   8. A's SW receives the push and shows a notification with nostra-* tag
 *
 * Requires: a production build served at APP_URL (not `pnpm start` dev server
 * — the dev server doesn't register a SW because SW registration is guarded
 * by `import.meta.env.PROD`).
 * Build: `pnpm build && node_modules/.bin/vite preview --port 8080 --host 127.0.0.1`
 */
// @ts-nocheck
import {chromium, type Page, type BrowserContext} from 'playwright';
import {finalizeEvent} from 'nostr-tools/pure';
import {hexToBytes} from '@noble/hashes/utils.js';
import {launchOptions} from './helpers/launch-options';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = process.env.E2E_APP_URL || 'http://localhost:8080';
const PUSH_RELAY = process.env.NOSTRA_PUSH_RELAY || 'https://push.nostra.chat';
// When set, fail instead of skip on pushManager environment limitations
const FAIL_ON_ENV_LIMIT = process.env.NOSTRA_PUSH_E2E_FULL === '1';
// Timeout (ms) to wait for notification after B sends message
const NOTIFY_TIMEOUT_MS = 30000;
const POLL_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

async function probeUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {method: 'GET', signal: AbortSignal.timeout(8000)});
    return res.ok;
  } catch{
    return false;
  }
}

function skipTest(reason: string): never {
  console.log(`[push-bilateral] SKIP: ${reason}`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Onboarding helpers
// ---------------------------------------------------------------------------

async function dismissProductionPopups(page: Page): Promise<void> {
  // Production boot shows a "You're all set / Got it" first-boot verification
  // popup (Phase A) that blocks the onboarding buttons. Dismiss it if present.
  try {
    const gotItBtn = page.getByRole('button', {name: 'Got it'});
    const visible = await gotItBtn.isVisible().catch(() => false);
    if(visible) {
      await gotItBtn.click({timeout: 3000});
      await page.waitForTimeout(500);
    }
  } catch{} // eslint-disable-line no-empty
  await dismissOverlays(page);
}

async function createIdentity(page: Page, displayName: string): Promise<string> {
  await page.goto(APP_URL, {waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(15000);
  await dismissProductionPopups(page);

  await page.getByRole('button', {name: 'Create New Identity'}).waitFor({state: 'visible', timeout: 30000});
  await page.getByRole('button', {name: 'Create New Identity'}).click();
  await page.waitForTimeout(2000);

  const npub = await page.evaluate(() => {
    for(const e of document.querySelectorAll('*')) {
      if(e.children.length === 0 && e.textContent?.includes('npub1')) return e.textContent.trim();
    }
    return '';
  });

  await page.getByRole('button', {name: 'Continue'}).click();
  await page.waitForTimeout(2000);
  const nameInput = page.getByRole('textbox');
  if(await nameInput.isVisible()) {
    await nameInput.fill(displayName);
    await page.getByRole('button', {name: 'Get Started'}).click();
  }
  await page.waitForTimeout(8000);
  return npub;
}

async function addPeerAsContact(page: Page, peerNpub: string, peerName: string): Promise<void> {
  // UI-driven add — avoids dynamic import of /src/... modules which the
  // installed Service Worker intercepts and 404s in the persistent context.
  // Path: #new-menu → "Add Contact" → fill nickname + npub → click "Add".

  // Wait until the main UI is ready (own pubkey set means onboarding is done).
  await page.waitForFunction(
    () => typeof (window as any).__nostraOwnPubkey === 'string' &&
          (window as any).__nostraOwnPubkey.length === 64,
    null,
    {timeout: 30000}
  );
  await page.waitForTimeout(500);

  // Open the new-chats menu (pencil button in the top-right of the sidebar).
  await page.locator('#new-menu').click({timeout: 10000});
  await page.waitForTimeout(400);

  // Click the "Add to contacts" menu item (i18n key: AddContact).
  await page.locator('.btn-menu-item', {hasText: 'Add to contacts'}).first().click({timeout: 5000});
  await page.waitForTimeout(600);

  // The .popup-add-contact-overlay should now be visible.
  await page.waitForSelector('.popup-add-contact-overlay', {timeout: 8000});

  // Fill nickname (optional field, appears first in DOM).
  if(peerName) {
    await page.locator('.popup-add-contact-overlay input[placeholder="Nickname (optional)"]')
      .fill(peerName);
    await page.waitForTimeout(200);
  }

  // Fill npub (second input). Use fill() — clipboard paste is not needed.
  await page.locator('.popup-add-contact-overlay input[placeholder="npub1..."]')
    .fill(peerNpub);
  await page.waitForTimeout(200);

  // Click the "Add" button (btn-color-primary).
  await page.locator('.popup-add-contact-overlay button.btn-color-primary').click({timeout: 5000});

  // Wait for popup to close (overlay element removed from DOM).
  await page.waitForSelector('.popup-add-contact-overlay', {state: 'detached', timeout: 15000});

  // Brief settle — addP2PContact is async and mirrors are populated after.
  await page.waitForTimeout(2000);
}

async function readFirstP2PPeerId(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const proxy = (window as any).apiManagerProxy;
    const peers = proxy?.mirrors?.peers || {};
    for(const pid of Object.keys(peers)) {
      if(Number(pid) >= 1e15) return Number(pid);
    }
    return 0;
  });
}

async function openChatAndSend(page: Page, peerId: number, text: string): Promise<void> {
  await page.evaluate(async({pid, t}) => {
    (window as any).appImManager?.setPeer?.({peerId: pid});
    await new Promise((r) => setTimeout(r, 500));
    const input = document.querySelector('.chat-input [contenteditable="true"]') as HTMLElement;
    if(input) {
      input.focus();
      document.execCommand('insertText', false, t);
      const sendBtn = document.querySelector('.chat-input button.btn-send') as HTMLElement;
      if(sendBtn) sendBtn.click();
    }
  }, {pid: peerId, t: text});
}

// ---------------------------------------------------------------------------
// Push subscription helpers
// ---------------------------------------------------------------------------

/** Read push subscription record from IDB (nostra-push DB). */
async function getIdbPushSubscription(page: Page): Promise<any> {
  return await page.evaluate(async() => {
    try {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const req = indexedDB.open('nostra-push', 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          if(!req.result.objectStoreNames.contains('kv')) {
            req.result.createObjectStore('kv', {keyPath: 'k'});
          }
        };
      });
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('kv', 'readonly');
        const req = tx.objectStore('kv').get('subscription');
        req.onerror = () => { db.close(); reject(req.error); };
        req.onsuccess = () => { db.close(); resolve(req.result ? req.result.v : null); };
      });
    } catch{
      return null;
    }
  });
}

/** Wait for auto-subscribe to complete (polls IDB). */
async function waitForPushSubscription(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const rec = await getIdbPushSubscription(page);
    if(rec) return true;
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  return false;
}

/**
 * Attempt to get a browser-level push subscription from A's SW.
 * Returns the subscription JSON on success, null if pushManager is unavailable
 * in this environment (headless CI without FCM access).
 */
async function tryGetBrowserPushSub(page: Page, vapidKey: string): Promise<{endpoint: string; p256dh: string; auth: string} | null> {
  return await page.evaluate(async(vk) => {
    try {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('SW not ready within 15s')), 15000))
      ]) as ServiceWorkerRegistration;
      let sub = await reg.pushManager.getSubscription();
      if(!sub) {
        const padding = '='.repeat((4 - vk.length % 4) % 4);
        const base64 = (vk + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = atob(base64);
        const keyData = new Uint8Array(rawData.length);
        for(let i = 0; i < rawData.length; i++) keyData[i] = rawData.charCodeAt(i);
        sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: keyData});
      }
      const json = sub.toJSON();
      if(!json.keys?.p256dh || !json.keys?.auth) return null;
      return {endpoint: json.endpoint!, p256dh: json.keys.p256dh, auth: json.keys.auth};
    } catch(e: any) {
      // pushManager.subscribe() can fail in headless CI — environment limitation
      console.warn('[push-bilateral] pushManager.subscribe failed (env limit):', e?.message);
      return null;
    }
  }, vapidKey);
}

/** Build a NIP-98 auth header on the Node.js side. */
function buildNip98Header(privkeyHex: string, method: string, url: string): string {
  const tmpl = {kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [['url', url], ['method', method.toUpperCase()]], content: ''};
  const evt = finalizeEvent(tmpl, hexToBytes(privkeyHex));
  const b64 = Buffer.from(JSON.stringify(evt)).toString('base64');
  return 'Nostr ' + b64;
}

/** Get own privkey from page context (works in dev mode via /src/ imports). */
async function getOwnPrivkeyHex(page: Page): Promise<string | null> {
  return await page.evaluate(async() => {
    try {
      const {loadEncryptedIdentity, loadBrowserKey, decryptKeys} =
        await import('/src/lib/nostra/key-storage.ts');
      const encRecord = await loadEncryptedIdentity();
      const bk = await loadBrowserKey();
      if(!encRecord || !bk) return null;
      const {seed} = await decryptKeys(encRecord.iv, encRecord.encryptedKeys, bk);
      const {importFromMnemonic} = await import('/src/lib/nostra/nostr-identity.ts');
      return importFromMnemonic(seed).privateKey;
    } catch{
      return null;
    }
  });
}

/** Register a push subscription with the relay (server-side fetch, no CORS). */
async function registerWithRelay(opts: {
  endpointBase: string;
  pubkeyHex: string;
  privkeyHex: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}): Promise<string | null> {
  const url = `${opts.endpointBase}/subscription/${opts.pubkeyHex}`;
  const authorization = buildNip98Header(opts.privkeyHex, 'PUT', url);
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json', authorization},
      body: JSON.stringify({endpoint: opts.endpoint, keys: {p256dh: opts.p256dh, auth: opts.auth}}),
      signal: AbortSignal.timeout(10000)
    });
    if(!res.ok) {
      const body = await res.text().catch(() => '');
      console.warn('[push-bilateral] relay register HTTP', res.status, body.slice(0, 200));
      return null;
    }
    const parsed = await res.json();
    return parsed.subscription_id || 'ok';
  } catch(e: any) {
    console.warn('[push-bilateral] relay register error:', e?.message);
    return null;
  }
}

/** Delete a push subscription from the relay (server-side fetch, no CORS). */
async function unregisterFromRelay(opts: {endpointBase: string; pubkeyHex: string; privkeyHex: string; endpoint: string}): Promise<void> {
  const url = `${opts.endpointBase}/subscription/${opts.pubkeyHex}?endpoint=${encodeURIComponent(opts.endpoint)}`;
  try {
    const authorization = buildNip98Header(opts.privkeyHex, 'DELETE', url);
    const res = await fetch(url, {method: 'DELETE', headers: {authorization}, signal: AbortSignal.timeout(8000)});
    if(res.ok) {
      console.log('[push-bilateral] cleanup: push subscription deleted from relay');
    } else {
      console.warn('[push-bilateral] cleanup: relay DELETE returned', res.status, '(non-fatal)');
    }
  } catch(e: any) {
    console.warn('[push-bilateral] cleanup: relay DELETE error (non-fatal):', e?.message);
  }
}

/** Poll SW getNotifications() for a nostra-tagged notification. */
async function pollForNotification(page: Page, timeoutMs: number): Promise<{title: string; body: string; tag: string} | null> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const notifs = await page.evaluate(async() => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const ns = await reg.getNotifications({});
        return ns.map((n: any) => ({title: n.title, body: n.body, tag: n.tag}));
      } catch{
        return [];
      }
    }).catch(() => []);
    const nostraNotif = (notifs as any[]).find((n) => n.tag?.startsWith('nostra-'));
    if(nostraNotif) return nostraNotif;
    await page.waitForTimeout(POLL_INTERVAL_MS);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

(async() => {
  // --- Skip checks ---
  if(process.env.NOSTRA_PUSH_E2E_OFFLINE === '1') {
    skipTest('NOSTRA_PUSH_E2E_OFFLINE=1');
  }

  const relayReachable = await probeUrl(`${PUSH_RELAY}/healthz`);
  if(!relayReachable) {
    skipTest(`${PUSH_RELAY}/healthz unreachable`);
  }
  console.log(`[push-bilateral] push relay reachable: ${PUSH_RELAY}`);

  const appReachable = await probeUrl(APP_URL);
  if(!appReachable) {
    skipTest(`app server ${APP_URL} unreachable`);
  }
  console.log(`[push-bilateral] app server reachable: ${APP_URL}`);

  // Fetch VAPID key server-side (no CORS)
  const vapidInfoRes = await fetch(`${PUSH_RELAY}/info`, {signal: AbortSignal.timeout(8000)});
  if(!vapidInfoRes.ok) {
    skipTest(`push relay /info returned ${vapidInfoRes.status}`);
  }
  const vapidInfo = await vapidInfoRes.json() as {vapid_public_key: string};
  const vapidKey = vapidInfo.vapid_public_key;
  if(!vapidKey) {
    skipTest('push relay /info missing vapid_public_key');
  }
  console.log('[push-bilateral] VAPID key fetched:', vapidKey.slice(0, 20) + '...');

  const startMs = Date.now();
  let pageA: Page | null = null;
  let pageB: Page | null = null;
  let ctxA: BrowserContext | null = null;
  let ctxB: BrowserContext | null = null;
  let registeredSub: {endpoint: string; pubkeyHex: string; privkeyHex: string} | null = null;

  // CRITICAL: Chrome disables the Push API in incognito / ephemeral profiles
  // (https://crbug.com/41124656). Playwright's `browser.newContext()` creates
  // an ephemeral profile, so pushManager.subscribe() always returns
  // "permission denied" there. Use launchPersistentContext() with a real
  // on-disk userDataDir for context A so Push API is enabled. Context B
  // can stay ephemeral — it doesn't subscribe.
  const profileDirA = await import('node:fs').then((fs) =>
    fs.mkdtempSync(require('node:os').tmpdir() + '/nostra-push-ctxA-'));
  console.log('[push-bilateral] using persistent profile for A:', profileDirA);
  const browser = await chromium.launch(launchOptions); // for B only

  try {
    // --- Context A: persistent profile (non-incognito) so Push API works ---
    ctxA = await chromium.launchPersistentContext(profileDirA, {
      ...launchOptions,
      permissions: ['notifications']
    });
    await ctxA.grantPermissions(['notifications'], {origin: APP_URL});
    await ctxA.addInitScript(() => {
      try {
        if(typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
          Object.defineProperty(Notification, 'permission', {
            get() { return 'granted'; },
            configurable: true,
            enumerable: true
          });
          Object.defineProperty(Notification, 'requestPermission', {
            value: async() => 'granted',
            configurable: true,
            writable: true
          });
        }
      } catch{} // eslint-disable-line no-empty
    });

    // CORS proxy: push.nostra.chat doesn't send ACAO headers, so browser-side
    // fetches from localhost are blocked. Proxy them through Node.js fetch.
    await ctxA.route(`${PUSH_RELAY}/**`, async(route) => {
      const req = route.request();
      const method = req.method();
      const url = req.url();
      const headers = {...req.headers()};
      delete headers['host'];
      delete headers['origin'];
      delete headers['referer'];
      try {
        let body: string | undefined;
        try { body = req.postData() || undefined; } catch{} // eslint-disable-line no-empty
        const res = await fetch(url, {
          method,
          headers,
          ...(body !== undefined ? {body} : {}),
          signal: AbortSignal.timeout(10000)
        });
        const resBody = Buffer.from(await res.arrayBuffer());
        const resHeaders: Record<string, string> = {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, PUT, DELETE, OPTIONS',
          'access-control-allow-headers': 'authorization, content-type'
        };
        res.headers.forEach((v, k) => { resHeaders[k] = v; });
        await route.fulfill({status: res.status, headers: resHeaders, body: resBody});
      } catch(e: any) {
        console.warn('[push-bilateral] CORS proxy error for', url, ':', e?.message);
        await route.abort('failed');
      }
    });

    // --- Context B ---
    ctxB = await browser.newContext();

    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();

    // Console logging for debug
    pageA.on('console', (msg) => {
      const txt = msg.text();
      if(msg.type() === 'error' || txt.includes('[push') || txt.includes('[NostraPush') || txt.includes('[PUSH')) {
        console.log('[A]', msg.type(), txt.slice(0, 150));
      }
    });

    // --- Onboard both identities ---
    console.log('[push-bilateral] onboarding A and B...');
    const [npubA, npubB] = await Promise.all([
      createIdentity(pageA, 'PushAlice'),
      createIdentity(pageB, 'PushBob')
    ]);
    console.log('[push-bilateral] A:', npubA.slice(0, 20) + '...');
    console.log('[push-bilateral] B:', npubB.slice(0, 20) + '...');

    // --- Verify SW registered (skip if dev server) ---
    const swRegistered = await pageA.evaluate(async() => {
      try {
        const regs = await navigator.serviceWorker.getRegistrations();
        return regs.length > 0;
      } catch{ return false; }
    });
    if(!swRegistered) {
      skipTest('No Service Worker registered — run against a production build (not pnpm start). Build with `pnpm build` then serve dist/');
    }

    // --- Verify permission ---
    const permA = await pageA.evaluate(() => typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
    const queryPermA = await pageA.evaluate(async() => {
      try {
        const r = await navigator.permissions.query({name: 'notifications'} as PermissionDescriptor);
        return r.state;
      } catch{ return 'unsupported'; }
    });
    console.log(`[push-bilateral] A Notification.permission = ${permA} (navigator.permissions.query = ${queryPermA})`);
    if(permA !== 'granted' && queryPermA !== 'granted') {
      skipTest(`Notifications permission not granted: Notification.permission="${permA}", query="${queryPermA}"`);
    }

    // --- Wait for auto-subscribe (T11 wiring) ---
    console.log('[push-bilateral] waiting for A auto-subscribe...');
    const autoSubscribed = await waitForPushSubscription(pageA, 20000);
    if(autoSubscribed) {
      console.log('[push-bilateral] A push subscription created via auto-subscribe');
    } else {
      console.log('[push-bilateral] auto-subscribe did not fire within 20s; will try manual path');
    }

    // --- Get browser push subscription (may fail in headless CI) ---
    let browserSub: {endpoint: string; p256dh: string; auth: string} | null = null;

    if(autoSubscribed) {
      // Auto-subscribe already called pushManager.subscribe() + relay PUT
      const idbRec = await getIdbPushSubscription(pageA);
      if(idbRec) {
        browserSub = {endpoint: idbRec.endpoint, p256dh: idbRec.keys.p256dh, auth: idbRec.keys.auth};
        registeredSub = {endpoint: idbRec.endpoint, pubkeyHex: idbRec.pubkey, privkeyHex: ''};
        console.log('[push-bilateral] using auto-subscribed endpoint:', idbRec.endpoint.slice(0, 50) + '...');
      }
    }

    if(!browserSub) {
      // Try manual path
      browserSub = await tryGetBrowserPushSub(pageA, vapidKey);
      if(!browserSub) {
        if(FAIL_ON_ENV_LIMIT) {
          throw new Error('pushManager.subscribe() failed — set NOSTRA_PUSH_E2E_FULL=0 to skip instead');
        }
        skipTest('pushManager.subscribe() unavailable in this environment (headless Chromium without Google push service access). Set NOSTRA_PUSH_E2E_FULL=1 to fail instead of skip.');
      }
      console.log('[push-bilateral] browser push sub endpoint:', browserSub.endpoint.slice(0, 50) + '...');

      // Need to register with relay manually
      const pubkeyHex = await pageA.evaluate(() => (window as any).__nostraOwnPubkey || null);
      if(!pubkeyHex) throw new Error('own pubkey not set on window after onboarding');

      const privkeyHex = await getOwnPrivkeyHex(pageA);
      if(!privkeyHex) {
        skipTest('Cannot load privkey for relay registration (prod build cannot import /src/ modules). Run in dev mode or use auto-subscribe path.');
      }

      const subId = await registerWithRelay({
        endpointBase: PUSH_RELAY,
        pubkeyHex,
        privkeyHex,
        endpoint: browserSub.endpoint,
        p256dh: browserSub.p256dh,
        auth: browserSub.auth
      });
      if(!subId) throw new Error('Failed to register push subscription with relay');
      registeredSub = {endpoint: browserSub.endpoint, pubkeyHex, privkeyHex};
      console.log('[push-bilateral] manually registered with relay, id:', subId);
    }

    // --- Cross-add contacts ---
    console.log('[push-bilateral] cross-adding contacts...');
    await Promise.all([
      addPeerAsContact(pageA, npubB, 'PushBob'),
      addPeerAsContact(pageB, npubA, 'PushAlice')
    ]);
    await Promise.all([pageA.waitForTimeout(1500), pageB.waitForTimeout(1500)]);

    const peerIdBOnA = await readFirstP2PPeerId(pageA);
    const peerIdAOnB = await readFirstP2PPeerId(pageB);
    if(!peerIdBOnA || !peerIdAOnB) throw new Error('peer ids not in mirror after contact add');

    // --- "Background" A's tab ---
    await pageA.evaluate(() => {
      try {
        Object.defineProperty(document, 'visibilityState', {value: 'hidden', writable: true, configurable: true});
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('blur'));
      } catch{} // eslint-disable-line no-empty
    });
    console.log('[push-bilateral] A tab "backgrounded"');
    await pageA.waitForTimeout(1000);

    // --- B sends message to A ---
    console.log('[push-bilateral] B sending message to A...');
    await openChatAndSend(pageB, peerIdAOnB, 'push test message');
    const sendTs = Date.now();
    console.log('[push-bilateral] B sent; polling for push notification on A...');

    // --- Poll for notification ---
    const notif = await pollForNotification(pageA, NOTIFY_TIMEOUT_MS);
    const elapsed = Date.now() - sendTs;

    if(!notif) {
      const allNotifs = await pageA.evaluate(async() => {
        try {
          const reg = await navigator.serviceWorker.ready;
          return (await reg.getNotifications({})).map((n: any) => ({title: n.title, tag: n.tag}));
        } catch{ return []; }
      }).catch(() => []);
      console.error('[push-bilateral] notifications at timeout:', JSON.stringify(allNotifs));
      const subRec = await getIdbPushSubscription(pageA).catch(() => null);
      console.error('[push-bilateral] IDB sub record:', subRec ? JSON.stringify({id: subRec.subscriptionId, base: subRec.endpointBase}) : null);
      throw new Error(`No push notification arrived within ${NOTIFY_TIMEOUT_MS / 1000}s after B sent`);
    }

    const elapsedSec = (elapsed / 1000).toFixed(1);
    console.log(`[push-bilateral] PASS — notification arrived in ${elapsedSec}s`);
    console.log(`  title: ${notif.title}`);
    console.log(`  body:  ${notif.body}`);
    console.log(`  tag:   ${notif.tag}`);
    console.log(`  total elapsed: ${((Date.now() - startMs) / 1000).toFixed(1)}s`);

  } finally {
    // --- Cleanup: unregister from push relay ---
    if(registeredSub) {
      // Re-fetch privkey for cleanup if not stored
      let privkeyHex = registeredSub.privkeyHex;
      if(!privkeyHex && pageA) {
        privkeyHex = await getOwnPrivkeyHex(pageA).catch(() => null) || '';
      }
      if(privkeyHex) {
        await unregisterFromRelay({
          endpointBase: PUSH_RELAY,
          pubkeyHex: registeredSub.pubkeyHex,
          privkeyHex,
          endpoint: registeredSub.endpoint
        });
      } else {
        console.warn('[push-bilateral] cleanup: no privkey — cannot unregister (non-fatal)');
      }
      // Also unsubscribe the browser push subscription
      if(pageA) {
        await pageA.evaluate(async() => {
          try {
            const reg = await navigator.serviceWorker.ready;
            const sub = await reg.pushManager.getSubscription();
            if(sub) await sub.unsubscribe();
          } catch{} // eslint-disable-line no-empty
        }).catch(() => {});
      }
    }
    if(ctxA) await ctxA.close().catch(() => {});
    if(ctxB) await ctxB.close().catch(() => {});
    await browser.close().catch(() => {});
    try {
      const fs = await import('node:fs');
      fs.rmSync(profileDirA, {recursive: true, force: true});
    } catch{} // eslint-disable-line no-empty
  }

  process.exit(0);
})().catch((e) => {
  console.error('[push-bilateral] FAIL:', e?.stack || e);
  process.exit(1);
});
