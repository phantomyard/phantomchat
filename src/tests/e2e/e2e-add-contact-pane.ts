// @ts-nocheck
/**
 * New Contact pane: opens from the tools menu and the Contacts tab +, slides
 * in over the chat list in the LEFT column, adds a contact and closes. Runs on
 * a desktop and a phone viewport against real Worker/IDB and an isolated relay.
 *
 *   npx vite --port 8080 &   # dev server
 *   npx tsx src/tests/e2e/e2e-add-contact-pane.ts
 *
 * E2E_SHOTS=<dir> also writes screenshots of each state.
 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {WebSocketServer} from 'ws';
import {launchOptions} from './helpers/launch-options';
import {dismissOverlays} from './helpers/dismiss-overlays';

const NPUB = 'npub1zutzeysacnf9rru6zqwmxd54mud0k44tst6l70ja5mhv8jjumytsd2x7nu';
const SHOTS = process.env.E2E_SHOTS;

async function run(browser, relayUrl, viewport, label) {
  const context = await browser.newContext({viewport});
  await context.addInitScript((url) => {
    window.__phantomchatTestRelays = [{url, read: true, write: true}];
  }, relayUrl);
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const shot = async(name) => SHOTS && page.screenshot({path: `${SHOTS}/${label}-${name}.png`});
  const pane = page.locator('.add-contact-container');
  // Playwright's isVisible() is true for the transform-hidden chat list, so the
  // check is where it sits: while a tab covers it the chat list's item is out
  // of layout (zero width), and closing the tab puts it back inside the column.
  const chatListInColumn = async() => {
    const b = await page.locator('#column-left .item-main').boundingBox();
    const column = await page.locator('#column-left').boundingBox();
    return !!b && !!column && b.width > 0 && b.x >= column.x - 1;
  };

  await page.goto(process.env.E2E_APP_URL || 'http://localhost:8080', {waitUntil: 'load'});
  await page.getByRole('button', {name: 'Create New Identity'}).waitFor({timeout: 90000});
  await dismissOverlays(page);
  await page.getByRole('button', {name: 'Create New Identity'}).click();
  await page.getByRole('button', {name: 'Continue', exact: true}).click();
  await page.getByRole('textbox').first().fill('Pane Test');
  await page.getByRole('button', {name: 'Get Started'}).click();
  await page.waitForFunction(() => window.rootScope?.managers && window.appImManager, undefined, {timeout: 90000});
  await page.locator('.sidebar-tools-button:visible').first().waitFor({state: 'visible', timeout: 60000});
  await dismissOverlays(page);
  await page.waitForTimeout(1500);

  // 1. Tools menu -> pane in the LEFT column, no modal overlay.
  await page.locator('.sidebar-tools-button:visible').first().click();
  await page.locator('.btn-menu-item', {hasText: 'Add to contacts'}).first().click();
  await pane.waitFor({state: 'visible', timeout: 10000});
  await page.waitForTimeout(600); // slide-in transition
  assert.equal(await page.locator('.popup-add-contact-overlay').count(), 0, 'no modal overlay');
  assert.equal((await pane.locator('.sidebar-header .title, .sidebar-header').first().innerText()).includes('New Contact'), true, 'title');
  // The whole point: it is a left-column tab, not a right-sidebar one.
  assert.equal(await pane.evaluate((el) => !!el.closest('#column-left')), true, 'pane lives in the left column');
  assert.equal(await pane.evaluate((el) => !!el.closest('#column-right')), false, 'pane is not in the right column');
  const box = await pane.boundingBox();
  assert.ok(box && box.width > 0, 'pane has width');
  assert.ok(box.x < viewport.width / 2, `pane is on the left (x=${box.x})`);
  if(viewport.width <= 500) {
    // Phone: the left column is the screen.
    assert.ok(box.width >= viewport.width - 2, `pane covers the phone width (w=${box.width})`);
  }
  assert.equal(await pane.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true, 'no horizontal scroll');
  await page.locator('[data-testid="add-contact-submit"]').waitFor({state: 'visible'});
  await shot('1-phantom');

  // Human hides Local tools and keeps Notifications.
  await page.locator('[data-testid="add-contact-kind-human"]').click();
  await page.waitForTimeout(300);
  await shot('2-human');

  // A toggle row flips on a real click.
  const notif = page.locator('[data-testid="add-contact-notifications"]');
  assert.equal(await notif.isChecked(), true);
  await page.locator('[data-testid="add-contact-notifications-row"]').click();
  assert.equal(await notif.isChecked(), false, 'row click flips Notifications');
  await page.locator('[data-testid="add-contact-notifications-row"]').click();
  assert.equal(await notif.isChecked(), true);

  // Bad npub keeps the pane open with an error.
  await page.locator('[data-testid="add-contact-npub"]').fill('npub1nope');
  await page.locator('[data-testid="add-contact-submit"]').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('[data-testid="add-contact-error"]').innerText(), 'Invalid npub format');
  assert.equal(await pane.isVisible(), true);

  // Back button closes the pane without adding and leaves the chat list up.
  await pane.locator('.sidebar-close-button').first().click();
  await pane.waitFor({state: 'detached', timeout: 10000});
  await page.waitForTimeout(600);
  assert.equal(await chatListInColumn(), true, 'closing the pane returns to the chat list');
  await shot('2b-closed');

  // 2. Contacts tab + opens the same pane; a valid add closes it and opens the chat.
  await page.locator('.sidebar-tools-button:visible').first().click();
  await page.locator('.btn-menu-item', {hasText: 'Contacts'}).first().click();
  await page.locator('#contacts-container .btn-corner').waitFor({state: 'visible', timeout: 10000});
  await page.waitForTimeout(500);
  await page.locator('#contacts-container .btn-corner').click();
  await pane.waitFor({state: 'visible', timeout: 10000});
  await page.waitForTimeout(600);
  assert.equal(await pane.evaluate((el) => !!el.closest('#column-left')), true, 'Contacts + opens it in the left column too');
  await shot('3-from-contacts');
  await page.locator('[data-testid="add-contact-npub"]').fill(NPUB);
  await page.locator('[data-testid="add-contact-name"]').fill('Pane Friend');
  await page.waitForTimeout(300);
  await shot('4-filled');
  await page.locator('[data-testid="add-contact-submit"]').click();
  await pane.waitFor({state: 'detached', timeout: 20000});
  await page.waitForFunction(() => document.querySelector('.chat .top .peer-title')?.textContent?.includes('Pane Friend'), undefined, {timeout: 20000});
  await page.waitForTimeout(800);
  await shot('5-added');

  if(viewport.width <= 500) {
    // The pane closes and then the Contacts tab under it closes: the left
    // column must be back on the chat list, with no pane or tab stuck on top.
    await page.evaluate(() => window.appImManager.selectTab(0)); // APP_TABS.CHATLIST
    await page.waitForTimeout(800);
    assert.equal(await pane.count(), 0, 'no stuck pane after the add');
    assert.equal(await chatListInColumn(), true, 'the left column shows the chat list after the add');
    await shot('6-back-to-list');
  }

  assert.deepEqual(errors, [], 'no page errors');
  await context.close();
  console.log(`[${label}] OK`);
}

async function main() {
  const relay = new WebSocketServer({host: '127.0.0.1', port: 0});
  await new Promise((resolve) => relay.once('listening', resolve));
  relay.on('connection', (socket) => socket.on('message', (raw) => {
    const [type, id] = JSON.parse(String(raw));
    if(type === 'REQ') socket.send(JSON.stringify(['EOSE', id]));
    if(type === 'EVENT') socket.send(JSON.stringify(['OK', id.id, true, '']));
  }));
  const relayUrl = `ws://127.0.0.1:${relay.address().port}`;
  // E2E_CHROMIUM=<path> runs a locally installed browser build.
  const browser = await chromium.launch({...launchOptions, ...(process.env.E2E_CHROMIUM && {executablePath: process.env.E2E_CHROMIUM})});
  try {
    await run(browser, relayUrl, {width: 1280, height: 800}, 'desktop');
    await run(browser, relayUrl, {width: 390, height: 844}, 'phone');
  } finally {
    await browser.close();
    relay.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
