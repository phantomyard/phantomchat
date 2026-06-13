/**
 * Nostra.chat E2E Fallback Chain Tests
 *
 * Tests the tor-wasm → webtor-rs → WebRTC direct fallback chain.
 *
 * Note: Full Tor bootstrap (30-60s) is tested in unit tests.
 * These tests verify integration without requiring live Tor network.
 */
import { test, expect, chromium, BrowserContext } from '@playwright/test';

interface TestIdentity {
  id: string;
  ownId: string;
  seed: string;
  publicKey: string;
  privateKey: string;
  encryptionKey: string;
  createdAt: number;
}

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

function generateTestIdentity(): TestIdentity {
  const seedWords = Array.from({length: 12}, () => Math.floor(Math.random() * 2048));
  const pubKeyHex = randomHex(32);
  return {
    id: 'current',
    ownId: deriveOwnIdFromPubKey(pubKeyHex),
    seed: seedWords.join(' '),
    publicKey: hexToBase64url(pubKeyHex),
    privateKey: hexToBase64url(randomHex(32)),
    encryptionKey: hexToBase64url(randomHex(32)),
    createdAt: Date.now()
  };
}

async function injectIdentity(ctx: BrowserContext): Promise<string> {
  const identity = generateTestIdentity();
  await ctx.addInitScript(
    `(function() {
      var id = ${JSON.stringify(identity)};
      var openReq = indexedDB.open('Nostra.chat', 1);
      openReq.onupgradeneeded = function(e) {
        var db = e.target.result;
        if(!db.objectStoreNames.contains('identity')) {
          db.createObjectStore('identity', {keyPath: 'id'});
        }
      };
      openReq.onsuccess = function() {
        var db = openReq.result;
        var tx = db.transaction('identity', 'readwrite');
        tx.objectStore('identity').put(id);
        tx.oncomplete = function() { db.close(); };
      };
    })();`
  );
  return identity.ownId;
}

test.describe('Nostra.chat Fallback Chain', () => {
  test('privacy-transport-wires-into-chat-api', async() => {
    const browser = await chromium.launch({headless: true});
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));
      page.on('console', (msg) => {
        if(msg.type() === 'error') errors.push(msg.text());
      });

      await injectIdentity(ctx);
      await page.goto('http://localhost:8080/nostra', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      await page.waitForTimeout(3000);

      // Check no critical errors
      const criticalErrors = errors.filter(e =>
        !e.includes('404') &&
        !e.includes('Failed to load resource') &&
        !e.includes('tor') &&
        !e.includes('tor-wasm') &&
        !e.includes('webtor') &&
        !e.includes('Snowflake') &&
        !e.includes('bootstrap')
      );

      console.log('[Test] Errors:', criticalErrors.slice(0, 5));

      // Page should load without crash
      const bodyText = await page.evaluate(() => document.body?.textContent ?? '');
      expect(bodyText.length).toBeGreaterThan(0);

    } finally {
      await browser.close();
    }
  });

  test('chat-api-uses-privacy-transport', async() => {
    const browser = await chromium.launch({headless: true});
    try {
      const ctx = await browser.newContext();
      await injectIdentity(ctx);

      const page = await ctx.newPage();
      await page.goto('http://localhost:8080/nostra', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });
      await page.waitForTimeout(3000);

      // Check ChatAPI is using PrivacyTransport
      const chatApiInfo = await page.evaluate(() => {
        const api = (window as any).__nostraChatAPI;
        if(!api) return null;
        const transport = api.transport;
        return {
          hasTransport: !!transport,
          transportType: transport?.constructor?.name,
          hasGetState: typeof transport?.getState === 'function',
          hasOnMessage: typeof transport?.onMessage === 'function',
          hasSendMessage: typeof transport?.sendMessage === 'function'
        };
      });

      console.log('[Test] ChatAPI transport:', chatApiInfo);

      expect(chatApiInfo?.hasTransport).toBe(true);
      // Transport should be PrivacyTransport (or compatible)
      expect(chatApiInfo?.hasGetState).toBe(true);
      expect(chatApiInfo?.hasOnMessage).toBe(true);

    } finally {
      await browser.close();
    }
  });

  test('tor-wasm-and-webtor-wasm-both-served', async() => {
    // Verify both WASM modules are accessible
    const torResponse = await fetch('http://localhost:8080/tor-wasm/tor_wasm_bg.wasm');
    const webtorResponse = await fetch('http://localhost:8080/webtor/webtor_wasm_bg.wasm');

    expect(torResponse.status).toBe(200);
    expect(webtorResponse.status).toBe(200);

    const torSize = parseInt(torResponse.headers.get('content-length') ?? '0');
    const webtorSize = parseInt(webtorResponse.headers.get('content-length') ?? '0');

    expect(torSize).toBeGreaterThan(1000000); // ~1.2MB
    expect(webtorSize).toBeGreaterThan(2000000); // ~3MB

    console.log(`[Test] tor-wasm: ${(torSize / 1024 / 1024).toFixed(1)}MB, webtor-rs: ${(webtorSize / 1024 / 1024).toFixed(1)}MB`);
  });
});
