// @ts-nocheck
/**
 * Clicking the row of the ALREADY-OPEN group in the chat list:
 *   - side by side with the chat pane (wide)  -> opens the edit sidebar
 *   - chat replaces the list (narrow)         -> opens the chat, as before
 *
 *   npx vite --port 8080 &
 *   pnpm exec tsx src/tests/e2e/e2e-selected-row-click.ts
 *
 * Uses the app's own singletons off `window` (appImManager / mediaSizes /
 * appSidebarRight) so the test drives the same instances the UI runs on.
 */
import assert from 'node:assert/strict';
import {bootHarness} from '../fuzz/harness';

const EDITOR = '.phantomchat-group-edit-container';
const CHAT_TAB = 1; // APP_TABS.CHAT

/** The edit pane is open AND on screen. The right column is hidden with a
 * transform, which Playwright still counts as visible, so the body class plus
 * the pane living in #column-right are what decide it. */
async function editorVisible(page) {
  return page.evaluate((selector: string) => {
    if(!document.body.classList.contains('is-right-column-shown')) return false;
    return !!document.querySelector('#column-right ' + selector);
  }, EDITOR);
}

async function waitFor(condition, timeout = 20000) {
  const started = Date.now();
  while(Date.now() - started < timeout) {
    if(await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return false;
}

/** The dialog row the app builds: an `<a data-peer-id>` inside the chat list,
 * listened to by the real mousedown handler. The group is created over the API
 * in this harness so it has no row in the folder list yet; the handler under
 * test is the same one either way. Returns whether the rule consumed the click. */
async function clickRow(page, peerId: number) {
  await page.evaluate((id: number) => {
    document.querySelectorAll('[data-e2e-row]').forEach((el) => el.remove());
    const list = document.querySelector('.chatlist') as HTMLElement;
    const row = document.createElement('a');
    row.className = 'row chatlist-chat';
    row.setAttribute('data-peer-id', String(id));
    row.setAttribute('data-e2e-row', '1');
    row.textContent = 'Row click';
    row.style.height = '60px';
    list.prepend(row);
  }, peerId);
  const row = page.locator('a[data-e2e-row="1"]').first();
  await row.waitFor({state: 'visible', timeout: 30000});
  return row.evaluate((el: HTMLElement) => {
    const event = new MouseEvent('mousedown', {button: 0, bubbles: true, cancelable: true});
    el.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

const state = (page) => page.evaluate(() => ({
  tabId: window.appImManager.tabId,
  peer: +window.appImManager.chat?.peerId,
  narrow: window.mediaSizes.isLessThanFloatingLeftSidebar,
  width: window.innerWidth
}));

async function main() {
  const {ctx, teardown} = await bootHarness({consoleBufferMax: 800});
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  try {
    await A.page.waitForFunction(() => window.__phantomchatGroupAPI && window.rootScope?.managers);
    const groupId = await A.page.evaluate(async(other: string) =>
      window.__phantomchatGroupAPI.createGroup('Row click', [other]), B.pubkeyHex);
    await A.page.waitForTimeout(2500);
    const peer = await A.page.evaluate(async(id: string) => {
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      return (await getGroupStore().get(id)).peerId;
    }, groupId);

    /** The group has to be the OPEN chat before the click rule applies at all. */
    const openGroupChat = async() => {
      for(let attempt = 0; attempt < 20; attempt++) {
        await A.page.evaluate(async(peerId: number) => {
          await window.appImManager.setPeer({peerId});
        }, peer);
        if(await waitFor(async() => (await state(A.page)).peer === peer, 3000)) return;
      }

      throw new Error('group chat never opened');
    };

    // ---- wide: list + chat side by side, selected row opens the editor ----
    await A.page.setViewportSize({width: 1280, height: 800});
    await A.page.waitForTimeout(800);
    assert.equal((await state(A.page)).narrow, false, 'wide viewport is not the narrow layout');
    await openGroupChat();
    await clickRow(A.page, peer);
    assert.equal(await waitFor(() => editorVisible(A.page)), true,
      'wide: selected row opens the edit sidebar');
    console.log('PASS: wide layout, selected group row opens the editor');

    // ---- narrow: the chat replaces the list, selected row returns to it ----
    await A.page.evaluate(() => window.appSidebarRight.toggleSidebar(false));
    await A.page.setViewportSize({width: 390, height: 844});
    await A.page.waitForTimeout(1000);
    assert.equal((await state(A.page)).narrow, true, 'phone viewport is the narrow layout');
    await A.page.evaluate(() => window.appImManager.selectTab(0)); // APP_TABS.CHATLIST
    await A.page.waitForTimeout(1000);
    const consumed = await clickRow(A.page, peer);
    assert.equal(consumed, false, 'narrow: the click is left to the open-chat path');
    assert.equal(await waitFor(async() => (await state(A.page)).tabId === CHAT_TAB), true,
      'narrow: the chat pane is shown');
    assert.equal(await editorVisible(A.page), false, 'narrow: no edit sidebar');
    assert.equal((await state(A.page)).peer, peer, 'narrow: same chat as before the click');
    console.log('PASS: narrow layout, selected group row opens the chat');

    // ---- wide again: the rule comes back with the wider layout ----
    await A.page.setViewportSize({width: 1280, height: 800});
    await A.page.waitForTimeout(1000);
    assert.equal((await state(A.page)).narrow, false, 'back to the wide layout');
    await clickRow(A.page, peer);
    assert.equal(await waitFor(() => editorVisible(A.page)), true,
      'wide after resize: editor still opens');
    console.log('PASS: wide layout again, selected group row opens the editor');
  } finally {
    await teardown();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
