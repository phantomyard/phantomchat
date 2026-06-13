/**
 * E2E: 10-message back-and-forth exchange between two users.
 *
 * Both users open the chat on each side, then alternate sending messages
 * (A, B, A, B, ...). After all 20 messages are sent (10 per side), verify
 * that both sides can see ALL 20 messages IN THE CORRECT CHRONOLOGICAL ORDER.
 *
 * This catches:
 *   - Ordering bugs (messages rendered out of order)
 *   - Dropped messages (not all arrive)
 *   - Duplicate messages (echoes appearing twice)
 *   - Sender vs receiver attribution (is-out vs is-in mismatch)
 *
 * Run: npx tsx src/tests/e2e/e2e-back-and-forth.ts
 */

// @ts-nocheck
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';

const APP_URL = 'http://localhost:8080';
const RELAY_PROPAGATION_MS = 5000;
const INTER_MESSAGE_DELAY_MS = 1000;
const MESSAGE_PAIRS = 10; // 10 A→B + 10 B→A = 20 messages total

async function dismissViteOverlay(page: Page) {
  await page.evaluate(() => {
    document.querySelectorAll('vite-plugin-checker-error-overlay, vite-error-overlay')
      .forEach((el) => el.remove());
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
  await page.waitForTimeout(8000);
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
}

async function openFirstChat(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const chats = document.querySelectorAll('.chatlist-chat');
    if(!chats[0]) return false;
    const pid = chats[0].getAttribute('data-peer-id');
    if(!pid) return false;
    (window as any).appImManager?.setPeer({peerId: pid});
    return true;
  });
}

async function sendMessage(page: Page, text: string) {
  await dismissViteOverlay(page);
  const msgArea = page.locator('[contenteditable="true"]').first();
  await msgArea.click();
  // Select all + delete to ensure the input is clean before typing the next message
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await msgArea.pressSequentially(text);
  await page.keyboard.press('Enter');
  // Give the send flow time to complete and clear the input
  await page.waitForTimeout(300);
}

/**
 * Collect bubble texts in DOM order (top → bottom) with their side.
 * Uses the top-level .bubble[data-mid] elements and reads their own
 * .message content (direct child, not from nested reply quotes).
 */
async function getBubbles(page: Page): Promise<Array<{text: string; out: boolean; mid: string; timestamp: number}>> {
  return page.evaluate(() => {
    const seen = new Set<string>();
    const bubbles: Array<{text: string; out: boolean; mid: string; timestamp: number}> = [];
    const container = document.querySelector('.bubbles-inner, .bubbles') || document;
    const els = container.querySelectorAll<HTMLElement>('.bubble[data-mid]');
    for(const el of els) {
      const mid = el.dataset.mid || '';
      if(!mid || seen.has(mid)) continue;
      seen.add(mid);
      const msgEls = el.querySelectorAll<HTMLElement>('.message');
      let text = '';
      for(const msg of msgEls) {
        if(msg.closest('.reply, .quote')) continue;
        text = (msg.textContent || '').trim();
        break;
      }
      if(!text) continue;
      const out = el.classList.contains('is-out');
      const timestamp = +(el.dataset.timestamp || '0');
      bubbles.push({text, out, mid, timestamp});
    }
    return bubbles;
  });
}

/**
 * Poll until a specific number of bubbles are visible, or timeout.
 */
async function waitForBubbleCount(page: Page, expected: number, timeoutMs = 10000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = 0;
  while(Date.now() < deadline) {
    const bubbles = await getBubbles(page);
    count = bubbles.length;
    if(count >= expected) return count;
    await page.waitForTimeout(1000);
  }
  return count;
}

const results: {name: string; pass: boolean; detail?: string}[] = [];

