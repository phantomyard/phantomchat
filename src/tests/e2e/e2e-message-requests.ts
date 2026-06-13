/**
 * E2E test: message from an unknown sender (not in contacts) creates a chat.
 *
 * Verifies the behavior change from "Richieste" (message requests) to
 * "auto-accept + create chat" for unknown senders. The MessageRequests UI
 * component was never mounted, so filtering unknown senders into a hidden
 * queue meant users would silently never see the message.
 *
 * New behavior:
 * 1. User A (not in User B's contacts) sends a message to User B
 * 2. User B should see a new chat appear in the main chat list
 * 3. The message content should appear in the chat list preview
 * 4. Opening the chat shows the bubble
 *
 * A record is still added to the message-requests IndexedDB store (for
 * potential future accept/reject UX), but the message is NOT gated behind it.
 *
 * Run: npx tsx src/tests/e2e/e2e-message-requests.ts
 */

// @ts-nocheck
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';

const APP_URL = 'http://localhost:8080';
const RELAY_PROPAGATION_MS = 5000;

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

async function addContactAsSender(page: Page, npub: string, nickname: string) {
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

async function sendMessage(page: Page, text: string) {
  const msgArea = page.locator('[contenteditable="true"]').first();
  await msgArea.click();
  await msgArea.pressSequentially(text);
  await page.keyboard.press('Enter');
}

async function waitForChatListPreview(page: Page, text: string, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const found = await page.evaluate((t: string) => {
      const chatList = document.querySelector('.chatlist-container, .chat-list, #chatlist-container');
      if(chatList && chatList.textContent?.includes(t)) return true;
      return false;
    }, text);
    if(found) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

async function waitForDialogInList(page: Page, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const hasDialog = await page.evaluate(() => {
      return document.querySelectorAll('.chatlist-chat').length > 0;
    });
    if(hasDialog) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

const results: {name: string; pass: boolean; detail?: string}[] = [];

function report(name: string, pass: boolean, detail?: string) {
  results.push({name, pass, detail});
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log('E2E: Unknown-sender message creates chat');
  console.log('==========================================\n');

  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions);
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  await relay.injectInto(contextA);
  await relay.injectInto(contextB);
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  const logsB: string[] = [];
  pageB.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('[ChatAPI]') || t.includes('[NostraSync]') || t.includes('[NostraOnboarding') || t.includes('unknown') || t.includes('auto-adding')) {
      logsB.push(`[B] ${t}`);
    }
  });

  try {
    // Step 1: both users create identities
    console.log('=== Step 1: Create identities ===');
    const npubA = await createIdentity(pageA, 'Alice');
    const npubB = await createIdentity(pageB, 'Bobby');
    console.log(`  Alice: ${npubA.slice(0, 24)}...`);
    console.log(`  Bobby: ${npubB.slice(0, 24)}...`);

    if(!npubA || !npubB) {
      console.error('FATAL: Failed to create identities');
      process.exit(1);
    }

    // Step 2: ONLY User A adds User B as contact. User B does NOT add User A.
    console.log('\n=== Step 2: User A adds Bobby (one-way) ===');
    await addContactAsSender(pageA, npubB, 'Bobby');
    console.log('  Alice added Bobby');

    // Step 3: User A opens Bob's chat and sends a message
    console.log('\n=== Step 3: Alice sends message to Bobby ===');
    await pageA.evaluate(() => {
      const chats = document.querySelectorAll('.chatlist-chat');
      if(chats[0]) {
        const pid = chats[0].getAttribute('data-peer-id');
        if(pid) (window as any).appImManager?.setPeer({peerId: pid});
      }
    });
    await pageA.waitForTimeout(3000);

    const testMessage = 'Hello stranger! ' + Date.now();
    await sendMessage(pageA, testMessage);
    console.log(`  Alice sent: "${testMessage}"`);
    console.log('  Waiting 5s for relay propagation...');
    await pageA.waitForTimeout(RELAY_PROPAGATION_MS);

    // Step 4: Check Bobby's UI — chat should appear in main chat list
    console.log('\n=== Step 4: Verify chat appears on Bobby ===');

    // 4a: A dialog should appear in the main chat list
    const dialogAppeared = await waitForDialogInList(pageB, 10000);
    report('CHAT_APPEARS_IN_LIST', dialogAppeared,
      dialogAppeared ? 'unknown sender dialog visible' : 'no .chatlist-chat elements found');

    // 4b: The message text should appear in the chat list preview
    const previewFound = await waitForChatListPreview(pageB, testMessage, 10000);
    report('MESSAGE_IN_PREVIEW', previewFound,
      previewFound ? 'preview shows message text' : 'message text not in chat list');

    // 4c: The message-requests IDB should still have a record (for future UX)
    const requestStoreCheck = await pageB.evaluate(async() => {
      try {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('nostra-message-requests', 1);
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(req.result);
          req.onupgradeneeded = () => {};
        });
        const tx = db.transaction('requests', 'readonly');
        const store = tx.objectStore('requests');
        const all = await new Promise<any[]>((resolve, reject) => {
          const req = store.getAll();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(req.result);
        });
        db.close();
        return {count: all.length, hasMessage: all.some((r: any) => r.firstMessage?.includes('Hello stranger'))};
      } catch(err) {
        return {count: 0, hasMessage: false, error: String(err)};
      }
    });
    report('REQUEST_STORED_IN_IDB', requestStoreCheck.count > 0,
      `${requestStoreCheck.count} request(s), hasMessage=${requestStoreCheck.hasMessage}`);

    // 4d: The pubkey should be in virtual-peers-db (auto-added)
    const virtualPeerCheck = await pageB.evaluate(async() => {
      try {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('nostra-virtual-peers', 1);
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(req.result);
          req.onupgradeneeded = () => {};
        });
        const tx = db.transaction('mappings', 'readonly');
        const store = tx.objectStore('mappings');
        const all = await new Promise<any[]>((resolve, reject) => {
          const req = store.getAll();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => resolve(req.result);
        });
        db.close();
        return {count: all.length};
      } catch(err) {
        return {count: 0, error: String(err)};
      }
    });
    report('PUBKEY_IN_VIRTUAL_PEERS_DB', virtualPeerCheck.count > 0,
      `${virtualPeerCheck.count} mapping(s) in virtual-peers-db`);

    // 4e: Opening the chat should show the bubble
    console.log('\n=== Step 5: Open chat and verify bubble ===');
    const opened = await pageB.evaluate(() => {
      const chats = document.querySelectorAll('.chatlist-chat');
      if(chats[0]) {
        const pid = chats[0].getAttribute('data-peer-id');
        if(pid) {
          (window as any).appImManager?.setPeer({peerId: pid});
          return true;
        }
      }
      return false;
    });
    if(opened) {
      await pageB.waitForTimeout(5000);
      const bubbleFound = await pageB.evaluate((t: string) => {
        const bubbles = document.querySelectorAll('.bubble .message, .bubble .inner, .bubble-content');
        for(const b of bubbles) {
          if(b.textContent?.includes(t)) return true;
        }
        return false;
      }, testMessage);
      report('BUBBLE_VISIBLE_IN_CHAT', bubbleFound,
        bubbleFound ? 'message bubble rendered' : 'no bubble with message text');
    } else {
      report('BUBBLE_VISIBLE_IN_CHAT', false, 'could not open chat (no chatlist-chat)');
    }

    // Print relevant logs for diagnostics
    if(logsB.length) {
      console.log('\n=== Bobby relevant logs ===');
      logsB.slice(0, 30).forEach((l) => console.log('  ' + l));
    }
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
    await contextA.close();
    await contextB.close();
    await browser.close();

    process.exit(passed === total ? 0 : 1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
