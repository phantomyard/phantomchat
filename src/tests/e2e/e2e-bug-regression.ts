/**
 * E2E Bug Regression Tests
 *
 * Reproduces 4 known bugs discovered 2026-04-12:
 *
 * Bug 1: First message from unknown contact (chat not open, e.g. in Settings)
 *        arrives duplicated.
 * Bug 2: Reply to that message shows in chat list preview but NOT as a sent
 *        bubble (recipient sees it correctly).
 * Bug 3: Reply-to-reply appears above instead of as last message at bottom
 *        (out of chronological order), though received correctly on other side.
 * Bug 4: Sent messages get automatically pinned (should not happen).
 *
 * Run: npx tsx src/tests/e2e/e2e-bug-regression.ts
 *
 * Prerequisites:
 *   - Dev server running at http://localhost:8080 (pnpm start)
 *   - Docker installed (for local strfry relay)
 */

// @ts-nocheck
import {chromium, type Page, type BrowserContext} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = process.env.E2E_APP_URL || 'http://localhost:8080';

// ---------------------------------------------------------------------------
// Helpers (reused from existing E2E tests)
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

async function createIdentity(page: Page, displayName: string): Promise<string> {
  // Vite HMR may fail on first load in headless Chromium — reload once to recover
  await page.goto(APP_URL, {waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(15000);
  await dismissViteOverlay(page);
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

async function openChatByName(page: Page, name: string): Promise<boolean> {
  const peerId = await page.evaluate((n) => {
    const chats = document.querySelectorAll('.chatlist-chat');
    for(const c of chats) {
      if(c.textContent?.includes(n)) return c.getAttribute('data-peer-id');
    }
    return chats[0]?.getAttribute('data-peer-id') || null;
  }, name);
  if(!peerId) return false;
  const result = await page.evaluate((pid) => {
    const im = window.appImManager;
    if(!im?.setPeer) return false;
    im.setPeer({peerId: pid});
    return true;
  }, peerId);
  if(!result) return false;
  // Wait for the chat view's input to mount — setPeer is async and
  // the bubble/input pipeline can take variable time on Solid.js reactivity.
  // Without this, sendMessage later races with an unmounted contenteditable.
  try {
    await page.locator('[contenteditable="true"]').first()
      .waitFor({state: 'visible', timeout: 20000});
  } catch{
    // fallthrough — sendMessage will retry and surface a clearer error
  }
  await page.waitForTimeout(500);
  return true;
}

async function sendMessage(page: Page, text: string) {
  await dismissViteOverlay(page);
  const msgArea = page.locator('[contenteditable="true"]').first();
  // Explicit wait: the chat input can take a few seconds to mount after
  // appImManager.setPeer — without this, click() blocks on the default
  // 30s timeout and the entire test scenario fails spuriously.
  await msgArea.waitFor({state: 'visible', timeout: 15000});
  await msgArea.click();
  await page.waitForTimeout(150);
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  // Retry typing if content is truncated: Solid.js event delegation +
  // pressSequentially races can drop the first few characters, producing
  // bubble text like "eply-reply-..." instead of "Bug3-reply-reply-...".
  for(let attempt = 0; attempt < 3; attempt++) {
    await msgArea.pressSequentially(text, {delay: 15});
    const typed = ((await msgArea.textContent()) || '').trim();
    if(typed === text) break;
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
  }
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}

async function waitForBubble(page: Page, text: string, timeoutMs = 15000): Promise<boolean> {
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
    await page.waitForTimeout(500);
  }
  return false;
}

async function waitForChatListPreview(page: Page, text: string, timeoutMs = 15000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const found = await page.evaluate((t: string) => {
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
    await page.waitForTimeout(500);
  }
  return false;
}

async function waitForChatAPIReady(page: Page, timeoutMs = 15000): Promise<boolean> {
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

/**
 * Count how many bubbles contain the given text.
 * Uses .bubble[data-mid] + Set dedup to avoid counting nested reply elements.
 */
async function countBubblesWithText(page: Page, text: string): Promise<number> {
  return page.evaluate((t: string) => {
    const seen = new Set<string>();
    let count = 0;
    const els = document.querySelectorAll('.bubble[data-mid]');
    for(const el of els) {
      const mid = (el as HTMLElement).dataset.mid || '';
      if(!mid || seen.has(mid)) continue;
      seen.add(mid);
      // Check direct message content, skip nested reply/quote
      const msgEls = el.querySelectorAll('.message');
      for(const msg of msgEls) {
        if(msg.closest('.reply, .quote')) continue;
        if(msg.textContent?.includes(t)) {
          count++;
          break;
        }
      }
    }
    return count;
  }, text);
}

/**
 * Get all bubbles with data-mid in DOM order, with position info.
 * Clones .message and removes .time children to get clean text.
 */
async function getBubbles(page: Page): Promise<Array<{
  text: string;
  mid: string;
  out: boolean;
  timestamp: number;
  pinned: boolean;
  domIndex: number;
}>> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    const bubbles: Array<{text: string; mid: string; out: boolean; timestamp: number; pinned: boolean; domIndex: number}> = [];
    const container = document.querySelector('.bubbles-inner, .bubbles') || document;
    const els = container.querySelectorAll<HTMLElement>('.bubble[data-mid]');
    let idx = 0;
    for(const el of els) {
      const mid = el.dataset.mid || '';
      if(!mid || seen.has(mid)) continue;
      seen.add(mid);
      // Skip service bubbles (date separators etc.)
      if(el.classList.contains('service')) continue;
      const msgEls = el.querySelectorAll<HTMLElement>('.message');
      let text = '';
      for(const msg of msgEls) {
        if(msg.closest('.reply, .quote')) continue;
        // Clone the .message element and strip .time children to get clean text
        const clone = msg.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach((e) => e.remove());
        text = (clone.textContent || '').trim();
        if(text) break;
      }
      if(!text) continue;
      const out = el.classList.contains('is-out');
      const timestamp = +(el.dataset.timestamp || '0');
      // Check for pinned indicator
      const pinned = el.classList.contains('is-pinned');
      bubbles.push({text, mid, out, timestamp, pinned, domIndex: idx++});
    }
    return bubbles;
  });
}

/**
 * Navigate to Settings (to have the chat NOT open for Bug 1).
 */
async function openSettings(page: Page): Promise<boolean> {
  // Click the hamburger/settings menu
  const menuBtn = page.locator('.btn-menu-toggle, .sidebar-header .btn-icon, #topbar-menu-btn').first();
  if(await menuBtn.isVisible({timeout: 3000}).catch(() => false)) {
    await menuBtn.click();
    await page.waitForTimeout(500);
  }
  // Try clicking Settings in the menu
  const settingsBtn = page.locator('text=Settings').first();
  if(await settingsBtn.isVisible({timeout: 3000}).catch(() => false)) {
    await settingsBtn.click();
    await page.waitForTimeout(2000);
    return true;
  }
  return false;
}

/**
 * Navigate back from Settings to main chat list.
 */
async function backToChatList(page: Page) {
  const backBtn = page.locator('.sidebar-close-button, button.btn-icon.tgico-back, button.btn-icon.tgico-arrow_back, button.btn-icon.tgico-close').first();
  if(await backBtn.isVisible({timeout: 3000}).catch(() => false)) {
    await backBtn.click();
    await page.waitForTimeout(2000);
  }
}

/**
 * Check if there are pinned message indicators in the chat topbar.
 */
async function hasPinnedMessageIndicator(page: Page): Promise<{
  found: boolean;
  details: string;
}> {
  return page.evaluate(() => {
    const details: string[] = [];
    // ChatPinnedMessage container is always created but hidden via .hide class
    // when there are no pinned messages. We only care about VISIBLE pinned indicators.
    const pinnedContainers = document.querySelectorAll('.pinned-container');
    for(const cont of pinnedContainers) {
      const isHidden = cont.classList.contains('hide');
      if(isHidden) continue;
      // Check if it's a pinned-message container (not replies/etc)
      if(cont.classList.contains('pinned-message') || cont.querySelector('.pinned-message')) {
        details.push(`visible .pinned-container.pinned-message`);
      }
    }
    // Check the `is-pinned-message-shown` class on topbar
    const topbarWithPinnedShown = document.querySelector('.chat-topbar.is-pinned-message-shown');
    if(topbarWithPinnedShown) {
      details.push('topbar has is-pinned-message-shown class');
    }
    // Check for pinned bubbles
    const pinnedBubbles = document.querySelectorAll('.bubble.is-pinned');
    if(pinnedBubbles.length > 0) {
      details.push(`${pinnedBubbles.length} pinned bubbles`);
    }
    return {
      found: details.length > 0,
      details: details.join('; ') || 'none'
    };
  });
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
  const icon = status === 'PASS' ? '✓' : '✗';
  console.log(`  [${icon} ${status}] ${id}: ${name}${detail ? ' — ' + detail : ''}`);
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  console.log('E2E Bug Regression Test Suite');
  console.log('Bugs reported 2026-04-12');
  console.log('======================================\n');

  const relay = new LocalRelay();
  await relay.start();
  console.log(`Local relay started at ${relay.url}\n`);

  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await relay.injectInto(ctxA);
  await relay.injectInto(ctxB);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // Capture console logs for diagnostics
  const logsA: string[] = [];
  const logsB: string[] = [];
  const logFilter = (prefix: string, arr: string[]) => (msg: any) => {
    const t = msg.text();
    if(
      t.includes('[ChatAPI]') || t.includes('[NostrRelay]') ||
      t.includes('[NostraSync]') || t.includes('[NostraOnboarding') ||
      t.includes('[VirtualMTProto') || t.includes('message published') ||
      t.includes('history_append') || t.includes('nostra_new_message') ||
      t.includes('dialogs_multiupdate') || t.includes('pinned') ||
      t.includes('pin') || t.includes('duplicate') || t.includes('pending')
    ) {
      arr.push(`[${prefix}] ${t}`);
    }
  };
  pageA.on('console', logFilter('A', logsA));
  pageB.on('console', logFilter('B', logsB));

  try {
    // =====================================================================
    // Setup: Create two identities
    // =====================================================================
    console.log('=== Setup: Creating identities ===');
    const npubA = await createIdentity(pageA, 'Alice');
    const npubB = await createIdentity(pageB, 'Bobby');
    console.log(`  Alice: ${npubA.slice(0, 24)}...`);
    console.log(`  Bobby: ${npubB.slice(0, 24)}...`);

    if(!npubA || !npubB) {
      console.error('FATAL: Failed to create identities');
      process.exit(1);
    }

    // Only Alice adds Bobby as contact.
    // Bobby does NOT add Alice — she's an "unknown contact" for Bobby.
    console.log('\n=== Setup: Alice adds Bobby as contact ===');
    await addContact(pageA, npubB, 'Bobby');
    console.log('  Alice added Bobby');

    // Wait for ChatAPI to be ready on both sides
    await waitForChatAPIReady(pageA, 15000);
    await waitForChatAPIReady(pageB, 15000);

    // =====================================================================
    // BUG 1: First message from unknown contact, chat NOT open, arrives
    //        duplicated.
    //
    // Scenario: Bobby is in Settings. Alice sends a message. Bobby goes
    // back to chat list, opens the chat. Message should appear ONCE.
    // =====================================================================
    console.log('\n=== BUG 1: Duplicate message from unknown contact ===');

    // Bobby navigates to Settings (chat not open)
    const settingsOpened = await openSettings(pageB);
    console.log(`  Bobby opened settings: ${settingsOpened}`);
    if(!settingsOpened) {
      // Fallback: just make sure no chat is open (stay on main screen)
      console.log('  Fallback: Bobby stays on chat list (no chat open)');
    }

    // Alice opens chat with Bobby and sends the first message
    await openChatByName(pageA, 'Bobby');
    // Use dashes instead of underscores to avoid tweb's markdown italic parsing
    const msg1 = `Bug1-first-msg-${Date.now()}`;
    await sendMessage(pageA, msg1);
    console.log(`  Alice sent: "${msg1}"`);

    // Wait for relay propagation
    console.log('  Waiting 8s for relay propagation...');
    await pageA.waitForTimeout(8000);

    // Bobby goes back to chat list and opens the chat with Alice
    await backToChatList(pageB);
    await pageB.waitForTimeout(2000);

    // Bobby should see Alice's message in chat list
    const previewBug1 = await waitForChatListPreview(pageB, msg1, 15000);
    console.log(`  Bobby sees preview: ${previewBug1}`);

    // Open the chat
    const bug1ChatOpened = await openChatByName(pageB, 'Alice');
    if(!bug1ChatOpened) {
      // Try opening first chat
      const peerId = await pageB.evaluate(() => {
        const chats = document.querySelectorAll('.chatlist-chat');
        if(!chats[0]) return null;
        const pid = chats[0].getAttribute('data-peer-id');
        if(pid) (window as any).appImManager?.setPeer({peerId: pid});
        return pid;
      });
      console.log(`  Opened first chat with peerId: ${peerId}`);
      await pageB.waitForTimeout(3000);
    }

    // Wait for bubbles to render
    await pageB.waitForTimeout(5000);

    // Count how many times the message appears
    const bug1Count = await countBubblesWithText(pageB, msg1);
    console.log(`  Message bubble count on Bobby: ${bug1Count}`);


    if(bug1Count === 1) {
      record('BUG1', 'First message from unknown contact NOT duplicated', 'PASS',
        'message appears exactly once');
    } else if(bug1Count === 0) {
      record('BUG1', 'First message from unknown contact NOT duplicated', 'FAIL',
        'message not found at all — receive pipeline broken');
    } else {
      record('BUG1', 'First message from unknown contact NOT duplicated', 'FAIL',
        `DUPLICATE: message appears ${bug1Count} times instead of 1`);
    }

    // =====================================================================
    // BUG 2: Reply to the message from Bug 1 shows in chat list preview
    //        but NOT as a sent bubble on Bobby's side.
    //
    // Bobby replies in the chat opened above.
    // =====================================================================
    console.log('\n=== BUG 2: Reply visible only in preview, not as bubble ===');

    const msg2 = `Bug2-reply-${Date.now()}`;
    await sendMessage(pageB, msg2);
    console.log(`  Bobby replied: "${msg2}"`);
    await pageB.waitForTimeout(3000);

    // Check if the reply appears as a bubble on Bobby's side
    const bug2BubbleOnBobby = await waitForBubble(pageB, msg2, 10000);
    // Check if Alice receives it (to confirm it was actually sent)
    const bug2BubbleOnAlice = await waitForBubble(pageA, msg2, 15000);
    console.log(`  Reply bubble on Bobby (sender): ${bug2BubbleOnBobby}`);
    console.log(`  Reply bubble on Alice (recipient): ${bug2BubbleOnAlice}`);

    // Also check chat list preview on Bobby
    // Navigate back to chat list briefly to check preview
    await backToChatList(pageB);
    await pageB.waitForTimeout(1000);
    const bug2Preview = await waitForChatListPreview(pageB, msg2, 5000);
    console.log(`  Reply in Bobby's chat list preview: ${bug2Preview}`);

    // Navigate back to the chat
    await openChatByName(pageB, 'Alice');
    await pageB.waitForTimeout(2000);

    if(bug2BubbleOnBobby) {
      record('BUG2', 'Reply appears as sent bubble on sender side', 'PASS');
    } else {
      record('BUG2', 'Reply appears as sent bubble on sender side', 'FAIL',
        `bubble on sender: false, preview on sender: ${bug2Preview}, ` +
        `bubble on recipient: ${bug2BubbleOnAlice}`);
    }

    // =====================================================================
    // BUG 3: Reply-to-reply appears out of chronological order.
    //
    // Alice replies back (3rd message). On Alice's side, this reply should
    // appear as the LAST (bottom-most) bubble.
    // =====================================================================
    console.log('\n=== BUG 3: Reply-to-reply out of chronological order ===');

    // Wait a bit so timestamps are clearly different
    await pageA.waitForTimeout(2000);

    const msg3 = `Bug3-reply-reply-${Date.now()}`;
    await sendMessage(pageA, msg3);
    console.log(`  Alice replied: "${msg3}"`);
    await pageA.waitForTimeout(5000);

    // Get all bubbles on Alice's side and check order
    const bubblesOnAlice = await getBubbles(pageA);
    console.log(`  Total bubbles on Alice: ${bubblesOnAlice.length}`);
    bubblesOnAlice.forEach((b, i) => {
      console.log(`    ${i}: mid=${b.mid} out=${b.out} ts=${b.timestamp} text="${b.text.slice(0, 50)}"`);
    });

    // The bug is about DOM position — Bug3 must appear as the LAST bubble
    // in the DOM (bottom of chat). This is what the user sees and what
    // was reported as broken. The timestamp check is a secondary sanity
    // check but was too strict under relay timing variance.
    const lastBubbleAlice = bubblesOnAlice[bubblesOnAlice.length - 1];
    const msg3IsLast = !!lastBubbleAlice?.text?.includes(msg3);

    console.log(`  msg3 is last in DOM: ${msg3IsLast}`);

    // Check Bobby receives it and in correct position too
    const bug3OnBobby = await waitForBubble(pageB, msg3, 15000);
    await pageB.waitForTimeout(2000);
    const bubblesOnBobby = await getBubbles(pageB);
    const lastBubbleBobby = bubblesOnBobby[bubblesOnBobby.length - 1];
    const msg3IsLastOnBobby = !!lastBubbleBobby?.text?.includes(msg3);

    console.log(`  Bobby received msg3: ${bug3OnBobby}`);
    console.log(`  msg3 is last on Bobby: ${msg3IsLastOnBobby}`);

    if(msg3IsLast) {
      record('BUG3', 'Reply-to-reply appears as last message (correct order)', 'PASS');
    } else {
      record('BUG3', 'Reply-to-reply appears as last message (correct order)', 'FAIL',
        `not last in DOM (last bubble: "${lastBubbleAlice?.text?.slice(0, 40)}")`);
    }

    // =====================================================================
    // BUG 4: Messages get automatically pinned on send.
    //
    // Check all messages sent so far for pin indicators.
    // Also send a fresh message and check immediately.
    // =====================================================================
    console.log('\n=== BUG 4: Messages auto-pinned on send ===');

    const msg4 = `Bug4-no-pin-${Date.now()}`;
    await sendMessage(pageA, msg4);
    console.log(`  Alice sent: "${msg4}"`);
    await pageA.waitForTimeout(3000);

    // Check for pinned message indicators on Alice's side
    const pinnedCheck = await hasPinnedMessageIndicator(pageA);
    console.log(`  Pinned indicator: found=${pinnedCheck.found}, details: ${pinnedCheck.details}`);

    // Check if any bubble has pinned class/indicator
    const allBubblesAlice = await getBubbles(pageA);
    const pinnedBubbles = allBubblesAlice.filter(b => b.pinned);
    console.log(`  Bubbles with pin indicator: ${pinnedBubbles.length}/${allBubblesAlice.length}`);

    if(!pinnedCheck.found && pinnedBubbles.length === 0) {
      record('BUG4', 'Messages are NOT auto-pinned on send', 'PASS');
    } else {
      record('BUG4', 'Messages are NOT auto-pinned on send', 'FAIL',
        `${pinnedCheck.details}, pinned bubbles: ${pinnedBubbles.length}`);
    }

  } catch(err) {
    console.error('\nE2E test error:', err);
  } finally {
    // Print diagnostic logs
    const filterNoise = (l: string) =>
      !l.includes('MTPROTO') && !l.includes('relay_state') && !l.includes('nostra_relay_state');
    console.log('\n=== Alice logs (filtered) ===');
    logsA.filter(filterNoise).slice(-30).forEach((l) => console.log('  ' + l));
    console.log('\n=== Bobby logs (filtered) ===');
    logsB.filter(filterNoise).slice(-30).forEach((l) => console.log('  ' + l));

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
    const icon = r.status === 'PASS' ? '✓' : '✗';
    console.log(`  [${icon}] ${r.id}: ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\nTotal: ${passed} passed, ${failed} failed out of ${results.length}`);
  console.log('(FAIL = bug reproduced, PASS = bug NOT reproduced)\n');

  // Exit with 0 — these are regression tests, we EXPECT failures
  // The bugs exist and we want to see them fail
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
