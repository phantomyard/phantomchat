// @ts-nocheck
/**
 * E2E: Captures the 7 D.x UI screenshots required by CHECKLIST_v2.md.
 *
 * Output:
 *   /tmp/e2e-ui-sent.png                      D.1 single check
 *   /tmp/e2e-ui-delivered.png                 D.2 double check
 *   /tmp/e2e-ui-read-blue.png                 D.3 read receipt blue
 *   /tmp/e2e-ui-chatlist-preview-known.png    D.4 known sender preview
 *   /tmp/e2e-ui-chatlist-preview-unknown.png  D.5 unknown sender preview
 *   /tmp/e2e-ui-back-and-forth.png            D.6 10-message bidirectional
 *   /tmp/e2e-ui-add-contact.png               D.7 add contact dialog
 */
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = 'http://localhost:8080';

async function dismiss(page: Page) {
  await page.evaluate(() =>
    document.querySelectorAll('vite-plugin-checker-error-overlay, vite-error-overlay').forEach((el) => el.remove())
  );
}

async function createIdentity(page: Page, name: string): Promise<string> {
  await page.goto(APP_URL);
  await page.waitForTimeout(8000);
  await dismiss(page);
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
  const input = page.getByRole('textbox');
  if(await input.isVisible()) {
    await input.fill(name);
    await page.getByRole('button', {name: 'Get Started'}).click();
  }
  await page.waitForTimeout(8000);
  return npub;
}

async function openContactDialog(page: Page) {
  await dismiss(page);
  await page.locator('#new-menu').click({timeout: 10000});
  await page.waitForTimeout(500);
  await page.locator('text=New Private Chat').click();
  await page.waitForTimeout(1000);
  await page.locator('button.btn-corner.is-visible').click();
  await page.waitForTimeout(1000);
}

async function fillContactDialog(page: Page, npub: string, nickname: string) {
  if(nickname) await page.getByRole('textbox', {name: 'Nickname (optional)'}).fill(nickname);
  await page.getByRole('textbox', {name: 'npub1...'}).fill(npub);
}

async function addContact(page: Page, npub: string, nickname: string) {
  await openContactDialog(page);
  await fillContactDialog(page, npub, nickname);
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
  const msgArea = page.locator('[contenteditable="true"]').first();
  await msgArea.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
  await msgArea.pressSequentially(text, {delay: 25});
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
}

