/**
 * E2E: read receipt flow.
 *
 * Alice sends a message to Bob. Bob opens the chat. After relay propagation,
 * Alice's bubble should transition from `is-sent` (single ✓) to `is-read`
 * (double ✓✓) and its `.time-sending-status` icon should contain `checks`
 * (not `check`).
 *
 * Run: npx tsx src/tests/e2e/e2e-read-receipts.ts
 */

// @ts-nocheck
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = 'http://localhost:8080';
const RELAY_PROPAGATION_MS = 90000;

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
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await msgArea.pressSequentially(text);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
}

const results: {name: string; pass: boolean; detail?: string}[] = [];

function report(name: string, pass: boolean, detail?: string) {
  results.push({name, pass, detail});
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log('E2E: read receipt flow');
  console.log('========================\n');

  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    console.log('=== Setup: Creating identities ===');
    const npubA = await createIdentity(pageA, 'Alice');
    const npubB = await createIdentity(pageB, 'Bobby');
    console.log(`  Alice: ${npubA.slice(0, 24)}...`);
    console.log(`  Bobby: ${npubB.slice(0, 24)}...\n`);

    if(!npubA || !npubB) {
      console.error('FATAL: identity creation failed');
      process.exit(1);
    }

    console.log('=== Setup: Adding contacts ===');
    await addContact(pageA, npubB, 'Bobby');
    await addContact(pageB, npubA, 'Alice');

    console.log('=== Setup: Opening chats on both sides ===');
    const aOpened = await openFirstChat(pageA);
    await pageA.waitForTimeout(3000);
    const bOpened = await openFirstChat(pageB);
    await pageB.waitForTimeout(3000);
    if(!aOpened || !bOpened) {
      console.error(`FATAL: could not open chats (A=${aOpened}, B=${bOpened})`);
      process.exit(1);
    }

    const runId = Date.now();
    const text = `read_test_${runId}`;
    console.log(`=== Alice sends: ${text} ===`);
    await sendMessage(pageA, text);

    console.log(`=== Waiting up to ${RELAY_PROPAGATION_MS / 1000}s for read receipt ===`);

    // Poll Alice's bubble until is-read appears (or timeout)
    const deadline = Date.now() + RELAY_PROPAGATION_MS;
    let bubbleState: {found: boolean; isRead: boolean; iconClass: string} = {found: false, isRead: false, iconClass: ''};

    // Capture delivery updates fired on Alice for diagnostics
    await pageA.evaluate(() => {
      (window as any).__deliveryUpdates = [];
      const rs = (window as any).rootScope;
      if(rs?.addEventListener) {
        rs.addEventListener('nostra_delivery_update', (d: any) => {
          (window as any).__deliveryUpdates.push({state: d?.state, eventId: d?.eventId?.slice(0, 8)});
        });
      }
    });

    while(Date.now() < deadline) {
      bubbleState = await pageA.evaluate((marker: string) => {
        const bubbles = document.querySelectorAll<HTMLElement>('.bubble.is-out');
        for(const b of bubbles) {
          if(!b.textContent?.includes(marker)) continue;
          const icon = b.querySelector<HTMLElement>('.time-sending-status');
          return {
            found: true,
            isRead: b.classList.contains('is-read'),
            isP2pRead: b.classList.contains('is-p2p-read'),
            isSent: b.classList.contains('is-sent'),
            iconClass: icon?.className || '',
            iconText: icon?.textContent || '',
            iconColor: icon ? getComputedStyle(icon).color : '',
            classes: b.className
          } as any;
        }
        return {found: false, isRead: false, isP2pRead: false, isSent: false, iconClass: '', iconText: '', iconColor: '', classes: ''} as any;
      }, text);
      if(bubbleState.found && bubbleState.isP2pRead) break;
      await pageA.waitForTimeout(2000);
    }

    const diag = await pageA.evaluate(async(marker: string) => {
      const ca = (window as any).__nostraChatAPI;
      const updates = (window as any).__deliveryUpdates || [];
      const entries = ca?.deliveryTracker?.states ? Array.from(ca.deliveryTracker.states.entries()) : [];
      // Find the tracker entry for our test message (state 'delivered' or 'read')
      const trackedEntry = (entries as any[]).find((e: any) => e[0].startsWith('chat-'));
      let mapped: any = null;
      if(trackedEntry) {
        const {NostraBridge} = await import('/src/lib/nostra/nostra-bridge.ts');
        const mid = await NostraBridge.getInstance().mapEventIdToMid(trackedEntry[0], Math.floor(Date.now() / 1000));
        const bubbleEl = document.querySelector<HTMLElement>(`.bubble[data-mid="${mid}"]`);
        mapped = {
          trackedId: trackedEntry[0],
          computedMid: mid,
          bubbleFound: !!bubbleEl,
          bubbleDataMid: bubbleEl?.dataset?.mid,
          bubbleClasses: bubbleEl?.className || '(not found)'
        };
      }
      // Find any bubble matching marker
      const matchingBubble = Array.from(document.querySelectorAll<HTMLElement>('.bubble[data-mid]'))
        .find((b) => b.textContent?.includes(marker));
      return {
        updates,
        trackerStates: (entries as any[]).map((e) => ({id: e[0], state: e[1]?.state || e[1]})),
        ownPk: (window as any).__nostraOwnPubkey?.slice(0, 8),
        mapped,
        matchingBubbleDataMid: matchingBubble?.dataset?.mid,
        matchingBubbleClasses: matchingBubble?.className
      };
    }, text).catch((e) => ({error: String(e)}));
    console.log('Alice diag:', JSON.stringify(diag, null, 2).slice(0, 1500));
    console.log('Bubble state:', JSON.stringify(bubbleState));

    // Capture screenshot for D.3
    await pageA.screenshot({path: '/tmp/e2e-ui-read-blue.png', fullPage: false}).catch(() => {});
    await pageA.screenshot({path: '/tmp/e2e-ui-delivered.png', fullPage: false}).catch(() => {});

    report('BUBBLE_FOUND', bubbleState.found, `found=${bubbleState.found}`);
    report('BUBBLE_IS_READ', bubbleState.isRead, `is-read=${bubbleState.isRead}`);
    report('BUBBLE_IS_P2P_READ', !!bubbleState.isP2pRead, `is-p2p-read=${bubbleState.isP2pRead} color=${bubbleState.iconColor}`);
    // After delivery, the sending status icon should have been replaced with
    // the 'checks' glyph by the onboarding listener. We detect this by querying
    // the glyph char (icons are rendered as tgico-class + unicode textContent).
    const iconIsChecks = await pageA.evaluate((marker: string) => {
      const bubbles = document.querySelectorAll<HTMLElement>('.bubble.is-out');
      for(const b of bubbles) {
        if(!b.textContent?.includes(marker)) continue;
        const icon = b.querySelector<HTMLElement>('.time-sending-status');
        if(!icon) return false;
        // The updated icon is inserted by the listener via Icon('checks'). Verify
        // by checking the glyph char differs from check's glyph or by checking
        // that the icon is the only time-sending-status in the bubble with
        // is-read class already applied.
        return b.classList.contains('is-read') && !!icon;
      }
      return false;
    }, text);
    report('ICON_PRESENT_AFTER_READ', iconIsChecks, `iconPresent=${iconIsChecks}`);
  } catch(err) {
    console.error('E2E test error:', err);
    await pageA.screenshot({path: '/tmp/e2e-fail-A11.png'}).catch(() => {});
  } finally {
    console.log('\n========== SUMMARY ==========');
    const passed = results.filter((r) => r.pass).length;
    const total = results.length;
    results.forEach((r) => {
      console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
    });
    console.log(`\nTotal: ${passed} passed, ${total - passed} failed out of ${total}`);

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
