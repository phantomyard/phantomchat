/**
 * E2E test for P2P edit-message feature.
 *
 * Flow:
 *   1. Alice and Bob create identities, add each other.
 *   2. Alice sends "Hello B!" to Bob.
 *   3. Bob receives the bubble.
 *   4. Alice edits the message to "Hello B! [edited]".
 *   5. Bob sees the bubble update with the new content + edit_date set.
 *
 * Run: npx tsx src/tests/e2e/e2e-p2p-edit.ts
 *
 * Prerequisites:
 *   - Dev server running at http://localhost:8080 (pnpm start)
 *   - Local relay container available (Docker)
 */

// @ts-nocheck
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = process.env.APP_URL || 'http://localhost:8080';
const RELAY_PROPAGATION_MS = 5000;

const dismissViteOverlay = dismissOverlays;

async function createIdentity(page: Page, displayName: string): Promise<string> {
  // Vite HMR fails on first headless load with ERR_NETWORK_CHANGED — workaround
  // is goto → wait → reload → wait. See CLAUDE.md "E2E Testing" section.
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await dismissViteOverlay(page);
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(15000);
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
    const skip = page.getByText('SKIP');
    if(await skip.isVisible().catch(() => false)) {
      await skip.click();
    } else {
      await page.getByRole('button', {name: 'Get Started'}).click();
    }
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
  await page.getByRole('textbox', {name: 'Nickname (optional)'}).fill(nickname);
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
  const peerId = await page.evaluate((n) => {
    const chats = document.querySelectorAll('.chatlist-chat');
    for(const c of chats) {
      if(c.textContent?.includes(n)) return c.getAttribute('data-peer-id');
    }
    return chats[0]?.getAttribute('data-peer-id') || null;
  }, name);
  if(!peerId) return false;
  const ok = await page.evaluate((pid) => {
    const im = (window as any).appImManager;
    if(!im?.setPeer) return false;
    im.setPeer({peerId: pid});
    return true;
  }, peerId);
  await page.waitForTimeout(5000);
  return ok;
}

