// @ts-nocheck
/** Empty Chats artwork during folder switches against real Worker/IDB. */
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
    await page.getByRole('textbox').first().fill('Empty Pane Test');
    await page.getByRole('button', {name: 'Get Started'}).click();
    await page.waitForFunction(() => window.appDialogsManager?.xd?.loadedDialogsAtLeastOnce, undefined, {timeout: 60000});
    await dismissOverlays(page);
    await page.evaluate(async() => {
      const {setFoldersSidebarEnabled} = await import('/src/lib/folders-sidebar-layout.ts');
      setFoldersSidebarEnabled(false);
    });
    await page.waitForFunction(() => !!document.querySelector('[data-filter-id="0"] .empty-placeholder.visible'));
    await page.locator('.menu-horizontal-div-item[data-filter-id="4"]').click();
    // Add exactly one contact while Chats is inactive. Its previously empty
    // pane remains in that folder's DOM until activation reconciles it.
    await page.evaluate(async() => {
      const {addP2PContact} = await import('/src/lib/phantomchat/add-p2p-contact.ts');
      await addP2PContact({pubkey: '11'.repeat(32), nickname: 'Single contact', source: 'empty-state-regression'});
      const adm = window.appDialogsManager;
      const list = adm.xds[0];
      const fetch = list.dialogsFetcher.bind(list);
      list.dialogsFetcher = async(...args) => {
        await new Promise(resolve => setTimeout(resolve, 300));
        return fetch(...args);
      };
      window.__emptyPaneFrames = [];
      let sampling = true;
      window.__stopEmptyPaneSampling = () => { sampling = false; };
      const sample = () => {
        if(!sampling) return;
        if(adm.filterId === 0) {
          window.__emptyPaneFrames.push({
            loaded: !!list.loadedDialogsAtLeastOnce,
            rows: list.sortedList.itemsLength(),
            pane: !!list.sortedList.list.parentElement.querySelector('.empty-placeholder')
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    for(let cycle = 0; cycle < 3; cycle++) {
      await page.locator('.menu-horizontal-div-item[data-filter-id="0"]').click();
      await page.waitForFunction(() => window.appDialogsManager.filterId === 0 && window.appDialogsManager.xd.loadedDialogsAtLeastOnce && window.appDialogsManager.xd.sortedList.itemsLength() === 1);
      await page.locator('.menu-horizontal-div-item[data-filter-id="4"]').click();
    }
    const frames = await page.evaluate(() => {
      window.__stopEmptyPaneSampling();
      return window.__emptyPaneFrames;
    });
    assert.ok(frames.some(frame => !frame.loaded), 'sampled pending fetch frames');
    assert.ok(frames.some(frame => frame.rows === 1), 'sampled the single contact');
    assert.equal(frames.filter(frame => frame.pane).length, 0, 'no empty artwork during Chats transitions');
    console.log(`PASS: ${frames.length} animation frames across 3 Sessions → Chats switches, one real contact, 300ms delayed real fetch, no empty artwork`);
  } catch(error) {
    console.error(await page.evaluate(() => ({menus: [...document.querySelectorAll('.btn-menu')].map((n) => n.textContent), body: document.body.className})));
    if(process.env.PHANTOMBOT_SCRATCH) await page.screenshot({path: process.env.PHANTOMBOT_SCRATCH + '/empty-pane-failure.png'});
    throw error;
  } finally {
    await context.close();
    await browser.close();
    for(const socket of relay.clients) socket.terminate();
    await new Promise((resolve) => relay.close(resolve));
  }
}
main().catch((error) => {console.error(error); process.exitCode = 1;});
