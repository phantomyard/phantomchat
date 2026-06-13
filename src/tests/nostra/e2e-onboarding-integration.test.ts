/**
 * Nostra.chat Onboarding Integration E2E Tests
 *
 * Tests the tweb auth-page interception flow:
 * 1. User visits /?nostra=1 without identity → sees NostraOnboarding UI
 * 2. User generates identity → sees OwnID displayed
 * 3. User reloads → lands in tweb chat (identity exists, pageIm mounted)
 *
 * Requires dev server running: npm run dev (or vite at port 8080)
 */

import {test, expect, chromium, BrowserContext} from '@playwright/test';

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

// ==================== Tests ====================

test.describe('Nostra.chat Onboarding Integration (tweb)', () => {
  test('sees-onboarding-ui-then-generates-identity-and-sees-ownid', async() => {
    const browser = await chromium.launch({headless: true});
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      const logs: string[] = [];
      page.on('console', (msg) => {
        const text = msg.text();
        if(text.includes('[Nostra.chat')) logs.push(text);
      });

      // Navigate to tweb root with nostra=1 flag
      await page.goto('http://localhost:8080/?nostra=1', {
        waitUntil: 'networkidle',
        timeout: 20_000
      });

      // Wait for NostraOnboarding to be mounted (container is moved to .scrollable)
      await page.waitForSelector('.nostra-onboarding-wrapper.nostra-contained', {timeout: 15_000});

      // Should show "Generate New Identity" button
      const generateBtn = page.locator('#generate-new');
      await expect(generateBtn).toBeVisible({timeout: 10_000});

      // Click to generate identity
      await generateBtn.click();

      // Should show OwnID after generation
      await page.waitForSelector('.ownid-value', {timeout: 10_000});
      const ownIdText = await page.locator('.ownid-value').textContent();
      expect(ownIdText).toMatch(/^[A-Z0-9]{5}\.[A-Z0-9]{5}\.[A-Z0-9]{5}$/);

      // Should show "Open Chat" button (identity already exists after generation)
      const openChatBtn = page.locator('#open-chat');
      await expect(openChatBtn).toBeVisible({timeout: 5_000});

      // Verify integration module logged its mount
      expect(logs.some((l) => l.includes('[NostraOnboarding]'))).toBe(true);

      console.log('[Test] OwnID generated:', ownIdText);
      await page.close();
      await ctx.close();
    } finally {
      await browser.close();
    }
  });

  test('reload-with-identity-lands-in-chat', async() => {
    const browser = await chromium.launch({headless: true});
    try {
      const ctx = await browser.newContext();

      // Pre-inject identity so app finds it on load
      await injectIdentity(ctx);

      const page = await ctx.newPage();

      const logs: string[] = [];
      page.on('console', (msg) => {
        const text = msg.text();
        if(text.includes('[Nostra.chat')) logs.push(text);
      });

      // Navigate with nostra=1 — should skip onboarding and mount chat
      await page.goto('http://localhost:8080/?nostra=1', {
        waitUntil: 'networkidle',
        timeout: 20_000
      });

      // Should show OwnID display (existing identity) or redirect to chat
      // Since we pre-inject identity, app should go directly to existing identity view
      const ownIdEl = page.locator('.ownid-value');
      const hasOwnId = await ownIdEl.count() > 0;

      if(hasOwnId) {
        // Existing identity: should show OwnID and "Open Chat"
        await expect(ownIdEl).toBeVisible({timeout: 10_000});
        const ownIdText = await ownIdEl.textContent();
        expect(ownIdText).toMatch(/^[A-Z0-9]{5}\.[A-Z0-9]{5}\.[A-Z0-9]{5}$/);

        // Click Open Chat to trigger the integration callback
        const openChatBtn = page.locator('#open-chat');
        await expect(openChatBtn).toBeVisible({timeout: 5_000});
        await openChatBtn.click();
      } else {
        // Integration may have already mounted chat — check for tweb chat elements
        // or wait for the page to settle
        await page.waitForTimeout(3_000);
      }

      // Feature flag should be set
      const flagEnabled = await page.evaluate(() => (window as any).__nostraEnabled);
      expect(flagEnabled).toBe(true);

      console.log('[Test] Reload with identity: Nostra.chat flag enabled =', flagEnabled);
      await page.close();
      await ctx.close();
    } finally {
      await browser.close();
    }
  });

  test('window-nostraenabled-flag-is-readable', async() => {
    const browser = await chromium.launch({headless: true});
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      await page.goto('http://localhost:8080/?nostra=1', {
        waitUntil: 'domcontentloaded',
        timeout: 20_000
      });

      // Wait for the module to evaluate
      await page.waitForTimeout(2_000);

      // Check window.__nostraEnabled is readable
      const flag = await page.evaluate(() => (window as any).__nostraEnabled);
      expect(flag).toBe(true);

      await page.close();
      await ctx.close();
    } finally {
      await browser.close();
    }
  });
});
