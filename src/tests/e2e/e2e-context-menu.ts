// @ts-nocheck
/**
 * E2E Test: 6.16 Context menu on sent messages (with check mark)
 */
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';

const APP_URL = 'http://localhost:8080';

async function dismiss(page) {
  await page.evaluate(() => {
    document.querySelectorAll('vite-plugin-checker-error-overlay').forEach(e => e.remove());
    if(!window.__ov) {
      const obs = new MutationObserver(muts => {
        for(const m of muts) for(const n of m.addedNodes) {
          if(n.tagName?.toLowerCase().includes('vite')) n.remove();
        }
      });
      obs.observe(document.documentElement, {childList: true, subtree: true});
      window.__ov = obs;
    }
  });
}

async function createId(page, name) {
  await page.goto(APP_URL);
  await page.waitForTimeout(10000);
  await dismiss(page);
  await page.getByRole('button', {name: 'Create New Identity'}).click();
  await page.waitForTimeout(2000);
  // Grab npub
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

async function openChatByPeerId(page, peerId) {
  const result = await page.evaluate((pid) => {
    const im = window.appImManager;
    if(!im?.setPeer) return false;
    im.setPeer({peerId: pid});
    return true;
  }, peerId);
  await page.waitForTimeout(5000);
  return result;
}

async function openChatByName(page, name) {
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

async function main() {
  console.log('=== Test 6.16: Context menu on sent messages ===');
  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext({viewport: {width: 1920, height: 1080}});
  const pageA = await ctxA.newPage();
  const ctxB = await browser.newContext({viewport: {width: 1920, height: 1080}});
  const pageB = await ctxB.newPage();

  try {
    const npubA = await createId(pageA, 'UserA_ctx');
    const npubB = await createId(pageB, 'UserB_ctx');
    console.log('npubA:', npubA?.slice(0, 20), 'npubB:', npubB?.slice(0, 20));

    // UserA adds UserB
    await addContact(pageA, npubB, 'Bob');
    await pageA.waitForTimeout(2000);

    // Open chat via setPeer
    await pageA.waitForTimeout(3000);
    await dismiss(pageA);

    const chatOpened = await openChatByName(pageA, 'Bob');
    console.log('Chat opened:', chatOpened);
    if(!chatOpened) {
      await pageA.screenshot({path: '/tmp/e2e-6-16-chat-not-open.png'});
    }
    await dismiss(pageA);

    // Send a message — click on message input specifically, then type
    const msgInput = pageA.locator('.input-message-input[contenteditable="true"]').first();
    await msgInput.click({timeout: 5000});
    await pageA.waitForTimeout(300);
    await pageA.keyboard.type('Hello ctx menu', {delay: 30});
    await pageA.waitForTimeout(500);
    await pageA.keyboard.press('Enter');
    await pageA.waitForTimeout(5000);
    await pageA.screenshot({path: '/tmp/e2e-6-16-after-send.png'});

    // Check for sent bubble
    const bubblePos = await pageA.evaluate(() => {
      const bubbles = document.querySelectorAll('.bubble.is-out');
      if(bubbles.length === 0) return null;
      const last = bubbles[bubbles.length - 1];
      const r = last.getBoundingClientRect();
      return {x: r.left + r.width / 2, y: r.top + r.height / 2};
    });

    if(!bubblePos) {
      await pageA.screenshot({path: '/tmp/e2e-6-16-no-bubble.png'});
      console.error('FAIL: No sent bubble found');
      process.exit(1);
    }

    // Right-click using Playwright's native click
    await pageA.mouse.click(bubblePos.x, bubblePos.y, {button: 'right'});
    await pageA.waitForTimeout(2000);

    // Check for any context menu (multiple possible selectors)
    const menuItems = await pageA.evaluate(() => {
      // Try multiple selectors for the context menu
      const selectors = [
        '.btn-menu.contextmenu',
        '#bubble-contextmenu',
        '.btn-menu:not(.hide)',
        '.contextmenu'
      ];
      for(const sel of selectors) {
        const menu = document.querySelector(sel);
        if(menu && menu.childElementCount > 0) {
          const items = Array.from(menu.querySelectorAll('.btn-menu-item'))
            .map(i => i.textContent?.trim()).filter(Boolean);
          if(items.length > 0) return {selector: sel, items};
        }
      }
      // Debug: list all visible btn-menu elements
      const allMenus = document.querySelectorAll('.btn-menu');
      const debug = Array.from(allMenus).map(m => ({
        id: m.id,
        cls: m.className,
        children: m.childElementCount,
        visible: m.offsetParent !== null
      }));
      return {debug, items: []};
    });

    await pageA.screenshot({path: '/tmp/e2e-6-16.png'});

    console.log('Menu result:', JSON.stringify(menuItems));
    const items = menuItems.items || [];

    // Also check specifically for bubble-contextmenu
    const bubbleMenu = await pageA.evaluate(() => {
      const menu = document.querySelector('#bubble-contextmenu');
      if(!menu) return {exists: false};
      const items = Array.from(menu.querySelectorAll('.btn-menu-item'))
        .map(i => i.textContent?.trim()).filter(Boolean);
      return {exists: true, items};
    });
    console.log('Bubble context menu:', JSON.stringify(bubbleMenu));

    const allItems = bubbleMenu.exists ? bubbleMenu.items : items;
    const hasDelete = allItems.some(i => i.toLowerCase().includes('delete') || i.toLowerCase().includes('elimina'));
    console.log('Has delete option:', hasDelete);

    if(allItems.length >= 2) {
      console.log('Context menu items:', allItems);
      console.log('PASS: 6.16');
    } else {
      console.error('FAIL: Context menu not found or too few items');
      process.exit(1);
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error('FAIL:', err.message); process.exit(1); });
