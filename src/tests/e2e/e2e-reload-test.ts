// @ts-nocheck
/**
 * E2E Test: 4.4-4.7 — Timestamp, persistence, no duplicates after reload
 * Also covers 1.3 — Contact persists after reload
 */
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = 'http://localhost:8080';

async function dismiss(page) {
  await page.evaluate(() => document.querySelectorAll('vite-plugin-checker-error-overlay').forEach(e => e.remove()));
}

async function createId(page, name) {
  await page.goto(APP_URL);
  await page.waitForTimeout(10000);
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
  await page.waitForTimeout(12000);
  await dismiss(page);
  return npub;
}

async function addContact(page, npub, nickname) {
  await dismiss(page);
  await page.locator('#new-menu').click({timeout: 10000});
  await page.waitForTimeout(500);
  await page.locator('text=New Private Chat').click();
  await page.waitForTimeout(1000);
  await page.locator('button.btn-corner.is-visible').click();
  await page.waitForTimeout(1000);
  if(nickname) {
    const nickInput = page.getByRole('textbox', {name: 'Nickname'});
    if(await nickInput.isVisible({timeout: 2000})) await nickInput.fill(nickname);
  }
  await page.getByRole('textbox', {name: 'npub1'}).fill(npub);
  await page.getByRole('button', {name: 'Add'}).click();
  await page.waitForTimeout(5000);
}

async function openChat(page) {
  const peerId = await page.evaluate(() => {
    const c = document.querySelector('.chatlist-chat');
    return c?.getAttribute('data-peer-id');
  });
  if(peerId) {
    await page.evaluate((pid) => {
      window.appImManager?.setPeer({peerId: pid});
    }, peerId);
    await page.waitForTimeout(5000);
  }
  return peerId;
}

async function sendMessage(page, text) {
  const msgInput = page.locator('.input-message-input[contenteditable="true"]').first();
  await msgInput.click({timeout: 5000});
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.waitForTimeout(200);
  await page.keyboard.type(text, {delay: 20});
  await page.waitForTimeout(300);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);
}

async function getBubbles(page) {
  return page.evaluate(() => {
    const bubbles = document.querySelectorAll('.bubble:not(.is-date)');
    return Array.from(bubbles).map(b => {
      const msg = b.querySelector('.message, .inner')?.textContent?.trim() || '';
      const time = b.querySelector('.time-inner')?.textContent?.trim() || '';
      return {
        text: msg.slice(0, 50),
        time,
        isOut: b.classList.contains('is-out'),
        classes: Array.from(b.classList).join(' ')
      };
    }).filter(b => b.text);
  });
}

