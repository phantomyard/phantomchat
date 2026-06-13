/**
 * E2E test for P2P display names and message sending/receiving.
 * Uses two isolated browser contexts for two separate identities.
 * Run: npx tsx src/tests/e2e-p2p-messaging.ts
 */

// @ts-nocheck
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = 'http://localhost:8080';

async function getRelayStatus(page: Page): Promise<any> {
  return page.evaluate(() => {
    const ca = (window as any).__nostraChatAPI;
    if(!ca) return {error: 'no ChatAPI'};
    const pool = (ca as any).relayPool;
    if(!pool) return {error: 'no relay pool'};
    const entries = (pool as any).relayEntries || [];
    return {
      state: (ca as any).state,
      activePeer: ca.getActivePeer()?.slice(0, 12),
      relayCount: entries.length,
      relays: entries.map((e: any) => ({
        url: e.config?.url || e.url,
        connected: e.instance?.connectionState || 'unknown'
      }))
    };
  });
}

async function getDiagnostics(page: Page, logs: string[], label: string): Promise<string> {
  const relay = await getRelayStatus(page);
  const published = logs.some((l) => (l.includes('text sent') || l.includes('message published')));
  const relayReceived = logs.some((l) => l.includes('received relay message'));
  const injected = logs.some((l) => l.includes('injectP2PMessage'));
  const chatOpen = await page.evaluate(() => {
    return !!document.querySelector('.bubbles-inner, .chat-input, [contenteditable="true"]');
  });
  return `${label} relay status: ${JSON.stringify(relay)}, published: ${published}, relay received: ${relayReceived}, display bridge injected: ${injected}, chat open: ${chatOpen}`;
}

async function createIdentity(page: Page, displayName: string): Promise<string> {
  await page.goto(APP_URL);
  await page.waitForTimeout(8000);
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
  await page.waitForTimeout(8000); // Extra time for relay pool init
  return npub;
}

