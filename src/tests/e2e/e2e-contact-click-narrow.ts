// @ts-nocheck
/**
 * A tap on a contact in the Contacts list must reach the conversation on every
 * layout (#442 narrow rule). The Contacts list is also the new-DM flow, so a
 * contact with no chat yet must be openable from here.
 *
 *   - wide:  the chat opens in the middle, the Edit pane to its right
 *   - phone: the chat opens, the Edit pane covers it with a back arrow, and
 *            the back arrow lands in that chat (not the chat list)
 *
 *   npx vite --port 8133 &
 *   FUZZ_APP_URL=http://localhost:8133 pnpm exec tsx src/tests/e2e/e2e-contact-click-narrow.ts
 */
import assert from 'node:assert/strict';
import {bootHarness} from '../fuzz/harness';

const CHAT_TAB = 1; // APP_TABS.CHAT

const state = (page) => page.evaluate(() => ({
  tabId: window.appImManager.tabId,
  peer: +window.appImManager.chat?.peerId,
  editor: document.body.classList.contains('is-right-column-shown') &&
    !!document.querySelector('#column-right .edit-contact-container'),
  narrow: window.mediaSizes.isMobile
}));

async function waitFor(condition, timeout = 20000) {
  const started = Date.now();
  while(Date.now() - started < timeout) {
    if(await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Another chat is the open one (the harness warmup group), so only the tap
 * itself can bring up the contact's chat. */
async function openOtherChat(page, contactPeerId: number) {
  const other = await page.evaluate(async() => {
    const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
    const groups = await getGroupStore().getAll();
    return groups.length ? groups[0].peerId : 0;
  });
  assert.ok(other && other !== contactPeerId, 'a second chat exists to start from');
  await page.evaluate((peerId: number) => window.appImManager.setPeer({peerId}), other);
  assert.equal(await waitFor(async() => (await state(page)).peer === other), true, 'other chat open before the tap');
  await page.waitForTimeout(800);
}

async function tapContact(page, peerId: number) {
  await page.evaluate(() => window.appSidebarLeft.openNewPrivateChatFlow());
  const row = page.locator(`#contacts [data-peer-id="${peerId}"]`).first();
  await row.waitFor({state: 'visible', timeout: 30000});
  await row.click();
}

async function main() {
  const {ctx, teardown} = await bootHarness({consoleBufferMax: 800});
  const A = ctx.users.userA;
  const peerId = A.remotePeerId;
  try {
    // ---- phone: tap reaches the chat, Edit pane over it, back lands in the chat ----
    await A.page.setViewportSize({width: 390, height: 844});
    await A.page.waitForTimeout(1000);
    assert.equal((await state(A.page)).narrow, true, 'phone viewport is the mobile layout');
    // Another chat is open: only the tap itself may open the contact's chat.
    await openOtherChat(A.page, peerId);
    await A.page.evaluate(() => window.appImManager.selectTab(0)); // CHATLIST
    await A.page.waitForTimeout(800);
    await tapContact(A.page, peerId);
    assert.equal(await waitFor(async() => (await state(A.page)).editor), true, 'phone: Edit pane opens');
    assert.equal((await state(A.page)).peer, peerId, 'phone: the contact\'s chat is open behind the pane');
    await A.page.locator('#column-right .edit-contact-container .sidebar-close-button').first().click();
    assert.equal(await waitFor(async() => {
      const s = await state(A.page);
      return !s.editor && s.tabId === CHAT_TAB;
    }), true, 'phone: back arrow lands in the chat');
    assert.equal((await state(A.page)).peer, peerId, 'phone: it is the contact\'s chat');
    console.log('PASS: phone, contact tap reaches the chat');

    // ---- wide: chat in the middle, Edit pane to its right ----
    await A.page.setViewportSize({width: 1280, height: 800});
    await A.page.waitForTimeout(1000);
    assert.equal((await state(A.page)).narrow, false, 'wide viewport is not the mobile layout');
    await A.page.evaluate(() => window.appSidebarLeft.closeEverythingInside());
    await openOtherChat(A.page, peerId);
    await tapContact(A.page, peerId);
    assert.equal(await waitFor(async() => (await state(A.page)).editor), true, 'wide: Edit pane opens');
    assert.equal((await state(A.page)).peer, peerId, 'wide: the contact\'s chat is open');
    console.log('PASS: wide, contact tap opens chat + Edit pane');
  } finally {
    await teardown();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
