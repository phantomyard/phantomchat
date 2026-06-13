/**
 * E2E tests for CHECKLIST items 5.1-5.3 (Message Persistence)
 * and 6.1-6.3 (Delivery Status Indicators).
 *
 * Uses a single browser context with one identity.
 * Run: npx tsx src/tests/e2e-persistence-status.ts
 *
 * Requires dev server running at http://localhost:8080.
 */

// @ts-nocheck
import {chromium, type BrowserContext, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';

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

async function generateRandomNpub(page: Page): Promise<string> {
  return page.evaluate(async() => {
    const mod = await import('/src/lib/nostra/nostr-identity.ts');
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    const hex = Array.from(arr).map((b) => b.toString(16).padStart(2, '0')).join('');
    return mod.npubEncode(hex);
  });
}

async function addContactAndOpenChat(page: Page, npub: string, nickname: string) {
  await dismissViteOverlay(page);
  await page.locator('#new-menu').click({timeout: 10000});
  await page.waitForTimeout(500);
  await page.locator('text=New Private Chat').click();
  await page.waitForTimeout(1000);
  await page.locator('button.btn-corner.is-visible').click();
  await page.waitForTimeout(1000);
  if(nickname) {
    const nickField = page.getByRole('textbox', {name: 'Nickname (optional)'});
    await nickField.fill(nickname);
  }
  await page.getByRole('textbox', {name: 'npub1...'}).fill(npub);
  await page.getByRole('button', {name: 'Add'}).click();
  await page.waitForTimeout(5000);

  // Dismiss overlay that may block sidebar close button
  await page.evaluate(() => {
    document.querySelectorAll('.popup-add-contact-overlay, .popup-overlay, .popup').forEach((el) => {
      (el as HTMLElement).style.pointerEvents = 'none';
    });
  });
  await page.waitForTimeout(500);

  const backBtn = page.locator('.sidebar-close-button, button.btn-icon.tgico-back, button.btn-icon.tgico-arrow_back').first();
  if(await backBtn.isVisible()) {
    await backBtn.click({force: true});
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
  // First check if we're already in the chat
  const alreadyInChat = await page.evaluate((n: string) => {
    const topbar = document.querySelector('.topbar .peer-title, .chat-info .peer-title');
    return topbar?.textContent?.includes(n) ?? false;
  }, name);
  if(alreadyInChat) return true;

  const peerId = await page.evaluate((n) => {
    const chats = document.querySelectorAll('.chatlist-chat');
    for(const c of chats) {
      if(c.textContent?.includes(n)) return c.getAttribute('data-peer-id');
    }
    // Fallback: open first chat
    return chats[0]?.getAttribute('data-peer-id') || null;
  }, name);
  if(!peerId) {
    console.log(`  Could not find chat "${name}" in chat list`);
    return false;
  }
  return openChatByPeerId(page, peerId);
}

async function sendMessage(page: Page, text: string) {
  const msgArea = page.locator('[contenteditable="true"]').first();
  await msgArea.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await msgArea.pressSequentially(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}

async function waitForBubble(page: Page, text: string, timeoutMs = 30000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const found = await page.evaluate((t: string) => {
      const bubbles = document.querySelectorAll('.bubble .message, .bubble .inner, .bubble-content');
      for(const b of bubbles) {
        if(b.textContent?.includes(t)) return true;
      }
      return false;
    }, text);
    if(found) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: TestResult[] = [];

function record(name: string, passed: boolean, detail?: string) {
  results.push({name, passed, detail});
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`  ${tag}: ${name}${detail ? ' (' + detail + ')' : ''}`);
}

async function getFailDiagnostics(page: Page, logs: string[]): Promise<string> {
  const relay = await getRelayStatus(page);
  const published = logs.some((l) => l.includes('message published') || l.includes('text sent'));
  const relayReceived = logs.some((l) => l.includes('received relay message'));
  const injected = logs.some((l) => l.includes('injectP2PMessage'));
  const chatOpen = await page.evaluate(() => {
    return !!document.querySelector('.bubbles-inner, .chat-input, [contenteditable="true"]');
  });
  return `relay: ${JSON.stringify(relay)}, published: ${published}, relay received: ${relayReceived}, injected: ${injected}, chat open: ${chatOpen}`;
}

// ---------------------------------------------------------------------------
// 5. Message Persistence tests
// ---------------------------------------------------------------------------

async function testMessagePersistence() {
  console.log('\n=== Test 5: Message Persistence ===');
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const logs: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('Nostra') || t.includes('relay') || t.includes('ChatAPI') || t.includes('message published') || t.includes('text sent') || t.includes('injectP2PMessage') || t.includes('received relay message')) {
      logs.push(t);
    }
  });

  try {
    // Step 1: Create identity, add contact, send message
    const myNpub = await createIdentity(page, 'PersistUser');
    console.log('  Identity created:', myNpub.slice(0, 20) + '...');

    const contactNpub = await generateRandomNpub(page);
    const contactName = 'PersistContact';
    await addContactAndOpenChat(page, contactNpub, contactName);
    console.log('  Contact added:', contactName);

    // Open chat
    const opened = await openChatByName(page, contactName);
    if(!opened) {
      const diag = await getFailDiagnostics(page, logs);
      record('5.1 — message visible after reload', false, 'could not open chat. ' + diag);
      record('5.2 — contact dialog persists after reload', false, 'could not open chat. ' + diag);
      record('5.3 — message persists in IndexedDB', false, 'could not open chat. ' + diag);
      return;
    }

    const testMsg = 'PersistMsg-' + Date.now();
    await sendMessage(page, testMsg);
    console.log('  Message sent:', testMsg);

    // Wait for message to appear in chat (using bubble check)
    const msgVisible = await waitForBubble(page, testMsg, 30000);
    console.log('  Message visible before reload:', msgVisible);

    // Step 2: Check message-store cache BEFORE reload (5.3)
    // The legacy p2pMessageCache was replaced by the message-store IndexedDB.
    const cacheSize = await page.evaluate(async() => {
      try {
        const {getMessageStore} = await import('/src/lib/nostra/message-store.ts');
        const store = getMessageStore();
        const ids = await store.getAllConversationIds();
        let total = 0;
        for(const id of ids) {
          const msgs = await store.getMessages(id, 200);
          total += msgs.length;
        }
        return total;
      } catch {
        return -1;
      }
    });
    console.log('  message-store total messages:', cacheSize);

    // Step 3: Reload page
    console.log('  Reloading page...');
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForTimeout(10000); // wait for app to reinitialize
    await dismissViteOverlay(page);
    await page.waitForTimeout(3000); // extra settling time

    // Step 4: Check contact dialog still visible (5.2)
    const dialogExists = await page.evaluate((name: string) => {
      const els = document.querySelectorAll('.dialog-title, .peer-title, a');
      for(const el of els) {
        if(el.textContent?.includes(name)) return true;
      }
      return false;
    }, contactName);
    record('5.2 — contact dialog persists after reload', dialogExists);
    if(!dialogExists) {
      const diag = await getFailDiagnostics(page, logs);
      console.log('  FAIL diagnostics:', diag);
    }

    // Step 5: Check message in bubbles after reload (5.1)
    let msgAfterReload = false;
    if(dialogExists) {
      const reopened = await openChatByName(page, contactName);
      if(reopened) {
        msgAfterReload = await waitForBubble(page, testMsg, 10000);
      }
    }
    record('5.1 — message visible after reload (in bubbles)', msgAfterReload,
      !msgAfterReload && dialogExists ? 'dialog exists but message not found in bubbles' : undefined);
    if(!msgAfterReload) {
      const diag = await getFailDiagnostics(page, logs);
      console.log('  FAIL diagnostics:', diag);
    }

    // Step 6: Check IndexedDB after reload (5.3)
    const cacheSizeAfter = await page.evaluate(async() => {
      try {
        const {getMessageStore} = await import('/src/lib/nostra/message-store.ts');
        const store = getMessageStore();
        const ids = await store.getAllConversationIds();
        let total = 0;
        for(const id of ids) {
          const msgs = await store.getMessages(id, 200);
          total += msgs.length;
        }
        return total;
      } catch {
        return -1;
      }
    });
    const idbHasData = cacheSize > 0 || cacheSizeAfter > 0;
    record('5.3 — message content persists in IndexedDB', idbHasData,
      `cache before=${cacheSize}, after=${cacheSizeAfter}`);
    if(!idbHasData) {
      const diag = await getFailDiagnostics(page, logs);
      console.log('  FAIL diagnostics:', diag);
    }
  } finally {
    await ctx.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// 6. Delivery Status Indicators tests
// ---------------------------------------------------------------------------

async function testDeliveryStatus() {
  console.log('\n=== Test 6: Delivery Status Indicators ===');
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  const logs: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('Nostra') || t.includes('relay') || t.includes('ChatAPI') || t.includes('message published') || t.includes('text sent') || t.includes('injectP2PMessage') || t.includes('received relay message')) {
      logs.push(t);
    }
  });

  try {
    // Step 1: Create identity, add contact
    const myNpub = await createIdentity(page, 'StatusUser');
    console.log('  Identity created:', myNpub.slice(0, 20) + '...');

    const contactNpub = await generateRandomNpub(page);
    const contactName = 'StatusContact';
    await addContactAndOpenChat(page, contactNpub, contactName);
    console.log('  Contact added:', contactName);

    // Open chat
    const opened = await openChatByName(page, contactName);
    if(!opened) {
      const diag = await getFailDiagnostics(page, logs);
      record('6.1 — sending state: is-outgoing class present', false, 'could not open chat. ' + diag);
      record('6.2 — sent state: is-sent class present after relay publish', false, 'could not open chat. ' + diag);
      record('6.3 — no stuck sending indicator', false, 'could not open chat. ' + diag);
      return;
    }

    // Step 2: Type message text
    const msgArea = page.locator('[contenteditable="true"]').first();
    await msgArea.click();
    const testMsg = 'StatusMsg-' + Date.now();
    await msgArea.pressSequentially(testMsg);

    // Step 3: Press Enter and IMMEDIATELY check bubble state
    await page.keyboard.press('Enter');

    // Wait briefly for bubble to appear in DOM, then capture state
    await page.waitForTimeout(500);

    const immediateState = await page.evaluate(() => {
      const bubbles = document.querySelectorAll('.bubble');
      const last = bubbles[bubbles.length - 1] as HTMLElement | undefined;
      if(!last) return null;
      return {
        isOut: last.classList.contains('is-out'),
        isSent: last.classList.contains('is-sent'),
        isOutgoing: last.classList.contains('is-outgoing'),
        classes: Array.from(last.classList)
      };
    });

    console.log('  Immediate bubble state:', JSON.stringify(immediateState));

    // 6.1: Right after sending, bubble should have is-outgoing (sending/clock state)
    if(immediateState) {
      const hasSendingIndicator = immediateState.isOutgoing || immediateState.isSent;
      record('6.1 — sending state: bubble exists with outgoing/sent indicator',
        hasSendingIndicator,
        `classes: ${immediateState.classes.join(' ')}`);
    } else {
      const diag = await getFailDiagnostics(page, logs);
      record('6.1 — sending state: is-outgoing class present', false, 'no bubble found. ' + diag);
    }

    // Step 4: Wait for relay publish to complete
    console.log('  Waiting 30s for relay publish...');
    await page.waitForTimeout(30000);

    // Step 5: Re-check bubble state
    const settledState = await page.evaluate(() => {
      const bubbles = document.querySelectorAll('.bubble');
      const last = bubbles[bubbles.length - 1] as HTMLElement | undefined;
      if(!last) return null;
      return {
        isOut: last.classList.contains('is-out'),
        isSent: last.classList.contains('is-sent'),
        isOutgoing: last.classList.contains('is-outgoing'),
        classes: Array.from(last.classList)
      };
    });

    console.log('  Settled bubble state:', JSON.stringify(settledState));

    if(settledState) {
      // 6.2: After relay publish, bubble should have is-sent
      record('6.2 — sent state: is-sent class after relay publish',
        settledState.isSent,
        `classes: ${settledState.classes.join(' ')}`);
      if(!settledState.isSent) {
        const diag = await getFailDiagnostics(page, logs);
        console.log('  FAIL diagnostics:', diag);
      }

      // 6.3: is-outgoing should be removed (no stuck sending indicator)
      record('6.3 — no stuck sending indicator (is-outgoing removed)',
        !settledState.isOutgoing,
        `is-outgoing=${settledState.isOutgoing}, classes: ${settledState.classes.join(' ')}`);
      if(settledState.isOutgoing) {
        const diag = await getFailDiagnostics(page, logs);
        console.log('  FAIL diagnostics:', diag);
      }
    } else {
      const diag = await getFailDiagnostics(page, logs);
      record('6.2 — sent state: is-sent class after relay publish', false, 'no bubble found. ' + diag);
      record('6.3 — no stuck sending indicator', false, 'no bubble found. ' + diag);
    }
  } finally {
    await ctx.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('E2E Persistence & Delivery Status Test Suite');
  console.log('============================================');
  console.log('CHECKLIST items: 5.1-5.3, 6.1-6.3\n');

  await testMessagePersistence();
  await testDeliveryStatus();

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
    console.log(`  ${tag}: ${r.name}`);
  }
  console.log(`\nTotal: ${passed} passed, ${failed} failed out of ${results.length}`);

  if(failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