async function addContactAndOpenChat(page: Page, npub: string, nickname: string) {
  await page.locator('#new-menu').click();
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

async function main() {
  const browser = await chromium.launch(launchOptions);
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  // Capture all console from both users
  const logsA: string[] = [];
  const logsB: string[] = [];
  pageA.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('Nostra') || t.includes('relay') || t.includes('ChatAPI') || t.includes('SendBridge') || t.includes('text sent') || t.includes('injectP2PMessage') || t.includes('received relay message')) {
      logsA.push(`[A] ${t}`);
    }
  });
  pageB.on('console', (msg) => {
    const t = msg.text();
    if(t.includes('Nostra') || t.includes('relay') || t.includes('ChatAPI') || t.includes('incoming') || t.includes('gift') || t.includes('injectP2PMessage') || t.includes('received relay message')) {
      logsB.push(`[B] ${t}`);
    }
  });

  try {
    console.log('=== Step 1: Create identities ===');
    const npubA = await createIdentity(pageA, 'Alice');
    const npubB = await createIdentity(pageB, 'Bobby');
    console.log('User A:', npubA.slice(0, 24) + '...');
    console.log('User B:', npubB.slice(0, 24) + '...');

    // Check relay status for both users
    console.log('\n=== Relay status after identity creation ===');
    const relayA = await getRelayStatus(pageA);
    const relayB = await getRelayStatus(pageB);
    console.log('User A relays:', JSON.stringify(relayA, null, 2));
    console.log('User B relays:', JSON.stringify(relayB, null, 2));

    // Step 2: User B adds User A FIRST (so B is subscribed before A sends)
    console.log('\n=== Step 2: User B adds User A with nickname "Alice" ===');
    await addContactAndOpenChat(pageB, npubA, 'Alice');

    // Open Alice chat on User B
    const aliceLink = pageB.locator('a').filter({hasText: 'Alice'}).first();
    if(await aliceLink.isVisible({timeout: 5000})) {
      await aliceLink.click();
      await pageB.waitForTimeout(2000);
    }

    // Check User B relay status after adding contact
    const relayB2 = await getRelayStatus(pageB);
    console.log('User B relay status after contact add:', JSON.stringify(relayB2, null, 2));

    // #14: a freshly-opened empty chat shows the "no messages" placeholder.
    const phBefore = await pageB.evaluate(() => document.querySelectorAll('.empty-bubble-placeholder').length);
    console.log('PLACEHOLDER before first message (Bob empty chat):', phBefore);

    // Step 3: User A adds User B
    console.log('\n=== Step 3: User A adds User B with nickname "Bob" ===');
    await addContactAndOpenChat(pageA, npubB, 'Bob');

    // Step 4: Verify display name
    console.log('\n=== Step 4: Verify display name ===');
    const hasNickname = await pageA.evaluate(() => {
      const els = document.querySelectorAll('.dialog-title, .peer-title, a');
      for(const el of els) {
        if(el.textContent?.includes('Bob')) return true;
      }
      return false;
    });
    console.log('TEST DISPLAY NAME:', hasNickname ? 'PASS' : 'FAIL');
    if(!hasNickname) {
      const diagA = await getDiagnostics(pageA, logsA, 'User A');
      console.log('FAIL diagnostics:', diagA);
    }

    // Step 5: User A opens chat with Bob and sends message
    console.log('\n=== Step 5: User A sends message ===');
    const aliceOpened = await pageA.evaluate(() => {
      const chats = document.querySelectorAll('.chatlist-chat');
      for(const c of chats) {
        if(c.textContent?.includes('Bob')) {
          const pid = c.getAttribute('data-peer-id');
          if(pid) {
            (window as any).appImManager?.setPeer({peerId: pid});
            return true;
          }
        }
      }
      return false;
    });
    if(aliceOpened) {
      await pageA.waitForTimeout(2000);

      const msgArea = pageA.locator('[contenteditable="true"]').first();
      await msgArea.click();
      await pageA.keyboard.press('Control+A');
      await pageA.keyboard.press('Delete');
      await msgArea.pressSequentially('Hello from Alice!');
      await pageA.keyboard.press('Enter');

      // Wait for relay propagation
      console.log('Waiting 30s for relay propagation...');
      await pageA.waitForTimeout(30000);

      // Check send logs
      const sendLogs = logsA.filter((l) => l.includes('sending text') || l.includes('text sent') || l.includes('message published') || l.includes('sendTextViaChatAPI'));
      console.log('Send logs:', sendLogs);
      const published = sendLogs.some((l) => (l.includes('text sent') || l.includes('message published')));
      console.log('TEST SEND:', published ? 'PASS' : 'FAIL');
      if(!published) {
        const diagA = await getDiagnostics(pageA, logsA, 'User A');
        console.log('FAIL diagnostics:', diagA);
      }
    }

    // Step 6: Check User B received the message
    console.log('\n=== Step 6: Check User B received message ===');

    // Check if B's relay got any messages
    const receiveLogs = logsB.filter((l) => l.includes('incoming') || l.includes('gift') || l.includes('unwrap') || l.includes('onMessage') || l.includes('EVENT'));
    console.log('User B receive logs:', receiveLogs.length > 0 ? receiveLogs : ['(none)']);

    // B should already have Alice's chat open from Step 2. Only re-open if
    // no chat is currently active (avoids disposing bubbles we just rendered).
    await pageB.waitForTimeout(2000);
    await pageB.evaluate(() => {
      const im = (window as any).appImManager;
      if(im?.chat?.peerId) return;
      const chats = document.querySelectorAll('.chatlist-chat');
      if(!chats[0]) return;
      const pid = chats[0].getAttribute('data-peer-id');
      if(pid) im?.setPeer({peerId: pid});
    });
    await pageB.waitForTimeout(2000);

    let received = await waitForBubble(pageB, 'Hello from Alice!', 30000);

    // Rule 2: If published but not received, retry with extended wait
    if(!received) {
      const published = logsA.some((l) => (l.includes('text sent') || l.includes('message published')));
      if(published) {
        console.log('Message was published but not received. Waiting additional 30s...');
        received = await waitForBubble(pageB, 'Hello from Alice!', 30000);
      }
    }

    console.log('Message in chat BUBBLE:', received);

    // #14: once a real message is rendered, the empty-chat placeholder must be
    // gone (it previously lingered below the message until the chat reopened).
    if(received) {
      await pageB.waitForTimeout(1000);
      const phAfter = await pageB.evaluate(() => document.querySelectorAll('.empty-bubble-placeholder').length);
      console.log('TEST PLACEHOLDER CLEARED (#14):', phAfter === 0 ? 'PASS' : 'FAIL', '(count=' + phAfter + ')');
    }

    if(received) {
      console.log('TEST RECEIVE (bubble): PASS');
    } else {
      const diagA = await getDiagnostics(pageA, logsA, 'User A');
      const diagB = await getDiagnostics(pageB, logsB, 'User B');
      const published = logsA.some((l) => (l.includes('text sent') || l.includes('message published')));
      if(published) {
        console.log('TEST RECEIVE (bubble): FAIL: message published to relay but not received after 30s.');
      } else {
        console.log('TEST RECEIVE (bubble): FAIL: message was not published to relay.');
      }
      console.log('FAIL diagnostics:', diagA);
      console.log('FAIL diagnostics:', diagB);
    }

    // Final relay diagnostics
    console.log('\n=== Final relay diagnostics ===');
    const finalRelayA = await getRelayStatus(pageA);
    const finalRelayB = await getRelayStatus(pageB);
    console.log('User A:', JSON.stringify(finalRelayA, null, 2));
    console.log('User B:', JSON.stringify(finalRelayB, null, 2));

    // Dump all relevant logs
    console.log('\n=== All User A logs ===');
    logsA.forEach((l) => console.log(l));
    console.log('\n=== All User B logs ===');
    logsB.forEach((l) => console.log(l));

  } catch(err) {
    console.error('E2E test error:', err);
  } finally {
    await contextA.close();
    await contextB.close();
    await browser.close();
  }
}

main().catch(console.error);