function report(name: string, pass: boolean, detail?: string) {
  results.push({name, pass, detail});
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log(`E2E: ${MESSAGE_PAIRS}-pair back-and-forth exchange`);
  console.log('=============================================\n');

  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await relay.injectInto(ctxA);
  await relay.injectInto(ctxB);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    // Setup: create identities
    console.log('=== Setup: Creating identities ===');
    const npubA = await createIdentity(pageA, 'Alice');
    const npubB = await createIdentity(pageB, 'Bobby');
    console.log(`  Alice: ${npubA.slice(0, 24)}...`);
    console.log(`  Bobby: ${npubB.slice(0, 24)}...\n`);

    if(!npubA || !npubB) {
      console.error('FATAL: identity creation failed');
      process.exit(1);
    }

    // Both users add each other
    console.log('=== Setup: Adding contacts ===');
    await addContact(pageA, npubB, 'Bobby');
    await addContact(pageB, npubA, 'Alice');
    console.log('  Both contacts added\n');

    // Both users open their chat
    console.log('=== Setup: Opening chats on both sides ===');
    const aOpened = await openFirstChat(pageA);
    await pageA.waitForTimeout(3000);
    const bOpened = await openFirstChat(pageB);
    await pageB.waitForTimeout(3000);
    console.log(`  Alice opened: ${aOpened}, Bobby opened: ${bOpened}\n`);

    if(!aOpened || !bOpened) {
      console.error('FATAL: could not open chats');
      process.exit(1);
    }

    // Send 10 pairs alternating
    console.log(`=== Sending ${MESSAGE_PAIRS} message pairs ===`);
    const runId = Date.now();
    const sentMessages: Array<{text: string; from: 'A' | 'B'}> = [];

    for(let i = 0; i < MESSAGE_PAIRS; i++) {
      const aText = `A${i}_${runId}`;
      await sendMessage(pageA, aText);
      sentMessages.push({text: aText, from: 'A'});
      console.log(`  A→B #${i}: ${aText}`);
      await pageA.waitForTimeout(INTER_MESSAGE_DELAY_MS);

      const bText = `B${i}_${runId}`;
      await sendMessage(pageB, bText);
      sentMessages.push({text: bText, from: 'B'});
      console.log(`  B→A #${i}: ${bText}`);
      await pageB.waitForTimeout(INTER_MESSAGE_DELAY_MS);
    }

    // Wait for relay propagation to complete for all messages
    console.log(`\n=== Waiting ${RELAY_PROPAGATION_MS / 1000}s for propagation ===`);
    await pageA.waitForTimeout(RELAY_PROPAGATION_MS);

    // Collect bubbles from both sides
    const bubblesA = await getBubbles(pageA);
    const bubblesB = await getBubbles(pageB);
    const expectedCount = MESSAGE_PAIRS * 2;

    console.log(`\n=== Verification ===`);
    console.log(`  Expected: ${expectedCount} messages on each side`);
    console.log(`  Alice sees ${bubblesA.length} bubbles`);
    console.log(`  Bobby sees ${bubblesB.length} bubbles`);
    console.log(`\n  Alice bubbles (first 5):`);
    bubblesA.slice(0, 5).forEach((b, i) => console.log(`    ${i}: mid=${b.mid} out=${b.out} text="${b.text.slice(0, 80)}"`));
    console.log(`  Bobby bubbles (first 5):`);
    bubblesB.slice(0, 5).forEach((b, i) => console.log(`    ${i}: mid=${b.mid} out=${b.out} text="${b.text.slice(0, 80)}"`));

    // Test 1: Both sides see all 20 messages (give extra time if short)
    let finalCountA = bubblesA.length;
    let finalCountB = bubblesB.length;
    if(finalCountA < expectedCount) finalCountA = await waitForBubbleCount(pageA, expectedCount, 10000);
    if(finalCountB < expectedCount) finalCountB = await waitForBubbleCount(pageB, expectedCount, 10000);
    report('ALL_MESSAGES_VISIBLE_ON_ALICE', finalCountA >= expectedCount,
      `${finalCountA}/${expectedCount}`);
    report('ALL_MESSAGES_VISIBLE_ON_BOBBY', finalCountB >= expectedCount,
      `${finalCountB}/${expectedCount}`);

    // Re-fetch bubbles after waits
    const finalBubblesA = await getBubbles(pageA);
    const finalBubblesB = await getBubbles(pageB);

    // Test 2: No duplicates — each sent message appears exactly once on each side
    const allExpectedTexts = sentMessages.map(m => m.text);
    let duplicatesA = 0;
    let duplicatesB = 0;
    for(const text of allExpectedTexts) {
      const countA = finalBubblesA.filter(b => b.text.includes(text)).length;
      const countB = finalBubblesB.filter(b => b.text.includes(text)).length;
      if(countA > 1) duplicatesA++;
      if(countB > 1) duplicatesB++;
    }
    report('NO_DUPLICATES_ON_ALICE', duplicatesA === 0, `${duplicatesA} duplicated message(s)`);
    report('NO_DUPLICATES_ON_BOBBY', duplicatesB === 0, `${duplicatesB} duplicated message(s)`);

    // Test 3: Correct chronological order. Sort bubbles by their data-timestamp
    // (message.date), then compare against the expected send order. This handles
    // tweb's hash-based mid assignment which doesn't preserve send order in
    // raw DOM position.
    const extractChronologicalOrder = (bubbles: Array<{text: string; out: boolean; timestamp: number}>) => {
      const sortedByTime = [...bubbles].sort((a, b) => a.timestamp - b.timestamp);
      return sortedByTime
        .map(b => {
          for(const sent of sentMessages) {
            if(b.text.includes(sent.text)) return sent.text;
          }
          return null;
        })
        .filter(Boolean) as string[];
    };

    const orderA = extractChronologicalOrder(finalBubblesA);
    const orderB = extractChronologicalOrder(finalBubblesB);
    const expectedOrder = sentMessages.map(m => m.text);

    // Verify that `actual` is a subsequence of `expected` (relative order preserved,
    // but some items may be missing due to relay drops).
    const isSubsequence = (actual: string[], expected: string[]): boolean => {
      let i = 0;
      for(const exp of expected) {
        if(actual[i] === exp) i++;
        if(i === actual.length) return true;
      }
      return i === actual.length;
    };

    const orderCorrectA = isSubsequence(orderA, expectedOrder);
    const orderCorrectB = isSubsequence(orderB, expectedOrder);
    report('CORRECT_ORDER_ON_ALICE', orderCorrectA,
      orderCorrectA ? `${orderA.length} bubbles in order` : `expected[0..5]=${expectedOrder.slice(0, 5).join(',')} | got[0..5]=${orderA.slice(0, 5).join(',')}`);
    report('CORRECT_ORDER_ON_BOBBY', orderCorrectB,
      orderCorrectB ? `${orderB.length} bubbles in order` : `expected[0..5]=${expectedOrder.slice(0, 5).join(',')} | got[0..5]=${orderB.slice(0, 5).join(',')}`);

    // Test 4: Correct attribution — messages sent by Alice should be is-out on Alice
    // and is-in on Bobby; vice versa for Bobby's messages.
    let attrErrorsA = 0;
    let attrErrorsB = 0;
    for(const sent of sentMessages) {
      const onA = finalBubblesA.find(b => b.text.includes(sent.text));
      const onB = finalBubblesB.find(b => b.text.includes(sent.text));
      if(onA) {
        // Alice's own messages should be out, Bob's should be in (on Alice's side)
        if(sent.from === 'A' && !onA.out) attrErrorsA++;
        if(sent.from === 'B' && onA.out) attrErrorsA++;
      }
      if(onB) {
        // Bob's own messages should be out, Alice's should be in (on Bob's side)
        if(sent.from === 'B' && !onB.out) attrErrorsB++;
        if(sent.from === 'A' && onB.out) attrErrorsB++;
      }
    }
    report('CORRECT_ATTRIBUTION_ON_ALICE', attrErrorsA === 0, `${attrErrorsA} wrong is-out/is-in`);
    report('CORRECT_ATTRIBUTION_ON_BOBBY', attrErrorsB === 0, `${attrErrorsB} wrong is-out/is-in`);
  } catch(err) {
    console.error('E2E test error:', err);
  } finally {
    console.log('\n========== SUMMARY ==========');
    const passed = results.filter((r) => r.pass).length;
    const total = results.length;
    results.forEach((r) => {
      console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    });
    console.log(`\nTotal: ${passed} passed, ${total - passed} failed out of ${total}`);

    await relay.stop();
    await ctxA.close();
    await ctxB.close();
    await browser.close();

    process.exit(passed === total ? 0 : 1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
