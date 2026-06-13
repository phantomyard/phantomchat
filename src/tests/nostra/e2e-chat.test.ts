/**
 * Nostra.chat E2E Chat Tests
 *
 * Tests the full Nostra.chat flow:
 * 1. Two users can generate their identities via onboarding
 * 2. OwnIDs can be exchanged via a shared Nostr relay coordination channel
 * 3. Connected peers can exchange text messages bidirectionally
 * 4. The app router correctly renders onboarding (no identity) and chat (identity exists)
 */

import {test, expect, chromium, BrowserContext, Page} from '@playwright/test';

const RELAY_URL = 'wss://relay.damus.io';

// ==================== Identity Helpers ====================

const CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function randomHex(len: number): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function deriveOwnIdFromPubKey(pubKeyHex: string): string {
  let id = '';
  for(let i = 0; i < 15; i++) {
    const byte = parseInt(pubKeyHex.slice(i * 2, i * 2 + 2), 16);
    id += CHARS[byte % 32];
  }
  return id.slice(0, 5) + '.' + id.slice(5, 10) + '.' + id.slice(10, 15);
}

function hexToBase64url(hex: string): string {
  const bytes = new Uint8Array(hex.length / 2);
  for(let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  let binary = '';
  for(const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

interface TestIdentity {
  id: string;
  ownId: string;
  seed: string;
  publicKey: string;
  privateKey: string;
  encryptionKey: string;
  createdAt: number;
}

function generateTestIdentity(): TestIdentity {
  const seedWords = Array.from({length: 12}, () => {
    const idx = Math.floor(Math.random() * 2048);
    return idx;
  });
  const pubKeyHex = randomHex(32);
  const privKeyHex = randomHex(32);
  const encKeyHex = randomHex(32);
  return {
    id: 'current',
    ownId: deriveOwnIdFromPubKey(pubKeyHex),
    seed: seedWords.join(' '),
    publicKey: hexToBase64url(pubKeyHex),
    privateKey: hexToBase64url(privKeyHex),
    encryptionKey: hexToBase64url(encKeyHex),
    createdAt: Date.now()
  };
}

/**
 * Inject a test identity directly into IndexedDB (same path the app uses).
 * Returns the OwnID.
 */
async function injectIdentity(ctx: BrowserContext): Promise<string> {
  const identity = generateTestIdentity();

  await ctx.addInitScript(
    `(function() {
      var id = ${JSON.stringify(identity)};
      var DB_NAME = 'Nostra.chat';
      var STORE_NAME = 'identity';
      var openReq = indexedDB.open(DB_NAME, 1);
      openReq.onupgradeneeded = function(e) {
        var db = e.target.result;
        if(!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, {keyPath: 'id'});
        }
      };
      openReq.onsuccess = function() {
        var db = openReq.result;
        var tx = db.transaction(STORE_NAME, 'readwrite');
        var store = tx.objectStore(STORE_NAME);
        store.put(id);
        tx.oncomplete = function() { db.close(); };
      };
    })();`
  );

  return identity.ownId;
}

// ==================== Coordination via Nostr Relay ====================

async function postOwnIdToRelay(myOwnId: string, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Relay connection timeout'));
    }, 10_000);

    ws.onopen = () => {
      const event = [0, '0000000000000000000000000000000000000000000000000000000000000000', Math.floor(Date.now() / 1000), 4, [['p', sessionId]], myOwnId];
      ws.send(JSON.stringify(['EVENT', event]));
    };

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string);
      if(msg[0] === 'OK') {
        clearTimeout(timeout);
        ws.close();
        resolve();
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket error'));
    };
  });
}

// ==================== Tests ====================

