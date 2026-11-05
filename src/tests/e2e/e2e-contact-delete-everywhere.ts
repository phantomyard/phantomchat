// @ts-nocheck
/**
 * Deleting a contact removes it at once, here and on my other devices.
 *
 * The reported bug: right-click > Delete contact (and Delete contact in the
 * Edit pane) wiped the conversation and the mapping, but the Contacts list
 * kept showing the contact. The Worker's cached contact list was never told,
 * and the delete was never published to contacts-sync, so a second device
 * only dropped it on its next 30-minute reconcile.
 *
 * Device A1 and A2 share one identity; B is the contact. A1 deletes B through
 * the real context menu and confirm dialog. B must leave A1's list at once,
 * stay gone when Contacts reopens and after a reload, and leave A2's list
 * within seconds, without a reload.
 *
 * Run against Vite with FUZZ_APP_URL; disposable identities and an isolated relay.
 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {useIsolatedNetwork} from './helpers/isolated-network';
import {LocalRelay} from './helpers/local-relay';
import {launchOptions} from './helpers/launch-options';
import {dismissOverlays} from './helpers/dismiss-overlays';
import {createUser, linkContacts, sendTextViaUI} from '../fuzz/harness';

useIsolatedNetwork();

const APP_URL = process.env.FUZZ_APP_URL || 'http://localhost:8080';

async function openContacts(page) {
  // The app's own sidebar instance: importing the module here can hand back a
  // fresh copy (Vite HMR timestamps) with no managers.
  await page.evaluate(() => window.appSidebarLeft.openNewPrivateChatFlow());
  await page.locator('#contacts-container').first().waitFor({state: 'attached', timeout: 15000});
  await page.waitForTimeout(1500);
}

async function closeContacts(page) {
  await page.evaluate(() => window.appSidebarLeft.closeEverythingInside());
  await page.waitForTimeout(800);
}

const listed = (page, peerId) => page.evaluate((peerId) => {
  return !!document.querySelector(`#contacts [data-peer-id="${peerId}"]`);
}, String(peerId));

const mapped = (page, pubkey) => page.evaluate(async(pubkey) => {
  const {getMapping} = await import('/src/lib/phantomchat/virtual-peers-db.ts');
  return !!(await getMapping(pubkey));
}, pubkey);

const isContact = (page, peerId) => page.evaluate(async(peerId) => {
  const rs = (await import('/src/lib/rootScope.ts')).default;
  return rs.managers.appUsersManager.isContact(peerId);
}, peerId);

async function waitFor(check, timeoutMs, label) {
  const start = Date.now();
  while(Date.now() - start < timeoutMs) {
    if(await check()) return Date.now() - start;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out after ${timeoutMs}ms: ${label}`);
}

/** A second device of an existing identity, imported by secret key. */
async function importDevice(browser, relay, secretHex) {
  const context = await browser.newContext();
  await relay.injectInto(context);
  const page = await context.newPage();
  const consoleLog = [];
  page.on('console', (m) => { consoleLog.push(`[${m.type()}] ${m.text()}`); if(consoleLog.length > 3000) consoleLog.shift(); });
  page.on('pageerror', (e) => consoleLog.push(`[pageerror] ${e.message}`));
  await page.goto(APP_URL, {waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(15000);
  await dismissOverlays(page);
  const gotIt = page.getByRole('button', {name: 'Got it'});
  if(await gotIt.isVisible().catch(() => false)) await gotIt.click({force: true});
  await page.getByRole('button', {name: 'Import Seed Phrase'}).click({force: true});
  await page.locator('.phantomchat-seed-input').first().fill(secretHex);
  await page.waitForTimeout(1500);
  const finish = page.getByRole('button', {name: 'Get Started'});
  if(await finish.isVisible().catch(() => false)) await finish.click({force: true});
  await page.waitForTimeout(8000);
  await dismissOverlays(page);
  return {context, page, consoleLog};
}

async function main() {
  const relay = new LocalRelay();
  await relay.start();
  const browser = await chromium.launch(launchOptions);
  try {
    const A = await createUser(browser, 'userA', 'Alice-Del', relay, {});
    const B = await createUser(browser, 'userB', 'Bob-Del', relay, {});
    await linkContacts(A, B);
    const peerId = A.remotePeerId;
    // A real contact has a chat; the Contacts list is built from chats.
    await sendTextViaUI(A, `hello-${Date.now()}`);
    await B.page.waitForTimeout(2000);
    await sendTextViaUI(B, `hi-back-${Date.now()}`);

    const secretHex = await A.page.evaluate(() => {
      const sk = window.__phantomchatChatAPI.relayPool.getPrivateKey();
      return Array.from(sk).map((b) => b.toString(16).padStart(2, '0')).join('');
    });
    // Let A's add reach the relay before the second device boots.
    await A.page.waitForTimeout(4000);
    const A2 = await importDevice(browser, relay, secretHex);
    await waitFor(() => mapped(A2.page, B.pubkeyHex), 45000, 'A2 learns contact B from contacts-sync');
    await waitFor(() => isContact(A2.page, peerId), 15000, 'A2 lists B as a contact');
    await openContacts(A2.page);
    await waitFor(() => listed(A2.page, peerId), 15000, 'B listed on A2').catch(async(err) => {
      console.log('DIAG A2 probe:', await A2.page.evaluate(async(pid) => {
        const rs = (await import('/src/lib/rootScope.ts')).default;
        const ids = await rs.managers.appUsersManager.getContactsPeerIds(undefined, undefined, 'online').catch((e) => 'ERR ' + e);
        const {getMessageStore} = await import('/src/lib/phantomchat/message-store.ts');
        const convs = await getMessageStore().getAllConversationIds();
        const isC = await rs.managers.appUsersManager.isContact(pid);
        return JSON.stringify({ids, convs, isC, own: window.__phantomchatOwnPubkey?.slice(0, 8), url: location.href, body: document.body.className.slice(0, 200)});
      }, peerId));
      await A2.page.screenshot({path: '/tmp/pc-del-a2.png'});
      console.log(A2.consoleLog.filter((l) => /error|pageerror|Error/.test(l)).slice(-30).join('\n'));
      console.log('DIAG A2 contacts html:', await A2.page.evaluate(() => [document.querySelector('#contacts-container .contacts-empty')?.textContent, document.querySelectorAll('#contacts-container [data-peer-id]').length, Array.from(document.querySelectorAll('#contacts-container [data-peer-id]')).map(e=>e.dataset.peerId+':'+e.textContent).join('|')]));
      throw err;
    });

    // A2's boot reconcile loop retries for ~30s while a domain is still
    // inconclusive (no groups yet); a delete inside that window reaches A2
    // through the loop, not the nudge. Wait it out so A2 is a long-running
    // device that only the nudge can wake.
    await waitFor(() => {
      const outcomes = A2.consoleLog.filter((l) => l.includes('reconcile outcome'));
      const last = outcomes[outcomes.length - 1] || '';
      return outcomes.length >= 5 || (!!last && !/no-remote-nothing-local|failed/.test(last));
    }, 120000, 'A2 boot reconcile loop settles');
    await A2.page.waitForTimeout(3000);

    // Delete on A1 through the context menu + confirm dialog.
    await openContacts(A.page);
    assert.ok(await listed(A.page, peerId), 'B listed on A1 before delete');
    await A.page.locator(`#contacts [data-peer-id="${peerId}"]`).first().click({button: 'right'});
    await A.page.locator('.btn-menu-item').filter({hasText: 'Delete contact'}).first().click();
    await A.page.locator('.popup button').filter({hasText: /^Delete$/}).first().click();

    if(process.env.E2E_DIAG) {
      await A.page.waitForTimeout(3000);
      console.log('DIAG mapped=', await mapped(A.page, B.pubkeyHex), 'listed=', await listed(A.page, peerId));
      console.log('DIAG toasts=', await A.page.evaluate(() => Array.from(document.querySelectorAll('.toast')).map((t) => t.textContent)));
      console.log(A.consoleLog.filter((l) => /delete|Delete/.test(l)).slice(-25).join('\n'));
    }
    const tookA1 = await waitFor(async() => !(await listed(A.page, peerId)), 5000, 'B leaves A1 list');
    console.log(`A1 list dropped B after ${tookA1}ms`);

    await closeContacts(A.page);
    await openContacts(A.page);
    assert.equal(await listed(A.page, peerId), false, 'B must stay gone when Contacts reopens on A1');

    const tookA2 = await waitFor(async() => !(await mapped(A2.page, B.pubkeyHex)) && !(await isContact(A2.page, peerId)) && !(await listed(A2.page, peerId)), 20000, 'B leaves A2 (no reload)');
    console.log(`A2 dropped B after ${tookA2}ms`);
    await closeContacts(A2.page);
    await openContacts(A2.page);
    assert.equal(await listed(A2.page, peerId), false, 'B must stay gone when Contacts reopens on A2');

    await A.page.reload({waitUntil: 'load', timeout: 60000});
    await A.page.waitForTimeout(15000);
    await dismissOverlays(A.page);
    await openContacts(A.page);
    assert.equal(await listed(A.page, peerId), false, 'B must stay gone after A1 reloads');
    assert.equal(await mapped(A.page, B.pubkeyHex), false, 'B mapping must stay gone after A1 reloads');

    console.log('PASS e2e-contact-delete-everywhere');
  } finally {
    await browser.close();
    await relay.stop();
  }
}

main().catch((err) => {
  console.error('FAIL e2e-contact-delete-everywhere:', err);
  process.exit(1);
});
