/**
 * Nostra.chat E2E UI Flow Tests
 *
 * Tests the onboarding → chat container transitions.
 * Verifies no overlapping containers during navigation.
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

async function injectIdentity(ctx: BrowserContext): Promise<void> {
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
}

function countContainers(page: any): { onboarding: number; chat: number } {
  return page.evaluate(() => {
    return {
      onboarding: document.querySelectorAll('.nostra-onboarding-wrapper').length,
      chat: document.querySelectorAll('.pg-chat-page').length
    };
  });
}

test.describe('Nostra.chat UI Flow — No Overlapping Containers', () => {
  test('app-router-renders-onboarding-when-no-identity', async() => {
    const browser = await chromium.launch({headless: true});
    try {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();

      await page.goto('http://localhost:8080/nostra', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Should show onboarding
      await page.waitForSelector('#generate-new', {timeout: 15000});

      // Only onboarding container should be present
      const containers = await countContainers(page);
      expect(containers.onboarding).toBe(1);
      expect(containers.chat).toBe(0);

      // Onboarding content should be visible
      const title = await page.locator('h1').textContent();
      expect(title).toContain('Nostra.chat');

    } finally {
      await browser.close();
    }
  });

  test('chat-renders-without-overlapping-onboarding', async() => {
    const browser = await chromium.launch({headless: true});
    try {
      const ctx = await browser.newContext();
      await injectIdentity(ctx);

      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('console', (msg) => {
        if(msg.type() === 'error') errors.push(msg.text());
      });

      await page.goto('http://localhost:8080/nostra', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      // Wait for chat to render
      await page.waitForSelector('#pg-connect-form, .pg-chat-messages', {timeout: 15000});

      // Check no overlapping containers
      const containers = await countContainers(page);
      expect(containers.onboarding).toBe(0);
      expect(containers.chat).toBe(1);

      // No critical errors
      const criticalErrors = errors.filter(e =>
        !e.includes('404') &&
        !e.includes('Failed to load resource') &&
        !e.includes('tor') &&
        !e.includes('bootstrap')
      );
      expect(criticalErrors).toHaveLength(0);

    } finally {
      await browser.close();
    }
  });

  test('peer-url-loads-without-crash', async() => {
    const browser = await chromium.launch({headless: true});
    try {
      const ctx = await browser.newContext();
      await injectIdentity(ctx);

      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (err) => errors.push(err.message));

      await page.goto('http://localhost:8080/nostra?peer=AAAAA.BBBBB.CCCCC', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      });

      await page.waitForTimeout(3000);

      // App should not crash — body should have content
      const bodyText = await page.evaluate(() => document.body?.textContent ?? '');
      expect(bodyText.length).toBeGreaterThan(0);

      // Only chat container
      const containers = await countContainers(page);
      expect(containers.onboarding).toBe(0);
      expect(containers.chat).toBeLessThanOrEqual(1);

    } finally {
      await browser.close();
    }
  });
});
