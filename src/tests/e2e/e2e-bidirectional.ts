/**
 * E2E tests for CHECKLIST items 3.1-3.5 (Message Receiving) and 4.1-4.3 (Bidirectional Messaging).
 *
 * Uses TWO separate browser contexts to simulate two independent identities
 * communicating via Nostr relays.
 *
 * Run: npx tsx src/tests/e2e-bidirectional.ts
 *
 * Prerequisites:
 *   - Dev server running at http://localhost:8080 (pnpm start)
 *   - Playwright installed (pnpm add -D playwright)
 */

// @ts-nocheck
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = 'http://localhost:8080';
const RELAY_PROPAGATION_MS = 5000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function dismissViteOverlay(page: Page) {
  await dismissOverlays(page);
  await page.evaluate(() => {
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

async function getFullDiagnostics(
  pageA: Page, pageB: Page, logsA: string[], logsB: string[]
): Promise<string> {
  const relayA = await getRelayStatus(pageA);
  const relayB = await getRelayStatus(pageB);
  const published = logsA.some((l) => l.includes('message published') || l.includes('text sent'));
  const relayReceived = logsB.some((l) => l.includes('received relay message'));
  const injected = logsB.some((l) => l.includes('injectP2PMessage'));
  const chatOpen = await pageB.evaluate(() => {
    return !!document.querySelector('.bubbles-inner, .chat-input, [contenteditable="true"]');
  });
  return [
    `User A relay: ${JSON.stringify(relayA)}`,
    `User B relay: ${JSON.stringify(relayB)}`,
    `published: ${published}`,
    `relay received: ${relayReceived}`,
    `display bridge injected: ${injected}`,
    `chat open on receiver: ${chatOpen}`
  ].join(', ');
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
  const msgArea = page.locator('[contenteditable="true"]').first();
  await msgArea.click();
  // Clear any previous draft before typing (CLAUDE.md note: pressSequentially
  // does not clear the input, so consecutive sends concatenate otherwise).
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await msgArea.pressSequentially(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}

/**
 * Poll for a message to appear specifically inside a chat bubble element.
 */
async function waitForBubble(page: Page, text: string, timeoutMs = 10000): Promise<boolean> {
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

/**
 * Poll for a message in chat list preview (explicitly labeled as preview check).
 */
async function waitForChatListPreview(page: Page, text: string, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const found = await page.evaluate((t: string) => {
      // Check chat list preview elements specifically
      const previewEls = document.querySelectorAll(
        '.dialog-subtitle, .dialog-subtitle-text, .message-preview, ' +
        '.dialog-last-message, [class*="subtitle"], [class*="preview"]'
      );
      for(const el of previewEls) {
        if(el.textContent?.includes(t)) return true;
      }
      const chatList = document.querySelector('.chatlist-container, .chat-list, #chatlist-container');
      if(chatList && chatList.textContent?.includes(t)) return true;
      return false;
    }, text);
    if(found) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

/**
 * Check whether a bubble containing `text` has the given CSS class.
 */
async function bubbleHasClass(page: Page, text: string, className: string): Promise<boolean> {
  return page.evaluate(({t, cls}: {t: string; cls: string}) => {
    const allBubbles = document.querySelectorAll('.bubble');
    for(const bubble of allBubbles) {
      const inner = bubble.querySelector('.message, .inner, .bubble-content');
      if(inner && inner.textContent?.includes(t)) {
        return bubble.classList.contains(cls);
      }
    }
    return false;
  }, {t: text, cls: className});
}

/**
 * Wait for a bubble to appear. Local relay has <100ms latency, so a single
 * 10s wait is sufficient (no multi-round retries needed).
 */
async function waitForBubbleWithRetry(
  page: Page, text: string, _senderLogs: string[]
): Promise<boolean> {
  return waitForBubble(page, text, 10000);
}

/**
 * Wait until ChatAPI has at least 1 connected relay. With local relay
 * this resolves in <1s — replaces the old >= 2 check that always timed out.
 */
async function waitForChatAPIReady(page: Page, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const ok = await page.evaluate(() => {
      const ca = (window as any).__nostraChatAPI;
      if(!ca) return false;
      const entries = ca.relayPool?.relayEntries || [];
      const connected = entries.filter((e: any) => e.instance?.connectionState === 'connected').length;
      return connected >= 1;
    });
    if(ok) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

interface TestResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  detail?: string;
}

const results: TestResult[] = [];

function record(id: string, name: string, status: 'PASS' | 'FAIL', detail?: string) {
  results.push({id, name, status, detail});
  console.log(`  [${status}] ${id}: ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  console.log('E2E Bidirectional Messaging Test Suite');
  console.log('CHECKLIST items 3.1-3.5, 4.1-4.3');
  console.log('======================================\n');

  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await relay.injectInto(ctxA);
  await relay.injectInto(ctxB);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Capture relay-relevant console logs for diagnostics
  const logsA: string[] = [];
  const logsB: string[] = [];
  pageA.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('[ChatAPI]') || t.includes('[NostrRelay]') || t.includes('[NostraSync]') || t.includes('[NostraOnboarding') || t.includes('[VirtualMTProto') || t.includes('message published') || t.includes('text sent') || t.includes('history_append')) {
      logsA.push(`[A] ${t}`);
    }
  });
  pageB.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('[ChatAPI]') || t.includes('[NostrRelay]') || t.includes('[NostraSync]') || t.includes('[NostraOnboarding') || t.includes('[VirtualMTProto') || t.includes('message published') || t.includes('text sent') || t.includes('history_append') || t.includes('isKnownContact') || t.includes('onMessage callback') || t.includes('nostra_new_message') || t.includes('unknown sender')) {
      logsB.push(`[B] ${t}`);
    }
  });

  try {
    // =====================================================================
    // Setup: create two identities
    // =====================================================================
    console.log('=== Setup: Creating identities ===');
    const npubA = await createIdentity(pageA, 'Alice');
    const npubB = await createIdentity(pageB, 'Bobby');
    console.log(`  User A (Alice): ${npubA.slice(0, 24)}...`);
    console.log(`  User B (Bobby): ${npubB.slice(0, 24)}...`);

    if(!npubA || !npubB) {
      console.error('FATAL: Failed to create identities');
      process.exit(1);
    }

    // =====================================================================
    // Setup: User B adds User A as contact FIRST (so B subscribes to relay
    // messages from A before A sends anything).
    // =====================================================================
    console.log('\n=== Setup: User B adds User A as contact ===');
    await addContact(pageB, npubA, 'Alice');
    console.log('  User B added Alice as contact');

    // User A adds User B as contact
    console.log('\n=== Setup: User A adds User B as contact ===');
    await addContact(pageA, npubB, 'Bob');
    console.log('  User A added Bob as contact');

    // =====================================================================
    // Test 3.5: Send message BEFORE User B opens chat
    // (cached messages loaded via requestHistory P2P intercept)
    // =====================================================================
    console.log('\n=== Test 3.5: Message sent before recipient opens chat ===');

    // User A opens chat with Bob and sends
    await openChatByName(pageA, 'Bob');
    const msg35 = 'Pre-open message ' + Date.now();
    await sendMessage(pageA, msg35);
    console.log(`  User A sent: "${msg35}"`);
    console.log('  Waiting 5s for relay propagation...');
    await pageA.waitForTimeout(RELAY_PROPAGATION_MS);

    // NOW User B opens the chat — the message should appear from cache/history
    const openedB35 = await openChatByName(pageB, 'Alice');
    if(openedB35) {
      await pageB.waitForTimeout(3000); // let bubbles render
      const bubbleFound35 = await waitForBubbleWithRetry(pageB, msg35, logsA);
      if(bubbleFound35) {
        record('3.5', 'Open chat AFTER message received -> bubble appears', 'PASS');
      } else {
        const diag = await getFullDiagnostics(pageA, pageB, logsA, logsB);
        const published = logsA.some((l) => l.includes('message published') || l.includes('text sent'));
        record('3.5', 'Open chat AFTER message received -> bubble appears', 'FAIL',
          published
            ? 'FAIL: message published to relay but not received after 30s. ' + diag
            : 'FAIL: message was not published. ' + diag);
      }
    } else {
      const diag = await getFullDiagnostics(pageA, pageB, logsA, logsB);
      record('3.5', 'Open chat AFTER message received -> bubble appears', 'FAIL',
        'could not open Alice chat on User B. ' + diag);
    }

    // Navigate User B back to chat list for subsequent tests
    const backBtnB = pageB.locator('.sidebar-close-button, button.btn-icon.tgico-back, button.btn-icon.tgico-arrow_back').first();
    if(await backBtnB.isVisible()) {
      await backBtnB.click();
      await pageB.waitForTimeout(1000);
    }

    // =====================================================================
    // Test 3.1 & 3.2 & 3.3: User A sends -> User B sees preview + bubble
    // =====================================================================
    console.log('\n=== Tests 3.1-3.3: Message receiving (preview, bubble, is-in) ===');

    const msg31 = 'Hello Bobby! ' + Date.now();
    // Ensure User A is in Bob's chat
    await openChatByName(pageA, 'Bob');
    await sendMessage(pageA, msg31);
    console.log(`  User A sent: "${msg31}"`);
    console.log('  Waiting 5s for relay propagation...');

    // --- 3.1: Check chat list preview on User B (explicitly a chat list preview check) ---
    const previewFound = await waitForChatListPreview(pageB, msg31, 10000);
    if(previewFound) {
      record('3.1', 'Received message appears in chat list preview', 'PASS');
    } else {
      const diag = await getFullDiagnostics(pageA, pageB, logsA, logsB);
      const published = logsA.some((l) => l.includes('message published') || l.includes('text sent'));
      record('3.1', 'Received message appears in chat list preview', 'FAIL',
        published
          ? 'FAIL: message published to relay but not received after 30s. ' + diag
          : 'FAIL: message was not published. ' + diag);
    }

    // --- 3.2: Open chat on User B and check bubble ---
    const openedB32 = await openChatByName(pageB, 'Alice');
    let bubbleFound32 = false;
    if(openedB32) {
      bubbleFound32 = await waitForBubble(pageB, msg31, 10000);
    }
    if(bubbleFound32) {
      record('3.2', 'Received message appears as BUBBLE in chat', 'PASS');
    } else {
      const diag = await getFullDiagnostics(pageA, pageB, logsA, logsB);
      record('3.2', 'Received message appears as BUBBLE in chat', 'FAIL',
        previewFound
          ? 'message in preview but not found in bubble element. ' + diag
          : 'message not received at all. ' + diag);
    }

    // --- 3.3: Received bubble has class `is-in` (left side) ---
    if(bubbleFound32) {
      const isIn = await bubbleHasClass(pageB, msg31, 'is-in');
      if(isIn) {
        record('3.3', 'Received bubble has class is-in (left side)', 'PASS');
      } else {
        const diag = await getFullDiagnostics(pageA, pageB, logsA, logsB);
        record('3.3', 'Received bubble has class is-in (left side)', 'FAIL',
          'bubble found but missing is-in class. ' + diag);
      }
    } else {
      const diag = await getFullDiagnostics(pageA, pageB, logsA, logsB);
      record('3.3', 'Received bubble has class is-in (left side)', 'FAIL',
        'bubble not found — cannot verify class. ' + diag);
    }

    // =====================================================================
    // Tests 4.1, 4.2, 4.3: Bidirectional messaging
    // =====================================================================
    console.log('\n=== Tests 4.1-4.3: Bidirectional messaging ===');

    // Ensure both users have the chat open
    // Navigate A to chat with Bob
    await openChatByName(pageA, 'Bob');
    // For B, reload page first to get clean state (avoids stale chat state from test 3)
    await pageB.reload({waitUntil: 'domcontentloaded'});
    await pageB.waitForTimeout(8000);
    await dismissViteOverlay(pageB);
    await pageB.waitForTimeout(5000);
    await openChatByName(pageB, 'Alice');
    // Wait for ChatAPI relay subscriptions to be ready on both sides
    await waitForChatAPIReady(pageA, 10000);
    await waitForChatAPIReady(pageB, 10000);
    // Give subscription events time to propagate through the pipeline
    await pageA.waitForTimeout(8000);
    await pageB.waitForTimeout(8000);

    // --- 4.1: User A sends "Hello B!" -> B receives bubble ---
    await dismissViteOverlay(pageA);
    await dismissViteOverlay(pageB);
    const msg41 = 'Hello B! ' + Date.now();
    await sendMessage(pageA, msg41);
    console.log(`  User A sent: "${msg41}"`);
    console.log('  Waiting 5s for relay propagation...');

    const bGotBubble41 = await waitForBubbleWithRetry(pageB, msg41, logsA);
    if(bGotBubble41) {
      record('4.1', 'User A sends "Hello B!" -> B receives bubble', 'PASS');
    } else {
      const diag = await getFullDiagnostics(pageA, pageB, logsA, logsB);
      const published = logsA.some((l) => l.includes('message published') || l.includes('text sent'));
      record('4.1', 'User A sends "Hello B!" -> B receives bubble', 'FAIL',
        published
          ? 'FAIL: message published to relay but not received after 30s. ' + diag
          : 'FAIL: message was not published. ' + diag);
    }

    // --- 4.2: User B sends "Hello A!" -> A receives bubble ---
    const msg42 = 'Hello A! ' + Date.now();
    await sendMessage(pageB, msg42);
    console.log(`  User B sent: "${msg42}"`);
    console.log('  Waiting 5s for relay propagation...');

    const aGotBubble42 = await waitForBubbleWithRetry(pageA, msg42, logsB);
    if(aGotBubble42) {
      record('4.2', 'User B sends "Hello A!" -> A receives bubble', 'PASS');
    } else {
      const diag = await getFullDiagnostics(pageB, pageA, logsB, logsA);
      const published = logsB.some((l) => l.includes('message published') || l.includes('text sent'));
      record('4.2', 'User B sends "Hello A!" -> A receives bubble', 'FAIL',
        published
          ? 'FAIL: message published to relay but not received after 30s. ' + diag
          : 'FAIL: message was not published. ' + diag);
    }

    // --- 4.3: Both directions verified in same session ---
    const both41 = results.find((r) => r.id === '4.1');
    const both42 = results.find((r) => r.id === '4.2');
    const bothPassed = both41?.status === 'PASS' && both42?.status === 'PASS';

    if(bothPassed) {
      record('4.3', 'Both directions verified in same session', 'PASS');
    } else {
      const diag = await getFullDiagnostics(pageA, pageB, logsA, logsB);
      record('4.3', 'Both directions verified in same session', 'FAIL',
        `A->B: ${both41?.status}, B->A: ${both42?.status}. ${diag}`);
    }

    // =====================================================================
    // Diagnostics
    // =====================================================================
    console.log('\n=== Relay diagnostics ===');
    const relayA = await getRelayStatus(pageA);
    const relayB = await getRelayStatus(pageB);
    console.log('  User A relays:', JSON.stringify(relayA, null, 2));
    console.log('  User B relays:', JSON.stringify(relayB, null, 2));

    // Logs are printed in finally block (filtered)
  } catch(err) {
    console.error('E2E test error:', err);
  } finally {
    // Always print diagnostic logs, even on error — filter out noisy relay state events
    const filterNoise = (l: string) =>
      !l.includes('MTPROTO') && !l.includes('relay_state') && !l.includes('nostra_relay_state');
    console.log('\n=== User A relevant logs (filtered) ===');
    logsA.filter(filterNoise).forEach((l) => console.log('  ' + l));
    console.log('\n=== User B relevant logs (filtered) ===');
    logsB.filter(filterNoise).forEach((l) => console.log('  ' + l));

    await relay.stop();
    await ctxA.close();
    await ctxB.close();
    await browser.close();
  }

  // =====================================================================
  // Summary
  // =====================================================================
  console.log('\n========== SUMMARY ==========');
  let passed = 0;
  let failed = 0;
  for(const r of results) {
    if(r.status === 'PASS') passed++;
    else failed++;
  }
  for(const r of results) {
    console.log(`  [${r.status}] ${r.id}: ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
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