async function sendMessage(page: Page, text: string) {
  const msgArea = page.locator('[contenteditable="true"]').first();
  await msgArea.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await msgArea.pressSequentially(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(300);
}

async function waitForBubble(page: Page, text: string, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const found = await page.evaluate((t: string) => {
      const bubbles = document.querySelectorAll('.bubble .message, .bubble .inner, .bubble-content');
      for(const b of bubbles) {
        const clone = b.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach(e => e.remove());
        if(clone.textContent?.includes(t)) return true;
      }
      return false;
    }, text);
    if(found) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function getMidByBubbleText(page: Page, text: string): Promise<number | null> {
  return page.evaluate((t: string) => {
    const bubbles = document.querySelectorAll('.bubble[data-mid]');
    for(const b of bubbles) {
      const clone = b.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach(e => e.remove());
      if(clone.textContent?.includes(t)) {
        const mid = b.getAttribute('data-mid');
        return mid ? Number(mid) : null;
      }
    }
    return null;
  }, text);
}

async function bubbleHasEditedMarker(page: Page, text: string): Promise<boolean> {
  return page.evaluate((t: string) => {
    const bubbles = document.querySelectorAll('.bubble[data-mid]');
    for(const b of bubbles) {
      const inner = b.querySelector('.message');
      if(!inner) continue;
      const clone = inner.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('.time, .time-inner, .reactions, .bubble-pin').forEach(e => e.remove());
      if(clone.textContent?.includes(t)) {
        // tweb renders an "edited" marker as a span/i with the lang key
        // 'EditedMessage' inside the .time element. We check the raw bubble
        // for an .edited class OR the text "edited" (case-insensitive) in
        // the time block.
        if(b.classList.contains('is-edited') || inner.querySelector('.edited, .is-edited')) return true;
        const time = b.querySelector('.time');
        if(time && /edited/i.test(time.textContent || '')) return true;
        return false;
      }
    }
    return false;
  }, text);
}

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

async function main() {
  console.log('E2E P2P Edit Message Test');
  console.log('=========================\n');

  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await relay.injectInto(ctxA);
  await relay.injectInto(ctxB);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const logsA: string[] = [];
  const logsB: string[] = [];
  pageA.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('[ChatAPI]') || t.includes('[VirtualMTProto') || t.includes('[MessageHandler]') || t.includes('edit') || t.includes('message_edit')) logsA.push(`[A] ${t}`);
  });
  pageB.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('[ChatAPI]') || t.includes('[NostraSync]') || t.includes('[MessageHandler]') || t.includes('[VirtualMTProto') || t.includes('edit') || t.includes('message_edit')) logsB.push(`[B] ${t}`);
  });

  try {
    console.log('=== Setup: identities ===');
    const npubA = await createIdentity(pageA, 'Alice');
    const npubB = await createIdentity(pageB, 'Bobby');
    if(!npubA || !npubB) {
      console.error('FATAL: identity creation failed');
      process.exit(1);
    }
    console.log(`  A: ${npubA.slice(0, 24)}...`);
    console.log(`  B: ${npubB.slice(0, 24)}...`);

    console.log('\n=== Setup: contacts ===');
    await addContact(pageB, npubA, 'Alice');
    await addContact(pageA, npubB, 'Bob');

    console.log('\n=== Open chats on both sides ===');
    await openChatByName(pageA, 'Bob');
    await openChatByName(pageB, 'Alice');
    await pageA.waitForTimeout(5000);
    await pageB.waitForTimeout(5000);

    // Step 1: Alice sends original message
    //
    // IMPORTANT: original and editedText must NOT share a substring. tweb
    // bubbles render the new text, and waitForBubble uses .includes() — if
    // the edited text is a superstring, E6 falsely reports "old text still
    // present".
    const ts = Date.now();
    const original = `OrigAAA-${ts}`;
    await sendMessage(pageA, original);
    console.log(`  A sent: "${original}"`);
    await pageA.waitForTimeout(RELAY_PROPAGATION_MS);

    const bSawOriginal = await waitForBubble(pageB, original, 15000);
    if(bSawOriginal) {
      record('E1', 'Receiver sees original bubble', 'PASS');
    } else {
      record('E1', 'Receiver sees original bubble', 'FAIL');
      throw new Error('original bubble missing — cannot proceed');
    }

    const aSawOriginal = await waitForBubble(pageA, original, 5000);
    if(aSawOriginal) {
      record('E1b', 'Sender sees own original bubble', 'PASS');
    } else {
      const diag = await pageA.evaluate(() => {
        const bubbles = [...document.querySelectorAll('.bubble[data-mid]')].map(b => ({
          mid: b.dataset.mid,
          peerId: b.dataset.peerId,
          text: (b.querySelector('.message')?.textContent || '').slice(0, 80)
        }));
        const im = (window as any).appImManager;
        return {
          chatPeer: im?.chat?.peerId,
          storageKey: im?.chat?.messagesStorageKey,
          bubbleCount: bubbles.length,
          bubbles
        };
      });
      record('E1b', 'Sender sees own original bubble', 'FAIL', JSON.stringify(diag).slice(0, 400));
      throw new Error('sender original bubble missing — cannot proceed');
    }

    // Step 2: Alice edits the message via the real UI path
    //   initMessageEditing(mid) → fill input → click send
    // This exercises the same flow a user triggers by right-click → Edit.
    const editedText = `ChangedBBB-${ts}`;

    // Find mid by bubble text (reliable across Worker/main-thread boundaries)
    const targetMid = await getMidByBubbleText(pageA, original);
    if(!targetMid) {
      record('E2', 'Sender invokes editMessage', 'FAIL', 'no target mid on sender side');
      throw new Error('no target mid for edit');
    }

    const editResult = await pageA.evaluate(async(mid) => {
      try {
        const im = (window as any).appImManager;
        if(!im?.chat?.input?.initMessageEditing) {
          return {ok: false, reason: 'initMessageEditing not available'};
        }
        im.chat.input.initMessageEditing(mid);
        return {ok: true, mid};
      } catch(err: any) {
        return {ok: false, reason: err?.message || String(err)};
      }
    }, targetMid);

    if(editResult.ok) {
      // Wait for edit mode UI to settle, then type new text and send.
      // initMessageEditing is async (awaits placeholder params) so we wait
      // long enough for the input to be populated with the original text
      // before attempting to clear + retype.
      await pageA.waitForTimeout(1000);
      const msgArea = pageA.locator('[contenteditable="true"]').first();
      await msgArea.click();
      await pageA.keyboard.press('Control+A');
      await pageA.keyboard.press('Backspace');
      // Small delay to let Backspace settle before typing — otherwise
      // pressSequentially races the input handler and the first few
      // characters get eaten (observed flakiness).
      await pageA.waitForTimeout(200);
      await msgArea.pressSequentially(editedText);
      await pageA.waitForTimeout(300);
      await pageA.locator('button.btn-send').click();
      await pageA.waitForTimeout(300);
    }

    console.log('  edit result:', JSON.stringify(editResult));
    if(!editResult.ok) {
      record('E2', 'Sender invokes editMessage', 'FAIL', editResult.reason);
      throw new Error('edit failed: ' + editResult.reason);
    }
    record('E2', 'Sender invokes editMessage', 'PASS');

    // Step 3: Sender's own bubble should reflect new text
    await pageA.waitForTimeout(2000);
    const aSelfEdited = await waitForBubble(pageA, editedText, 5000);
    if(aSelfEdited) {
      record('E3', 'Sender bubble shows edited text', 'PASS');
    } else {
      const diag = await pageA.evaluate((target) => {
        const bubbles = [...document.querySelectorAll('.bubble[data-mid]')].map(b => ({
          mid: b.dataset.mid,
          peerId: b.dataset.peerId,
          text: (b.querySelector('.message')?.textContent || '').slice(0, 100)
        }));
        const im = (window as any).appImManager;
        const proxy = (window as any).apiManagerProxy;
        const mirror = proxy?.mirrors?.messages?.[`${im?.chat?.peerId}_history`] || {};
        const mirrorEntries = Object.keys(mirror).map(k => ({
          mid: mirror[k]?.mid,
          message: (mirror[k]?.message || '').slice(0, 50),
          edit_date: mirror[k]?.edit_date
        }));
        return {
          chatPeer: im?.chat?.peerId,
          storageKey: im?.chat?.messagesStorageKey,
          expectedText: target,
          bubbleCount: bubbles.length,
          bubbles,
          mirrorEntries
        };
      }, editedText);
      record('E3', 'Sender bubble shows edited text', 'FAIL', JSON.stringify(diag).slice(0, 800));
    }

    // Step 4: Receiver bubble should update to new text
    await pageB.waitForTimeout(RELAY_PROPAGATION_MS);
    const bSawEdit = await waitForBubble(pageB, editedText, 15000);
    if(bSawEdit) {
      record('E4', 'Receiver bubble updates to edited text', 'PASS');
    } else {
      record('E4', 'Receiver bubble updates to edited text', 'FAIL');
    }

    // Step 5: Receiver bubble carries edited marker
    if(bSawEdit) {
      const hasMarker = await bubbleHasEditedMarker(pageB, editedText);
      if(hasMarker) {
        record('E5', 'Receiver bubble has "edited" marker', 'PASS');
      } else {
        record('E5', 'Receiver bubble has "edited" marker', 'FAIL',
          'bubble updated but no edited marker found — check edit_date plumbing');
      }
    } else {
      record('E5', 'Receiver bubble has "edited" marker', 'FAIL', 'edit not received');
    }

    // Step 6: Original text no longer present in receiver bubble
    if(bSawEdit) {
      const stillHasOld = await waitForBubble(pageB, original, 1000);
      if(!stillHasOld) {
        record('E6', 'Old text removed from receiver bubble', 'PASS');
      } else {
        record('E6', 'Old text removed from receiver bubble', 'FAIL',
          'old content still present after edit');
      }
    } else {
      record('E6', 'Old text removed from receiver bubble', 'FAIL', 'edit not received');
    }
  } catch(err) {
    console.error('E2E error:', err);
  } finally {
    const filterNoise = (l: string) =>
      !l.includes('MTPROTO') && !l.includes('relay_state') && !l.includes('nostra_relay_state');
    console.log('\n=== A logs ===');
    logsA.filter(filterNoise).forEach((l) => console.log('  ' + l));
    console.log('\n=== B logs ===');
    logsB.filter(filterNoise).forEach((l) => console.log('  ' + l));

    await relay.stop();
    await ctxA.close();
    await ctxB.close();
    await browser.close();
  }

  console.log('\n========== SUMMARY ==========');
  let passed = 0, failed = 0;
  for(const r of results) {
    if(r.status === 'PASS') passed++;
    else failed++;
  }
  for(const r of results) {
    console.log(`  [${r.status}] ${r.id}: ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\nTotal: ${passed} passed, ${failed} failed out of ${results.length}`);
  if(failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