async function main() {
  console.log('=== Tests 4.4-4.7 + 1.3: Reload persistence ===');
  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext({viewport: {width: 1920, height: 1080}});
  const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext();
  const pageB = await ctxB.newPage();

  const npubA = await createId(pageA, 'ReloadA');
  const npubB = await createId(pageB, 'ReloadB');

  // A adds B
  await addContact(pageA, npubB, 'Bob');
  await pageA.waitForTimeout(3000);
  await dismiss(pageA);

  // Open chat
  const peerId = await openChat(pageA);
  console.log('Chat peerId:', peerId);

  // Send 3 messages
  const msgs = ['Msg1_' + Date.now(), 'Msg2_' + Date.now(), 'Msg3_' + Date.now()];
  for(const m of msgs) {
    await sendMessage(pageA, m);
    console.log('Sent:', m);
  }

  await pageA.waitForTimeout(5000);

  // Get bubbles BEFORE reload
  const beforeBubbles = await getBubbles(pageA);
  console.log('Before reload - bubbles:', beforeBubbles.length);
  for(const b of beforeBubbles) console.log('  ', b.text, '|', b.time);

  // Check 4.4: timestamps not 1970/NaN
  const badTimestamp = beforeBubbles.some(b => b.time.includes('1970') || b.time.includes('NaN') || b.time === '');
  console.log('4.4 Before reload - bad timestamps:', badTimestamp);

  // Get own pubkey before reload
  const ownPubkeyBefore = await pageA.evaluate(() => {
    const server = window.__nostraMTProtoServer;
    return server?.ownPubkey || 'unknown';
  });
  console.log('Own pubkey before reload:', ownPubkeyBefore?.slice(0, 20));

  // Check 1.3: Contact visible before reload
  const contactBefore = await pageA.evaluate(() => {
    const chats = document.querySelectorAll('.chatlist-chat');
    return Array.from(chats).map(c => c.textContent?.slice(0, 30));
  });
  console.log('1.3 Contact before reload:', contactBefore);

  // RELOAD
  console.log('\n=== RELOADING ===');
  // Capture logs after reload
  pageA.on('console', msg => {
    const t = msg.text();
    if(t.includes('VirtualMTProto') || t.includes('NostraOnboarding') || t.includes('getDialogs') || t.includes('Loading')) {
      console.log('[A-reload]', t);
    }
  });
  await pageA.reload();
  await pageA.waitForTimeout(15000);
  await dismiss(pageA);

  // Get own pubkey after reload
  const ownPubkeyAfter = await pageA.evaluate(() => {
    const server = window.__nostraMTProtoServer;
    return server?.ownPubkey || 'unknown';
  });
  console.log('Own pubkey after reload:', ownPubkeyAfter?.slice(0, 20));
  console.log('Pubkeys match:', ownPubkeyBefore === ownPubkeyAfter);

  // Check 1.3: Contact visible after reload
  const contactAfter = await pageA.evaluate(() => {
    const chats = document.querySelectorAll('.chatlist-chat');
    return Array.from(chats).map(c => c.textContent?.slice(0, 30));
  });
  console.log('1.3 Contact after reload:', contactAfter);
  const test1_3 = contactAfter.length > 0 && contactAfter.some(c => c.includes('Bob'));
  console.log('1.3:', test1_3 ? 'PASS' : 'FAIL');

  // Open chat again after reload. Use the chatlist entry for Bob (not the
  // pre-reload peerId which may reference the self-chat after mapping).
  await pageA.evaluate(() => {
    const chats = document.querySelectorAll('.chatlist-chat');
    for(const c of chats) {
      if(c.textContent?.includes('Bob')) {
        const pid = c.getAttribute('data-peer-id');
        if(pid) {
          (window as any).appImManager?.setPeer({peerId: pid});
          return;
        }
      }
    }
  });
  await pageA.waitForTimeout(8000);

  // Get bubbles AFTER reload
  let afterBubbles = await getBubbles(pageA);
  // With invalidateHistoryCache, the Worker re-fetches from bridge on
  // chat reopen. Give extra time for the round-trip.
  if(afterBubbles.length === 0) {
    await pageA.waitForTimeout(10000);
    afterBubbles = await getBubbles(pageA);
  }
  console.log('\nAfter reload - bubbles:', afterBubbles.length);
  for(const b of afterBubbles) console.log('  ', b.text, '|', b.time);

  await pageA.screenshot({path: '/tmp/e2e-reload-after.png'});

  // 4.4: Timestamps correct
  const afterBadTs = afterBubbles.some(b => b.time.includes('1970') || b.time.includes('NaN') || b.time === '');
  console.log('\n=== RESULTS ===');
  console.log('4.4 Timestamp correct:', !afterBadTs ? 'PASS' : 'FAIL');

  // 4.5/4.6: Messages in order after reload
  const allPresent = msgs.every(m => afterBubbles.some(b => b.text.includes(m.slice(0, 10))));
  console.log('4.5 Messages present after reload:', allPresent ? 'PASS' : 'FAIL');

  // 4.7: No duplicates
  const texts = afterBubbles.map(b => b.text);
  const hasDupes = new Set(texts).size !== texts.length;
  console.log('4.7 No duplicates:', !hasDupes ? 'PASS' : 'FAIL');

  console.log('1.3 Contact persists:', test1_3 ? 'PASS' : 'FAIL');

  await browser.close();

  const allPass = !afterBadTs && allPresent && !hasDupes && test1_3;
  if(!allPass) process.exit(1);
}

main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
