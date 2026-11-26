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
  // tsx preserves local function names with this helper when serializing
  // callbacks into page.evaluate; provide it inside the disposable context.
  await context.addInitScript('globalThis.__name = (fn) => fn;');
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
    await page.evaluate(() => {
      const adm = window.appDialogsManager;
      const target = document.querySelector('.menu-horizontal-div-item[data-filter-id="4"]');
      adm.selectTab([...target.parentElement.children].indexOf(target), false);
    });
    await page.waitForFunction(() => window.appDialogsManager.filterId === 4 && window.appDialogsManager.xd.sortedList.hasFetchedDialogs());
    // Add exactly one contact while Chats is inactive. Its warm list must
    // receive the live row without waiting for activation or a refetch.
    await page.evaluate(async() => {
      const {addP2PContact} = await import('/src/lib/phantomchat/add-p2p-contact.ts');
      const contact = await addP2PContact({pubkey: '11'.repeat(32), nickname: 'Single contact', deliberate: true, source: 'empty-state-regression'});
      window.__cachedContactPeerId = contact.peerId;
      // Hydrate the Worker's previously empty dialog cache through the real
      // reload path before measuring folder reloads.
      await window.rootScope.managers.appMessagesManager.reloadConversation(contact.peerId);
      const adm = window.appDialogsManager;
      const list = adm.xds[0];
      const fetch = list.dialogsFetcher.bind(list);
      window.__folderFetchCount = 0;
      list.dialogsFetcher = async(...args) => {
        window.__folderFetchCount++;
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
            loaded: list.sortedList.hasFetchedDialogs(),
            rows: list.sortedList.itemsLength(),
            pane: !!list.sortedList.list.parentElement.querySelector('.empty-placeholder')
          });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    for(let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(() => {
        const adm = window.appDialogsManager;
        const target = document.querySelector('.menu-horizontal-div-item[data-filter-id="0"]');
        adm.selectTab([...target.parentElement.children].indexOf(target), false);
      });
      await page.waitForFunction(() => window.appDialogsManager.filterId === 0 && window.appDialogsManager.xd.sortedList.hasFetchedDialogs() && window.appDialogsManager.xd.sortedList.itemsLength() === 1);
      if(cycle === 0) {
        // The contact's initial storage hydration may refetch the previously
        // empty folder once. Measure only subsequent warm-folder switches.
        await page.waitForTimeout(350);
        await page.evaluate(() => {
          const adm = window.appDialogsManager;
          window.__cachedDialogElement = adm.xds[0].sortedList.getDialogElement(window.__cachedContactPeerId);
          window.__folderFetchCount = 0;
        });
      }
      await page.evaluate(() => {
        const adm = window.appDialogsManager;
        const target = document.querySelector('.menu-horizontal-div-item[data-filter-id="4"]');
        adm.selectTab([...target.parentElement.children].indexOf(target), false);
      });
      await page.waitForFunction(() => window.appDialogsManager.filterId === 4 && window.appDialogsManager.xd.sortedList.hasFetchedDialogs());
    }
    const {frames, fetchCount, sameRows} = await page.evaluate(() => {
      window.__stopEmptyPaneSampling();
      const adm = window.appDialogsManager;
      return {
        frames: window.__emptyPaneFrames,
        fetchCount: window.__folderFetchCount,
        sameRows: adm.xds[0].sortedList.getDialogElement(window.__cachedContactPeerId) === window.__cachedDialogElement
      };
    });
    console.log('frame transitions:', JSON.stringify(frames.filter((frame, i) => !i || JSON.stringify(frame) !== JSON.stringify(frames[i - 1]))));
    assert.ok(frames.length > 0, 'sampled Chats frames');
    assert.ok(frames.every(frame => frame.loaded), 'the warm list stays loaded on every switch');
    assert.ok(frames.every(frame => frame.rows === 1), 'the single contact paints immediately on every switch');
    assert.equal(frames.filter(frame => frame.pane).length, 0, 'no empty artwork during Chats transitions');
    assert.equal(fetchCount, 0, 'repeat switches do not call the worker');
    assert.ok(sameRows, 'repeat switches retain the row objects');
    console.log(`PASS: ${frames.length} animation frames across 3 Sessions → Chats switches, immediate retained rows, zero refetches, no empty artwork`);
  } catch(error) {
    console.error(await page.evaluate(() => ({menus: [...document.querySelectorAll('.btn-menu')].map((n) => n.textContent), body: document.body.className, filter: window.appDialogsManager?.filterId, loaded: window.appDialogsManager?.xd?.loadedDialogsAtLeastOnce, tabs: [...document.querySelectorAll('.menu-horizontal-div-item')].map(e => ({id:e.dataset.filterId, cls:e.className}))})));
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