async function main() {
  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext({viewport: {width: 1400, height: 900}});
  const ctxB = await browser.newContext({viewport: {width: 1400, height: 900}});
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    console.log('=== Setup ===');
    const npubA = await createIdentity(pageA, 'AliceUI');
    const npubB = await createIdentity(pageB, 'BobUI');

    // ── D.7: Contact add dialog with nickname + npub filled ─────────────
    console.log('=== D.7 ===');
    await openContactDialog(pageA);
    await fillContactDialog(pageA, npubB, 'BobUI');
    await pageA.screenshot({path: '/tmp/e2e-ui-add-contact.png', fullPage: false});
    // Submit the form so subsequent screenshots have the contact present
    await pageA.getByRole('button', {name: 'Add'}).click();
    await pageA.waitForTimeout(5000);

    // Both users add each other (reciprocal so D.4 known-sender works)
    await addContact(pageB, npubA, 'AliceUI');

    // ── D.5: Unknown-sender chat list preview ─────────────────────────
    // Create a third identity that sends without being added.
    console.log('=== D.5 ===');
    const ctxC = await browser.newContext({viewport: {width: 1400, height: 900}});
    const pageC = await ctxC.newPage();
    const npubC = await createIdentity(pageC, 'StrangerUI');
    // C adds B's npub (so C can send), but B did NOT add C → C is unknown to B
    await addContact(pageC, npubB, 'BobTarget');
    await openFirstChat(pageC);
    await pageC.waitForTimeout(3000);
    await sendMessage(pageC, 'Hello from a stranger');
    console.log('  C sent — waiting for B preview');
    // Wait for relay propagation + preview render
    await pageB.waitForTimeout(35000);
    await pageB.screenshot({path: '/tmp/e2e-ui-chatlist-preview-unknown.png', fullPage: false});
    await ctxC.close();

    // ── D.4: Known-sender chat list preview (Alice → Bob) ──────────────
    console.log('=== D.4 ===');
    await openFirstChat(pageA);
    await pageA.waitForTimeout(3000);
    await sendMessage(pageA, 'Hello from Alice — known sender');
    await pageB.waitForTimeout(25000);
    // Navigate B back to chat list. Using setPeer({peerId: 0}) crashes some
    // tweb code paths — instead, click the back button if visible, or just
    // capture without navigating away.
    try {
      const backBtn = pageB.locator('.sidebar-close-button, button.btn-icon.tgico-back, button.btn-icon.tgico-arrow_back').first();
      if(await backBtn.isVisible({timeout: 2000}).catch(() => false)) {
        await backBtn.click();
        await pageB.waitForTimeout(2000);
      }
    } catch{ /* ignore */ }
    await pageB.screenshot({path: '/tmp/e2e-ui-chatlist-preview-known.png', fullPage: false});

    // ── D.1: Bubble immediately after send (single check) ──────────────
    console.log('=== D.1 ===');
    // Use a fresh context pair so the bubble is freshly sent.
    const ctxA2 = await browser.newContext({viewport: {width: 1400, height: 900}});
    const ctxB2 = await browser.newContext({viewport: {width: 1400, height: 900}});
    const pageA2 = await ctxA2.newPage();
    const pageB2 = await ctxB2.newPage();
    const npubA2 = await createIdentity(pageA2, 'SendAlice');
    const npubB2 = await createIdentity(pageB2, 'SendBob');
    await addContact(pageA2, npubB2, 'SendBob');
    await openFirstChat(pageA2);
    await pageA2.waitForTimeout(3000);
    await sendMessage(pageA2, 'Single check moment');
    // Capture immediately so the receipt hasn't arrived yet
    await pageA2.waitForTimeout(800);
    await pageA2.screenshot({path: '/tmp/e2e-ui-sent.png', fullPage: false});

    // ── D.2: Bubble after delivery receipt (double check) ──────────────
    console.log('=== D.2 ===');
    // B opens its side so the delivery receipt can fire
    await addContact(pageB2, npubA2, 'SendAlice');
    await openFirstChat(pageB2);
    await pageB2.waitForTimeout(3000);
    // Wait for receipt round-trip
    await pageA2.waitForTimeout(35000);
    await pageA2.screenshot({path: '/tmp/e2e-ui-delivered.png', fullPage: false});

    // ── D.3: Bubble after read receipt (blue) — same is-read class ─────
    console.log('=== D.3 ===');
    // Read receipts fire when B opens the chat with bubbles visible.
    // Already opened above; wait some more for the read sweep.
    await pageA2.waitForTimeout(15000);
    await pageA2.screenshot({path: '/tmp/e2e-ui-read-blue.png', fullPage: false});

    await ctxA2.close();
    await ctxB2.close();

    // ── D.6: 10-message back-and-forth chronological ──────────────────
    console.log('=== D.6 ===');
    const ctxA3 = await browser.newContext({viewport: {width: 1400, height: 900}});
    const ctxB3 = await browser.newContext({viewport: {width: 1400, height: 900}});
    const pageA3 = await ctxA3.newPage();
    const pageB3 = await ctxB3.newPage();
    const npubA3 = await createIdentity(pageA3, 'BfAlice');
    const npubB3 = await createIdentity(pageB3, 'BfBob');
    await addContact(pageA3, npubB3, 'BfBob');
    await addContact(pageB3, npubA3, 'BfAlice');
    await openFirstChat(pageA3);
    await openFirstChat(pageB3);
    await pageA3.waitForTimeout(3000);
    await pageB3.waitForTimeout(3000);
    for(let i = 0; i < 5; i++) {
      await sendMessage(pageA3, `A${i}`);
      await pageA3.waitForTimeout(2000);
      await sendMessage(pageB3, `B${i}`);
      await pageB3.waitForTimeout(2000);
    }
    await pageA3.waitForTimeout(35000);
    await pageA3.screenshot({path: '/tmp/e2e-ui-back-and-forth.png', fullPage: false});
    await ctxA3.close();
    await ctxB3.close();

    console.log('\nAll screenshots written to /tmp/e2e-ui-*.png');
  } catch(err) {
    console.error('E2E error:', err);
    process.exit(1);
  } finally {
    await ctxA.close();
    await ctxB.close();
    await browser.close();
  }
}

main();
