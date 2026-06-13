/**
 * Extended E2E tests for P2P messaging in Nostra.chat.
 * Covers: display names, message checkmarks, bidirectional messaging, persistence.
 * Uses two isolated browser contexts for two separate identities.
 * Run: npx tsx src/tests/e2e-p2p-full.ts
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
    // Remove existing overlays
    document.querySelectorAll('vite-plugin-checker-error-overlay, vite-error-overlay')
      .forEach((el) => el.remove());
    // Prevent future overlays from blocking interaction
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

async function getDiagnostics(pageA: Page, pageB: Page, logsA: string[], logsB: string[]): Promise<string> {
  const relayA = await getRelayStatus(pageA);
  const relayB = await getRelayStatus(pageB);
  const published = logsA.some((l) => (l.includes('text sent') || l.includes('message published')));
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

async function addContactAndOpenChat(page: Page, npub: string, nickname: string) {
  await dismissViteOverlay(page);
  await page.locator('#new-menu').click({timeout: 10000});
  await page.waitForTimeout(500);
  await page.locator('text=New Private Chat').click();
  await page.waitForTimeout(1000);
  await page.locator('button.btn-corner.is-visible').click();
  await page.waitForTimeout(1000);
  const nickField = page.getByRole('textbox', {name: 'Nickname (optional)'});
  if(nickname) {
    await nickField.fill(nickname);
  }
  await page.getByRole('textbox', {name: 'npub1...'}).fill(npub);
  await page.getByRole('button', {name: 'Add'}).click();
  await page.waitForTimeout(5000);
  const backBtn = page.locator('.sidebar-close-button, button.btn-icon.tgico-back, button.btn-icon.tgico-arrow_back').first();
  if(await backBtn.isVisible()) {
    await backBtn.click();
    await page.waitForTimeout(2000);
  }
}

async function openChatByName(page: Page, name: string): Promise<boolean> {
  // Headless Chromium doesn't navigate reliably on chatlist anchor clicks;
  // use appImManager.setPeer() with the matching data-peer-id instead.
  const opened = await page.evaluate((n: string) => {
    const chats = document.querySelectorAll('.chatlist-chat');
    for(const c of chats) {
      if(c.textContent?.includes(n)) {
        const pid = c.getAttribute('data-peer-id');
        if(pid) {
          (window as any).appImManager?.setPeer({peerId: pid});
          return true;
        }
      }
    }
    return false;
  }, name);
  if(opened) await page.waitForTimeout(5000);
  return opened;
}

async function sendMessage(page: Page, text: string) {
  const msgArea = page.locator('[contenteditable="true"]').first();
  await msgArea.click();
  // Clear draft before typing — pressSequentially doesn't clear contenteditable
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
  results[results.length] = {name, passed, detail};
  const tag = passed ? 'PASS' : 'FAIL';
  console.log(`  ${tag}: ${name}${detail ? ' (' + detail + ')' : ''}`);
}

// ---------------------------------------------------------------------------
// A. Display Name verification
// ---------------------------------------------------------------------------

async function testDisplayNames() {
  console.log('\n=== Test A: Display Name verification ===');
  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    const npubA = await createIdentity(pageA, 'Alice');
    const npubB = await createIdentity(pageB, 'Bobby');

    // A1: Add contact WITH nickname "TestBob" -> verify chat list shows "TestBob"
    console.log('  A1: Add contact with nickname "TestBob"');
    await addContactAndOpenChat(pageA, npubB, 'TestBob');
    await pageA.waitForTimeout(1000);

    const hasTestBob = await pageA.evaluate(() => {
      const els = document.querySelectorAll('.dialog-title, .peer-title, a');
      for(const el of els) {
        if(el.textContent?.includes('TestBob')) return true;
      }
      return false;
    });
    record('A1 — nickname "TestBob" shown in chat list', hasTestBob);
    if(!hasTestBob) {
      const relayA = await getRelayStatus(pageA);
      console.log('  FAIL diagnostics: User A relay:', JSON.stringify(relayA));
    }

    // A2: Add contact WITHOUT nickname -> verify fallback shows npub-style string
    console.log('  A2: Add contact without nickname (fallback to npub)');
    // User B adds User A with empty nickname
    await addContactAndOpenChat(pageB, npubA, '');
    await pageB.waitForTimeout(1000);

    const npubPrefix = npubA.slice(0, 10);
    const hasFallback = await pageB.evaluate((prefix: string) => {
      const els = document.querySelectorAll('.dialog-title, .peer-title, a');
      for(const el of els) {
        const t = el.textContent || '';
        if(t.includes(prefix) || t.includes('npub1')) return true;
      }
      return false;
    }, npubPrefix);
    const hasP2PLabel = await pageB.evaluate(() => {
      const els = document.querySelectorAll('.dialog-title, .peer-title, a');
      for(const el of els) {
        if(/P2P \d/.test(el.textContent || '')) return true;
      }
      return false;
    });
    record('A2 — fallback shows npub-style string (not "P2P XXXXXX")', hasFallback && !hasP2PLabel,
      hasFallback ? 'npub shown' : hasP2PLabel ? 'got P2P label instead' : 'neither found');
  } finally {
    await ctxA.close();
    await ctxB.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// B. Message checkmark verification
// ---------------------------------------------------------------------------

async function testMessageCheckmarks() {
  console.log('\n=== Test B: Message checkmark verification ===');
  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const logsA: string[] = [];
  pageA.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('Nostra') || t.includes('relay') || t.includes('text sent') || t.includes('message published') || t.includes('injectP2PMessage') || t.includes('received relay message')) {
      logsA.push(`[A] ${t}`);
    }
  });

  try {
    const npubA = await createIdentity(pageA, 'CheckAlice');
    const npubB = await createIdentity(pageB, 'CheckBob');

    // B subscribes first, then A adds and sends
    await addContactAndOpenChat(pageB, npubA, 'CheckAlice');
    await openChatByName(pageB, 'CheckAlice');

    await addContactAndOpenChat(pageA, npubB, 'CheckBob');
    await openChatByName(pageA, 'CheckBob');

    await sendMessage(pageA, 'Checkmark test');
    // Wait for send to settle
    await pageA.waitForTimeout(30000);

    // Inspect the last outgoing bubble
    const bubbleState = await pageA.evaluate(() => {
      const bubbles = document.querySelectorAll('.bubble');
      const last = bubbles[bubbles.length - 1] as HTMLElement | undefined;
      if(!last) return null;
      return {
        isOut: last.classList.contains('is-out'),
        isSent: last.classList.contains('is-sent'),
        isRead: last.classList.contains('is-read'),
        isOutgoing: last.classList.contains('is-outgoing'),
        classes: Array.from(last.classList)
      };
    });

    if(bubbleState) {
      record('B1 — bubble has is-out (right-aligned)', bubbleState.isOut, `classes: ${bubbleState.classes.join(' ')}`);
      // is-sent OR is-read (post delivery receipt) both count as sent
      record('B2 — bubble has is-sent (checkmark)', bubbleState.isSent || bubbleState.isRead, `classes: ${bubbleState.classes.join(' ')}`);
      record('B3 — bubble does NOT have is-outgoing (no longer pending)', !bubbleState.isOutgoing, `classes: ${bubbleState.classes.join(' ')}`);
    } else {
      const relayA = await getRelayStatus(pageA);
      const diag = `no bubble found. User A relay: ${JSON.stringify(relayA)}, published: ${logsA.some((l) => (l.includes('text sent') || l.includes('message published')))}`;
      record('B1 — bubble has is-out', false, diag);
      record('B2 — bubble has is-sent', false, diag);
      record('B3 — bubble not is-outgoing', false, diag);
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// C. Bidirectional messaging
// ---------------------------------------------------------------------------

async function testBidirectionalMessaging() {
  console.log('\n=== Test C: Bidirectional messaging ===');
  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const logsA: string[] = [];
  const logsB: string[] = [];
  pageA.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('Nostra') || t.includes('relay') || t.includes('text sent') || t.includes('message published') || t.includes('injectP2PMessage') || t.includes('received relay message')) {
      logsA.push(`[A] ${t}`);
    }
  });
  pageB.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('Nostra') || t.includes('relay') || t.includes('text sent') || t.includes('message published') || t.includes('injectP2PMessage') || t.includes('received relay message')) {
      logsB.push(`[B] ${t}`);
    }
  });

  try {
    const npubA = await createIdentity(pageA, 'BiAlice');
    const npubB = await createIdentity(pageB, 'BiBob');

    // Both add each other — B first so it subscribes before A sends
    await addContactAndOpenChat(pageB, npubA, 'BiAlice');
    await openChatByName(pageB, 'BiAlice');

    await addContactAndOpenChat(pageA, npubB, 'BiBob');
    await openChatByName(pageA, 'BiBob');

    // C1: A -> B
    console.log('  C1: User A sends to User B');
    await sendMessage(pageA, 'Hello from A to B');
    let bGotIt = await waitForBubble(pageB, 'Hello from A to B', 30000);

    if(!bGotIt) {
      // Rule 2: verify published and retry
      const published = logsA.some((l) => (l.includes('text sent') || l.includes('message published')));
      if(published) {
        console.log('  C1: published but not received, waiting additional 15s...');
        bGotIt = await waitForBubble(pageB, 'Hello from A to B', 15000);
      }
    }

    if(bGotIt) {
      record('C1 — User B received message from A', true);
    } else {
      const diag = await getDiagnostics(pageA, pageB, logsA, logsB);
      const published = logsA.some((l) => (l.includes('text sent') || l.includes('message published')));
      record('C1 — User B received message from A', false,
        published
          ? 'FAIL: message published to relay but not received after 30s. ' + diag
          : 'FAIL: message was not published. ' + diag);
    }

    // C2: B -> A
    console.log('  C2: User B sends to User A');
    await sendMessage(pageB, 'Hello from B to A');
    let aGotIt = await waitForBubble(pageA, 'Hello from B to A', 30000);

    if(!aGotIt) {
      const published = logsB.some((l) => (l.includes('text sent') || l.includes('message published')));
      if(published) {
        console.log('  C2: published but not received, waiting additional 15s...');
        aGotIt = await waitForBubble(pageA, 'Hello from B to A', 15000);
      }
    }

    if(aGotIt) {
      record('C2 — User A received message from B', true);
    } else {
      const diag = await getDiagnostics(pageB, pageA, logsB, logsA);
      const published = logsB.some((l) => (l.includes('text sent') || l.includes('message published')));
      record('C2 — User A received message from B', false,
        published
          ? 'FAIL: message published to relay but not received after 30s. ' + diag
          : 'FAIL: message was not published. ' + diag);
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// D. Message persistence
// ---------------------------------------------------------------------------

async function testMessagePersistence() {
  console.log('\n=== Test D: Message persistence after reload ===');
  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const logsA: string[] = [];
  pageA.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('Nostra') || t.includes('relay') || t.includes('text sent') || t.includes('message published') || t.includes('injectP2PMessage') || t.includes('received relay message')) {
      logsA.push(`[A] ${t}`);
    }
  });

  try {
    const npubA = await createIdentity(pageA, 'PersistAlice');
    const npubB = await createIdentity(pageB, 'PersistBob');

    // B subscribes, then A sends
    await addContactAndOpenChat(pageB, npubA, 'PersistAlice');
    await openChatByName(pageB, 'PersistAlice');

    await addContactAndOpenChat(pageA, npubB, 'PersistBob');
    await openChatByName(pageA, 'PersistBob');

    const testMsg = 'Persist-' + Date.now();
    await sendMessage(pageA, testMsg);
    await pageA.waitForTimeout(30000);

    // Verify sent on sender side before reload using bubble check
    const sentBeforeReload = await pageA.evaluate((msg: string) => {
      const bubbles = document.querySelectorAll('.bubble .message, .bubble .inner, .bubble-content');
      for(const b of bubbles) {
        if(b.textContent?.includes(msg)) return true;
      }
      return false;
    }, testMsg);
    record('D0 — message visible before reload', sentBeforeReload);
    if(!sentBeforeReload) {
      const relayA = await getRelayStatus(pageA);
      console.log('  FAIL diagnostics: User A relay:', JSON.stringify(relayA),
        'published:', logsA.some((l) => (l.includes('text sent') || l.includes('message published'))));
    }

    // Reload sender page
    console.log('  Reloading User A page...');
    await pageA.reload({waitUntil: 'domcontentloaded'});
    await pageA.waitForTimeout(8000);
    await dismissViteOverlay(pageA);
    await pageA.waitForTimeout(4000); // let app and stores reinitialise

    // Check if the dialog itself persisted
    const dialogExists = await pageA.evaluate(() => {
      const els = document.querySelectorAll('.dialog-title, .peer-title, a');
      for(const el of els) {
        if(el.textContent?.includes('PersistBob')) return true;
      }
      return false;
    });
    record('D1 — dialog persists after reload', dialogExists);
    if(!dialogExists) {
      const relayA = await getRelayStatus(pageA);
      console.log('  FAIL diagnostics: User A relay:', JSON.stringify(relayA),
        'published:', logsA.some((l) => (l.includes('text sent') || l.includes('message published'))),
        'relay received:', logsA.some((l) => l.includes('received relay message')),
        'injected:', logsA.some((l) => l.includes('injectP2PMessage')));
    }

    // Try opening the chat and checking bubbles.
    let found = false;
    if(dialogExists) {
      const opened = await openChatByName(pageA, 'PersistBob');
      if(opened) {
        found = await waitForBubble(pageA, testMsg, 15000);
        // With invalidateHistoryCache, the Worker re-fetches from bridge on
        // chat reopen. Give extra time for the round-trip.
        if(!found) {
          await pageA.waitForTimeout(10000);
          found = await waitForBubble(pageA, testMsg, 15000);
        }
      }
    }

    record('D2 — message content persists after reload', found,
      !found && dialogExists ? 'dialog exists but message not found in bubbles' : undefined);
    if(!found) {
      const relayA = await getRelayStatus(pageA);
      console.log('  FAIL diagnostics: User A relay:', JSON.stringify(relayA),
        'published:', logsA.some((l) => (l.includes('text sent') || l.includes('message published'))),
        'relay received:', logsA.some((l) => l.includes('received relay message')),
        'injected:', logsA.some((l) => l.includes('injectP2PMessage')),
        'chat open:', await pageA.evaluate(() => !!document.querySelector('.bubbles-inner')));
    }
  } finally {
    await ctxA.close();
    await ctxB.close();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('E2E P2P Full Test Suite');
  console.log('=======================');

  await testDisplayNames();
  await testMessageCheckmarks();
  await testBidirectionalMessaging();
  await testMessagePersistence();

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