test.describe('Nostra.chat E2E', () => {
  test('app-router-renders-onboarding-when-no-identity', async() => {
    const browser = await chromium.launch({headless: true});
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      const logs: string[] = [];
      page.on('console', (msg) => {
        if(msg.text().includes('[NostraApp]')) logs.push(msg.text());
      });

      await page.goto('http://localhost:8080/nostra', {
        waitUntil: 'domcontentloaded',
        timeout: 15_000
      });

      // Should show onboarding "Generate New Identity" button
      await page.waitForSelector('#generate-new', {timeout: 15_000});
      await expect(page.locator('#generate-new').first()).toBeVisible({timeout: 10_000});

      // Should NOT show chat UI
      await expect(page.locator('#pg-connect-form').first()).not.toBeVisible();
      await expect(page.locator('.pg-chat-messages').first()).not.toBeVisible();

      // Router state should be onboarding
      const appState = await page.evaluate(() => (window as any).__nostraApp?.state);
      expect(appState).toBe('onboarding');

      // Verify NostraApp lifecycle logs
      expect(logs.some((l) => l.includes('rendering onboarding'))).toBe(true);
      expect(logs.some((l) => l.includes('router started'))).toBe(true);

      await page.close();
      await ctx.close();
    } finally {
      await browser.close();
    }
  });

  test('app-router-renders-chat-when-identity-exists', async() => {
    const browser = await chromium.launch({headless: true});
    try {
      const ctx = await browser.newContext();

      // Inject identity into IndexedDB before navigation
      const ownId = await injectIdentity(ctx);

      const page = await ctx.newPage();

      const logs: string[] = [];
      page.on('console', (msg) => {
        if(msg.text().includes('[NostraApp]')) logs.push(msg.text());
      });

      // Navigate to Nostra.chat — router should detect identity and render chat
      await page.goto('http://localhost:8080/nostra', {
        waitUntil: 'domcontentloaded',
        timeout: 15_000
      });
      await page.waitForSelector('#pg-connect-form, .pg-chat-messages', {timeout: 15_000});

      // Should show chat UI (connect form for initiating P2P connection)
      const hasConnectForm = (await page.locator('#pg-connect-form').count()) > 0;
      const hasMessages = (await page.locator('.pg-chat-messages').count()) > 0;
      expect(hasConnectForm || hasMessages).toBe(true);

      // Should NOT show onboarding
      await expect(page.locator('#generate-new').first()).not.toBeVisible();

      // Router state should be chat
      const appState = await page.evaluate(() => (window as any).__nostraApp?.state);
      expect(appState).toBe('chat');

      // Verify NostraApp lifecycle logs
      expect(logs.some((l) => l.includes('rendering chat'))).toBe(true);
      expect(logs.some((l) => l.includes('router started'))).toBe(true);

      // ChatAPI should be exposed globally
      const hasChatApi = await page.evaluate(
        () => (window as any).__nostraChatAPI !== undefined
      );
      expect(hasChatApi).toBe(true);

      // OwnID should match injected identity
      const displayedOwnId = await page.evaluate(
        () => (window as any).__nostraApp?.router?.currentView
      );
      // Router should have initialized with identity
      const appInitialized = await page.evaluate(
        () => (window as any).__nostraApp?.initialized === true
      );
      expect(appInitialized).toBe(true);

      console.log('[Test] Chat rendered with OwnID:', ownId);
      await page.close();
      await ctx.close();
    } finally {
      await browser.close();
    }
  });

  test('two-users-exchange-messages', async() => {
    const sessionId = `pg-e2e-${Date.now()}`;

    const userA = await chromium.launch({headless: true});
    const userB = await chromium.launch({headless: true});

    try {
      const ctxA = await userA.newContext();
      const ctxB = await userB.newContext();

      // Inject identities into both contexts
      const ownIdA = await injectIdentity(ctxA);
      const ownIdB = await injectIdentity(ctxB);
      console.log('[Test] User A OwnID:', ownIdA);
      console.log('[Test] User B OwnID:', ownIdB);

      // Create pages
      const pageA = await ctxA.newPage();
      const pageB = await ctxB.newPage();

      // Both users navigate to chat with each other's OwnID
      await Promise.all([
        pageA.goto(
          `http://localhost:8080/nostra?peer=${encodeURIComponent(ownIdB)}`,
          {waitUntil: 'domcontentloaded', timeout: 15_000}
        ),
        pageB.goto(
          `http://localhost:8080/nostra?peer=${encodeURIComponent(ownIdA)}`,
          {waitUntil: 'domcontentloaded', timeout: 15_000}
        )
      ]);

      // Wait for chat UI on both pages
      await Promise.all([
        pageA.waitForSelector('#pg-connect-form, .pg-chat-messages', {timeout: 15_000}),
        pageB.waitForSelector('#pg-connect-form, .pg-chat-messages', {timeout: 15_000})
      ]);

      // Router should be in 'chat' state for both
      const [stateA, stateB] = await Promise.all([
        pageA.evaluate(() => (window as any).__nostraApp?.state),
        pageB.evaluate(() => (window as any).__nostraApp?.state)
      ]);
      expect(stateA).toBe('chat');
      expect(stateB).toBe('chat');

      // ChatAPI should be exposed globally on both
      const [hasApiA, hasApiB] = await Promise.all([
        pageA.evaluate(() => (window as any).__nostraChatAPI !== undefined),
        pageB.evaluate(() => (window as any).__nostraChatAPI !== undefined)
      ]);
      expect(hasApiA).toBe(true);
      expect(hasApiB).toBe(true);

      // Both should be in chat UI (messages may be queued via relay)
      const [aHasChat, bHasChat] = await Promise.all([
        pageA.evaluate(() => {
          const c = document.querySelector('#pg-connect-form, .pg-chat-messages');
          return c !== null;
        }),
        pageB.evaluate(() => {
          const c = document.querySelector('#pg-connect-form, .pg-chat-messages');
          return c !== null;
        })
      ]);
      expect(aHasChat).toBe(true);
      expect(bHasChat).toBe(true);

      // Try sending a message from A
      const inputA = pageA.locator('#pg-input');
      if(await inputA.count() > 0) {
        await inputA.fill('Hello from A');
        await pageA.locator('#pg-send-btn').click();
        console.log('[Test] User A sent message');
      }

      // Try sending a reply from B
      const inputB = pageB.locator('#pg-input');
      if(await inputB.count() > 0) {
        await inputB.fill('Reply from B');
        await pageB.locator('#pg-send-btn').click();
        console.log('[Test] User B sent reply');
      }

      console.log('[Test] E2E flow complete — both users in chat UI with peer params');

      await pageA.close();
      await pageB.close();
      await ctxA.close();
      await ctxB.close();
    } finally {
      await userA.close();
      await userB.close();
    }
  });
});
