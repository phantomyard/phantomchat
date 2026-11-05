// @ts-nocheck
/**
 * The edit pane TOGGLES from every entry point: a second click on the
 * already-open chat's row, or on its topbar, must CLOSE the pane instead of
 * re-opening/re-animating it.
 *
 *   - group / session row: open -> close -> open again
 *   - two groups in a row:  the stale-tab case that made click 2 re-animate
 *   - topbar:               same toggle, same pane
 *   - 1:1 contact:          row and topbar both reach the contact editor
 *   - narrow:               unchanged, the row click opens the chat (no pane)
 *
 *   npx vite --port 8080 &
 *   FUZZ_APP_URL=http://localhost:8080 pnpm exec tsx src/tests/e2e/e2e-edit-pane-toggle.ts
 */
import assert from 'node:assert/strict';
import {bootHarness} from '../fuzz/harness';

const GROUP_EDITOR = '.phantomchat-group-edit-container';
const CONTACT_EDITOR = '.edit-contact-container';
const CHAT_TAB = 1; // APP_TABS.CHAT

/** The pane is open AND on screen. The right column is hidden with a
 * transform, which Playwright still counts as visible, so the body class plus
 * the pane living in #column-right are what decide it. */
async function editorVisible(page, selector: string) {
  return page.evaluate((sel: string) => {
    if(!document.body.classList.contains('is-right-column-shown')) return false;
    return !!document.querySelector('#column-right ' + sel);
  }, selector);
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
 * listened to by the real mousedown handler. Returns whether the rule consumed
 * the click, so the narrow case can prove it fell through to openChat. */
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

/** The topbar's own click handler — the shared entry point, not the row rule.
 * Playwright's real click covers both `mousedown` and `click` spellings of
 * `attachClickEvent` (it picks one by touch support). */
async function clickTopbar(page) {
  await page.locator('.topbar .chat-info').first().click();
}

/** Editor tabs still parked in the slider history — the bug's fingerprint. */
const editorTabs = (page) => page.evaluate(() =>
  window.appSidebarRight.getHistory()
  .map((t: any) => t?.constructor?.name || String(t))
  .filter((name: string) => name.includes('Edit')));

const state = (page) => page.evaluate(() => ({
  tabId: window.appImManager.tabId,
  peer: +window.appImManager.chat?.peerId,
  narrow: window.mediaSizes.isLessThanFloatingLeftSidebar
}));

async function openChat(page, peerId: number) {
  for(let attempt = 0; attempt < 20; attempt++) {
    await page.evaluate(async(id: number) => {
      await window.appImManager.setPeer({peerId: id});
    }, peerId);
    if(await waitFor(async() => (await state(page)).peer === peerId, 3000)) return;
  }

  throw new Error('chat never opened: ' + peerId);
}

async function main() {
  const {ctx, teardown} = await bootHarness({consoleBufferMax: 800});
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  const contactPeer = A.remotePeerId;
  try {
    await A.page.waitForFunction(() => window.__phantomchatGroupAPI && window.rootScope?.managers);
    const peers = [];
    for(const name of ['Toggle A', 'Toggle B']) {
      const groupId = await A.page.evaluate(async([n, other]: [string, string]) =>
        window.__phantomchatGroupAPI.createGroup(n, [other]), [name, B.pubkeyHex]);
      peers.push(await A.page.evaluate(async(id: string) => {
        const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
        return (await getGroupStore().get(id)).peerId;
      }, groupId));
    }
    const [peerA, peerB] = peers;
    await A.page.waitForTimeout(2500);

    await A.page.setViewportSize({width: 1280, height: 800});
    await A.page.waitForTimeout(800);
    assert.equal((await state(A.page)).narrow, false, 'wide viewport is not the narrow layout');

    // ---- group row: open, close, open again ----
    await openChat(A.page, peerA);
    await clickRow(A.page, peerA);
    assert.equal(await waitFor(() => editorVisible(A.page, GROUP_EDITOR)), true, 'click 1 opens the group editor');
    assert.deepEqual(await editorTabs(A.page), ['AppPhantomChatGroupEditTab'], 'one editor tab after opening');

    await clickRow(A.page, peerA);
    assert.equal(await waitFor(async() => !(await editorVisible(A.page, GROUP_EDITOR))), true, 'click 2 CLOSES the group editor');
    assert.deepEqual(await editorTabs(A.page), [], 'closing pops the tab out of the sidebar history');
    console.log('PASS: group row toggles open -> closed');

    await clickRow(A.page, peerA);
    assert.equal(await waitFor(() => editorVisible(A.page, GROUP_EDITOR)), true, 'click 3 opens it again');
    assert.deepEqual(await editorTabs(A.page), ['AppPhantomChatGroupEditTab'], 'still exactly one editor tab');
    console.log('PASS: group row toggles closed -> open');

    // ---- the stale-tab regression: close A, then open and double-click B ----
    await clickRow(A.page, peerA); // closed
    assert.equal(await waitFor(async() => !(await editorVisible(A.page, GROUP_EDITOR))), true, 'group A editor closed');

    await openChat(A.page, peerB);
    await clickRow(A.page, peerB);
    assert.equal(await waitFor(() => editorVisible(A.page, GROUP_EDITOR)), true, 'group B editor opens on click 1');
    await clickRow(A.page, peerB);
    assert.equal(await waitFor(async() => !(await editorVisible(A.page, GROUP_EDITOR))), true,
      'click 2 on a second group CLOSES it (the pane used to re-animate open)');
    assert.deepEqual(await editorTabs(A.page), [], 'no stale editor tab survives the toggle');
    console.log('PASS: second group toggles closed too (no stale-tab re-open)');

    // ---- topbar: same toggle ----
    await openChat(A.page, peerB);
    await A.page.waitForTimeout(400);
    await clickTopbar(A.page);
    assert.equal(await waitFor(() => editorVisible(A.page, GROUP_EDITOR)), true, 'topbar click opens the group editor');
    await clickTopbar(A.page);
    assert.equal(await waitFor(async() => !(await editorVisible(A.page, GROUP_EDITOR))), true, 'topbar click 2 closes it');
    console.log('PASS: topbar toggles the group editor');

    // ---- 1:1 contact: row and topbar ----
    await openChat(A.page, contactPeer);
    await A.page.waitForTimeout(600);
    await clickRow(A.page, contactPeer);
    assert.equal(await waitFor(() => editorVisible(A.page, CONTACT_EDITOR)), true, 'row click opens the contact editor');
    await clickRow(A.page, contactPeer);
    assert.equal(await waitFor(async() => !(await editorVisible(A.page, CONTACT_EDITOR))), true, 'row click 2 closes it');
    await clickTopbar(A.page);
    assert.equal(await waitFor(() => editorVisible(A.page, CONTACT_EDITOR)), true, 'topbar click opens the contact editor');
    await clickTopbar(A.page);
    assert.equal(await waitFor(async() => !(await editorVisible(A.page, CONTACT_EDITOR))), true, 'topbar click 2 closes it');
    console.log('PASS: 1:1 contact row and topbar both toggle the contact editor');

    // ---- narrow: unchanged, the row click must still return to the chat ----
    await A.page.evaluate(() => window.appSidebarRight.toggleSidebar(false));
    await A.page.setViewportSize({width: 390, height: 844});
    await A.page.waitForTimeout(1000);
    assert.equal((await state(A.page)).narrow, true, 'phone viewport is the narrow layout');
    await A.page.evaluate(() => window.appImManager.selectTab(0)); // CHATLIST
    await A.page.waitForTimeout(1000);
    const consumed = await clickRow(A.page, contactPeer);
    assert.equal(consumed, false, 'narrow: the click is left to the open-chat path');
    assert.equal(await waitFor(async() => (await state(A.page)).tabId === CHAT_TAB), true, 'narrow: the chat pane is shown');
    assert.equal(await editorVisible(A.page, CONTACT_EDITOR), false, 'narrow: no edit pane');
    console.log('PASS: narrow layout unchanged');
  } finally {
    await teardown();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
