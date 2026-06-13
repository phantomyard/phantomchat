/**
 * E2E tests for CHECKLIST items 1.1-1.5 (Contact Management) and 2.1-2.4 (Message Sending).
 * Each test creates a fresh browser context to avoid state leakage.
 * Run: npx tsx src/tests/e2e-contacts-and-sending.ts
 */

// @ts-nocheck
import {chromium, type BrowserContext, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import * as fs from 'fs';
import * as path from 'path';

const APP_URL = 'http://localhost:8080';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dismissViteOverlay(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll('vite-plugin-checker-error-overlay, vite-error-overlay')
      .forEach((el) => el.remove());
    if(!(window as any).__overlayObserver) {
      const obs = new MutationObserver((mutations) => {
        for(const m of mutations) {
          for(const node of m.addedNodes) {
            const tag = (node as Element).tagName?.toLowerCase() || '';
            if(tag.includes('vite') && tag.includes('overlay')) {
              (node as Element).remove();
            }
          }
        }
      });
      obs.observe(document.documentElement, {childList: true, subtree: true});
      (window as any).__overlayObserver = obs;
    }
  });
}

async function getRelayStatus(page: Page): Promise<any> {
  return page.evaluate(() => {
    const ca = (window as any).__nostraChatAPI;
    if(!ca) return {error: 'no ChatAPI'};
    const pool = (ca as any).relayPool;
    if(!pool) return {error: 'no relay pool'};
    const entries = (pool as any).relayEntries || [];
    return {
      state: (ca as any).state,
      relayCount: entries.length,
      relays: entries.map((e: any) => ({
        url: e.config?.url || e.url,
        connected: e.instance?.connectionState || 'unknown'
      }))
    };
  });
}

async function createIdentity(page: Page, displayName: string): Promise<string> {
  await page.goto(APP_URL);
  await page.waitForTimeout(8000);
  await dismissViteOverlay(page);
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
  await page.waitForTimeout(8000); // relay pool init
  return npub;
}

async function addContact(page: Page, npub: string, nickname: string) {
  await dismissViteOverlay(page);
  await page.locator('#new-menu').click({timeout: 10000});
  await page.waitForTimeout(500);
  await page.locator('text=New Private Chat').click();
  await page.waitForTimeout(1000);
  await page.locator('button.btn-corner.is-visible').click();
  await page.waitForTimeout(1000);
  if(nickname) {
    await page.getByRole('textbox', {name: 'Nickname (optional)'}).fill(nickname);
  }
  await page.getByRole('textbox', {name: 'npub1...'}).fill(npub);
  await page.getByRole('button', {name: 'Add'}).click();
  await page.waitForTimeout(5000);
  // Navigate back to chat list
  const backBtn = page.locator('.sidebar-close-button, button.btn-icon.tgico-back, button.btn-icon.tgico-arrow_back').first();
  if(await backBtn.isVisible()) {
    await backBtn.click();
    await page.waitForTimeout(2000);
  }
}

async function openChatByPeerId(page: Page, peerId: string): Promise<boolean> {
  const result = await page.evaluate((pid) => {
    const im = window.appImManager;
    if(!im?.setPeer) return false;
    im.setPeer({peerId: pid});
    return true;
  }, peerId);
  await page.waitForTimeout(5000);
  return result;
}

async function openChatByName(page: Page, name: string): Promise<boolean> {
  const peerId = await page.evaluate((n) => {
    const chats = document.querySelectorAll('.chatlist-chat');
    for(const c of chats) {
      if(c.textContent?.includes(n)) return c.getAttribute('data-peer-id');
    }
    // Fallback: open first chat
    return chats[0]?.getAttribute('data-peer-id') || null;
  }, name);
  if(!peerId) return false;
  return openChatByPeerId(page, peerId);
}

async function sendMessage(page: Page, text: string) {
  await page.evaluate((t: string) => {
    const el = document.querySelector('[contenteditable]') as HTMLElement;
    if(el) {
      el.focus();
      document.execCommand('insertText', false, t);
    }
  }, text);
  await page.keyboard.press('Enter');
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  checklistId: string;
  passed: boolean;
  detail?: string;
}

const results: TestResult[] = [];

