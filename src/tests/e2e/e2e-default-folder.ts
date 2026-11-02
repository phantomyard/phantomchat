// @ts-nocheck
/** Default-folder gestures, rail ordering and reloads against real Worker/IDB. */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {WebSocketServer} from 'ws';
import {launchOptions} from './helpers/launch-options';
import {dismissOverlays} from './helpers/dismiss-overlays';

async function main() {
  // No peer traffic is needed: isolated relay acknowledges this disposable
  // identity's profile/config writes and returns empty subscription histories.
  const relay = new WebSocketServer({host: '127.0.0.1', port: 0});
  await new Promise((resolve) => relay.once('listening', resolve));
  relay.on('connection', (socket) => socket.on('message', (raw) => {
    const [type, id] = JSON.parse(String(raw));
    if(type === 'REQ') socket.send(JSON.stringify(['EOSE', id]));
    if(type === 'EVENT') socket.send(JSON.stringify(['OK', id.id, true, '']));
  }));
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({viewport: {width: 1280, height: 800}});
  await context.addInitScript((url) => {
    window.__phantomchatTestRelays = [{url, read: true, write: true}];
  }, `ws://127.0.0.1:${relay.address().port}`);
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => console.error('browser:', error.message));
  try {
    await page.goto(process.env.E2E_APP_URL || 'http://localhost:8080', {waitUntil: 'load'});
    await page.waitForTimeout(5000);
    await page.reload({waitUntil: 'load'});
    await page.getByRole('button', {name: 'Create New Identity'}).waitFor({timeout: 60000});
    await dismissOverlays(page);
    await page.getByRole('button', {name: 'Create New Identity'}).click();
    await page.getByRole('button', {name: 'Continue', exact: true}).click();
    await page.getByRole('textbox').first().fill('Default Folder Test');
    await page.getByRole('button', {name: 'Get Started'}).click();
    const ready = async() => {
      await page.waitForFunction(() => window.rootScope?.managers?.filtersStorage && window.appImManager);
      await page.locator('.menu-horizontal-div-item[data-filter-id="4"]').waitFor({state: 'attached'});
      await dismissOverlays(page);
    };
    const selected = async(id) => {
      await page.waitForFunction((id) =>
        document.querySelector('.menu-horizontal-div-item.active')?.getAttribute('data-filter-id') === String(id), id);
    };
    const rail = (vertical) => vertical ? '.folders-sidebar__folder-item[data-filter-id]' : '.menu-horizontal-div-item[data-filter-id]';
    const order = async(vertical) => {
      const ids = await page.locator(rail(vertical)).evaluateAll((nodes) => nodes.map((n) => Number(n.dataset.filterId)));
      assert.equal(ids[0], 0, 'Chats is leftmost: ' + ids);
    };
    const gesture = async(id, text, vertical = false) => {
      // Switching to the top strip opens the Ctrl+F tip; its capture
      // overlay consumes the next input. Dismiss it before the menu gesture.
      await page.mouse.click(1200, 700);
      await page.locator(`${rail(vertical)}[data-filter-id="${id}"]`).click({button: 'right'});
      await page.locator('.btn-menu-item').filter({hasText: text}).last().click();
    };
    await ready();
    console.log('browser ready');
    await page.evaluate(async() => {
      const {setFoldersSidebarEnabled} = await import('/src/lib/folders-sidebar-layout.ts');
      setFoldersSidebarEnabled(false);
    });
    await page.locator('.menu-horizontal-div-item[data-filter-id="4"]').waitFor({state: 'visible'});
    await selected(0);
    await order(false);
    console.log('setting Sessions default');
    await gesture(4, 'Set as Default');
    await selected(4);
    await order(false);
    await page.reload({waitUntil: 'load'});
    await ready();
    await selected(4);
    await gesture(4, 'Use Chats as Default');
    await selected(0);
    await order(false);
    await page.reload({waitUntil: 'load'});
    await ready();
    await selected(0);
    console.log('PASS horizontal rail: set, immediate selection, reload, remove, Chats fallback');

    await page.evaluate(async() => {
      const {setFoldersSidebarEnabled} = await import('/src/lib/folders-sidebar-layout.ts');
      setFoldersSidebarEnabled(true);
    });
    await page.locator('.folders-sidebar__folder-item[data-filter-id="4"]').waitFor({state: 'visible'});
    await order(true);
    await gesture(4, 'Set as Default', true);
    await selected(4);
    await order(true);
    await page.reload({waitUntil: 'load'});
    await ready();
    await selected(4);
    await order(true);
    await gesture(4, 'Use Chats as Default', true);
    await selected(0);
    await order(true);
    await page.reload({waitUntil: 'load'});
    await ready();
    await selected(0);
    await order(true);
    console.log('PASS vertical rail: set, immediate selection, reload, remove, Chats fallback');
  } catch(error) {
    console.error(await page.evaluate(() => ({menus: [...document.querySelectorAll('.btn-menu')].map((n) => n.textContent), body: document.body.className})));
    if(process.env.PHANTOMBOT_SCRATCH) await page.screenshot({path: process.env.PHANTOMBOT_SCRATCH + '/default-folder-failure.png'});
    throw error;
  } finally {
    await context.close();
    await browser.close();
    for(const socket of relay.clients) socket.terminate();
    await new Promise((resolve) => relay.close(resolve));
  }
}
main().catch((error) => {console.error(error); process.exitCode = 1;});