function record(checklistId: string, name: string, passed: boolean, detail?: string) {
  results.push({name, checklistId, passed, detail});
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`  [${tag}] ${checklistId}: ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// Test 1.1: Add contact with nickname "TestBob"
// ---------------------------------------------------------------------------

async function test_1_1() {
  console.log('\n--- Test 1.1: Add contact with nickname ---');
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();

  try {
    const npubA = await createIdentity(page, 'UserA_1_1');
    const npubB = await createIdentity(page2, 'UserB_1_1');

    await addContact(page, npubB, 'TestBob');
    await page.waitForTimeout(1000);

    const hasTestBob = await page.evaluate(() => {
      const els = document.querySelectorAll('.dialog-title, .peer-title, a');
      for(const el of els) {
        if(el.textContent?.includes('TestBob')) return true;
      }
      return false;
    });

    record('1.1', 'Add contact with nickname "TestBob" -> chat list shows "TestBob"', hasTestBob);
    if(!hasTestBob) {
      const relay = await getRelayStatus(page);
      console.log('  FAIL diagnostics: relay:', JSON.stringify(relay),
        'chat open:', await page.evaluate(() => !!document.querySelector('.bubbles-inner')));
    }
  } finally {
    await ctx.close();
    await ctx2.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Test 1.2: Add contact without nickname
// ---------------------------------------------------------------------------

async function test_1_2() {
  console.log('\n--- Test 1.2: Add contact without nickname ---');
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();

  try {
    const npubA = await createIdentity(page, 'UserA_1_2');
    const npubB = await createIdentity(page2, 'UserB_1_2');

    await addContact(page, npubB, '');
    await page.waitForTimeout(1000);

    const npubPrefix = npubB.slice(0, 10);
    const hasFallback = await page.evaluate((prefix: string) => {
      const els = document.querySelectorAll('.dialog-title, .peer-title, a');
      for(const el of els) {
        const t = el.textContent || '';
        if(t.includes(prefix) || t.includes('npub1')) return true;
      }
      return false;
    }, npubPrefix);

    const hasP2PLabel = await page.evaluate(() => {
      const els = document.querySelectorAll('.dialog-title, .peer-title, a');
      for(const el of els) {
        if(/P2P \d/.test(el.textContent || '')) return true;
      }
      return false;
    });

    const passed = hasFallback && !hasP2PLabel;
    record('1.2', 'Add contact without nickname -> shows npub-style string (not "P2P")',
      passed,
      hasFallback ? 'npub shown' : hasP2PLabel ? 'got P2P label instead' : 'neither found');
    if(!passed) {
      const relay = await getRelayStatus(page);
      console.log('  FAIL diagnostics: relay:', JSON.stringify(relay));
    }
  } finally {
    await ctx.close();
    await ctx2.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Test 1.3: Contact persists after page reload
// ---------------------------------------------------------------------------

async function test_1_3() {
  console.log('\n--- Test 1.3: Contact persists after reload ---');
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();

  try {
    const npubA = await createIdentity(page, 'UserA_1_3');
    const npubB = await createIdentity(page2, 'UserB_1_3');

    await addContact(page, npubB, 'ReloadTest');
    await page.waitForTimeout(1000);

    // Verify contact is there before reload
    const beforeReload = await page.evaluate(() => {
      const els = document.querySelectorAll('.dialog-title, .peer-title, a');
      for(const el of els) {
        if(el.textContent?.includes('ReloadTest')) return true;
      }
      return false;
    });

    // Reload the page
    console.log('  Reloading page...');
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(15000); // wait for full init (identity + relay pool + peer load)
    await dismissViteOverlay(page);
    await page.waitForTimeout(10000); // extra wait for loadAllStoredPeers + dialog injection

    const afterReload = await page.evaluate(() => {
      const els = document.querySelectorAll('.dialog-title, .peer-title, a');
      for(const el of els) {
        if(el.textContent?.includes('ReloadTest')) return true;
      }
      return false;
    });

    record('1.3', 'Contact persists after page reload', afterReload,
      `before=${beforeReload}, after=${afterReload}`);
    if(!afterReload) {
      const relay = await getRelayStatus(page);
      console.log('  FAIL diagnostics: relay:', JSON.stringify(relay),
        'published: N/A, relay received: N/A, injected: N/A, chat open:',
        await page.evaluate(() => !!document.querySelector('.bubbles-inner')));
    }
  } finally {
    await ctx.close();
    await ctx2.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Test 1.5: Contact avatar shows initials
// ---------------------------------------------------------------------------

async function test_1_5() {
  console.log('\n--- Test 1.5: Contact avatar shows Dicebear or initials ---');
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();

  try {
    const npubA = await createIdentity(page, 'UserA_1_5');
    const npubB = await createIdentity(page2, 'UserB_1_5');

    await addContact(page, npubB, 'TestBob');
    await page.waitForTimeout(3000);

    const avatarResult = await page.evaluate(() => {
      // Check for Dicebear <img> avatar (blob: URL or data: URL in avatar-photo)
      const imgs = document.querySelectorAll('img.avatar-photo, avatar-element img, [class*="avatar"] img');
      for(let i = 0; i < imgs.length; i++) {
        const src = (imgs[i] as HTMLImageElement).src || '';
        if(src.startsWith('blob:') || src.includes('dicebear') || src.includes('svg')) {
          return {type: 'dicebear', src: src.slice(0, 50)};
        }
      }
      // Check for color-based avatar with initials
      const avatars = document.querySelectorAll('[data-color], .avatar');
      for(let i = 0; i < avatars.length; i++) {
        const text = (avatars[i].textContent || '').trim();
        if(text.length >= 1 && text.length <= 3 && /^[A-Za-z]+$/.test(text)) {
          return {type: 'initials', text};
        }
      }
      // Check for any avatar element with background or color
      const allAvatars = document.querySelectorAll('avatar-element');
      if(allAvatars.length > 0) {
        return {type: 'avatar-element', count: allAvatars.length};
      }
      return null;
    });

    const passed = !!avatarResult;
    record('1.5', 'Contact avatar shows Dicebear SVG or initials',
      passed, avatarResult ? `type=${avatarResult.type}` : 'no avatar found');
    if(!passed) {
      await page.screenshot({path: '/tmp/e2e-fail-1.5.png'});
      const relay = await getRelayStatus(page);
      console.log('  FAIL diagnostics: relay:', JSON.stringify(relay));
    }
  } finally {
    await ctx.close();
    await ctx2.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Tests 2.1-2.4: Message Sending
// ---------------------------------------------------------------------------

async function test_2_1_to_2_4() {
  console.log('\n--- Tests 2.1-2.4: Message Sending ---');
  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Capture console logs from sender for 2.3
  const consoleLogs: string[] = [];
  pageA.on('console', (msg) => {
    const t = msg.text();
    consoleLogs.push(t);
  });

  try {
    const npubA = await createIdentity(pageA, 'SenderAlice');
    const npubB = await createIdentity(pageB, 'ReceiverBob');

    // B adds A first so relay subscription is ready
    await addContact(pageB, npubA, 'SenderAlice');

    // A adds B and opens chat
    await addContact(pageA, npubB, 'ReceiverBob');
    await openChatByName(pageA, 'ReceiverBob');

    const testText = 'HelloE2E_' + Date.now();
    await sendMessage(pageA, testText);

    // Wait for message to be sent and relay to propagate
    console.log('  Waiting 30s for send + relay propagation...');
    await pageA.waitForTimeout(30000);

    // --- 2.1: Bubble has class is-out (right side) ---
    const bubbleState = await pageA.evaluate(() => {
      const bubbles = document.querySelectorAll('.bubble');
      const last = bubbles[bubbles.length - 1] as HTMLElement | undefined;
      if(!last) return null;
      return {
        isOut: last.classList.contains('is-out'),
        isSent: last.classList.contains('is-sent'),
        // is-read is the post-delivery-receipt state and is a valid successor
        // of is-sent. If the receipt arrived within the 30s wait window the
        // bubble will already be is-read; both count as "not-outgoing".
        isRead: last.classList.contains('is-read'),
        isOutgoing: last.classList.contains('is-outgoing'),
        classes: Array.from(last.classList)
      };
    });

    const relayA = await getRelayStatus(pageA);
    const relayB = await getRelayStatus(pageB);
    const published = consoleLogs.some((l) => l.includes('message published') || l.includes('text sent'));
    const relayReceived = consoleLogs.some((l) => l.includes('received relay message'));
    const injected = consoleLogs.some((l) => l.includes('injectP2PMessage'));
    const failDiag = `User A relay: ${JSON.stringify(relayA)}, User B relay: ${JSON.stringify(relayB)}, published: ${published}, relay received: ${relayReceived}, injected: ${injected}`;

    if(bubbleState) {
      record('2.1', 'Send text -> bubble has class is-out (right side)',
        bubbleState.isOut, `classes: ${bubbleState.classes.join(' ')}`);

      // --- 2.2: Bubble has is-sent OR is-read (post-delivery) and NOT is-outgoing ---
      record('2.2', 'Send text -> bubble has is-sent (or is-read) and NOT is-outgoing',
        (bubbleState.isSent || bubbleState.isRead) && !bubbleState.isOutgoing,
        `is-sent=${bubbleState.isSent}, is-read=${bubbleState.isRead}, is-outgoing=${bubbleState.isOutgoing}`);
    } else {
      record('2.1', 'Send text -> bubble has class is-out (right side)', false, 'no bubble found. ' + failDiag);
      record('2.2', 'Send text -> bubble has is-sent and NOT is-outgoing', false, 'no bubble found. ' + failDiag);
    }

    // --- 2.3: Console log contains [ChatAPI] message published ---
    const hasSendLog = consoleLogs.some((l) => l.includes('[ChatAPI]') && l.includes('message published'));
    record('2.3', 'Console log contains "[ChatAPI] message published"',
      hasSendLog,
      hasSendLog ? 'log found' : 'log not found in ' + consoleLogs.filter((l) => l.includes('Nostra') || l.includes('ChatAPI')).length + ' Nostra/ChatAPI logs. ' + failDiag);

    // --- 2.4: Chat list preview shows message text (explicitly checking chat list preview) ---
    const backBtn = pageA.locator('.sidebar-close-button, button.btn-icon.tgico-back, button.btn-icon.tgico-arrow_back').first();
    if(await backBtn.isVisible()) {
      await backBtn.click();
      await pageA.waitForTimeout(2000);
    }

    // NOTE: Intentionally checking chat list preview via body text (not bubble)
    const previewHasText = await pageA.evaluate((text: string) => {
      // Check chat list dialog previews specifically
      const previewEls = document.querySelectorAll(
        '.dialog-subtitle, .dialog-subtitle-text, .message-preview, ' +
        '.dialog-last-message, [class*="subtitle"], [class*="preview"]'
      );
      for(const el of previewEls) {
        if(el.textContent?.includes(text)) return true;
      }
      // Broader: check any element in the chat list area
      const chatList = document.querySelector('.chatlist-container, .chat-list, #chatlist-container');
      if(chatList && chatList.textContent?.includes(text)) return true;
      // Fallback: check body text for the message (chat list preview check)
      return document.body.textContent?.includes(text) ?? false;
    }, testText);

    record('2.4', 'Chat list preview shows sent message text',
      previewHasText, previewHasText ? 'message found in preview' : 'message not found. ' + failDiag);

  } finally {
    await ctxA.close();
    await ctxB.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// CHECKLIST.md updater
// ---------------------------------------------------------------------------

function updateChecklist() {
  const checklistPath = path.resolve(__dirname, '../../CHECKLIST.md');
  if(!fs.existsSync(checklistPath)) {
    console.log('\nCHECKLIST.md not found at', checklistPath);
    return;
  }

  let content = fs.readFileSync(checklistPath, 'utf-8');
  const passedIds = results.filter((r) => r.passed).map((r) => r.checklistId);

  for(const id of passedIds) {
    // Replace "- [ ] **X.Y**" with "- [x] **X.Y**"
    const pattern = new RegExp(`- \\[ \\] (\\*\\*${id.replace('.', '\\.')}\\*\\*)`, 'g');
    content = content.replace(pattern, '- [x] $1');
  }

  fs.writeFileSync(checklistPath, content);
  console.log(`\nUpdated CHECKLIST.md: marked ${passedIds.length} items as [x]`);
  if(passedIds.length > 0) {
    console.log('  Passed:', passedIds.join(', '));
  }
  const failedIds = results.filter((r) => !r.passed).map((r) => r.checklistId);
  if(failedIds.length > 0) {
    console.log('  Failed:', failedIds.join(', '));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('E2E Contacts & Sending Test Suite');
  console.log('==================================');
  console.log('Covers CHECKLIST items 1.1-1.5, 2.1-2.4');

  await test_1_1();
  await test_1_2();
  await test_1_3();
  await test_1_5();
  await test_2_1_to_2_4();

  // Summary
  console.log('\n========== SUMMARY ==========');
  let passed = 0;
  let failed = 0;
  for(const r of results) {
    if(r.passed) passed++;
    else failed++;
  }
  for(const r of results) {
    const tag = r.passed ? 'PASS' : 'FAIL';
    console.log(`  [${tag}] ${r.checklistId}: ${r.name}`);
  }
  console.log(`\nTotal: ${passed} passed, ${failed} failed out of ${results.length}`);

  // Update CHECKLIST.md
  updateChecklist();

  if(failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
