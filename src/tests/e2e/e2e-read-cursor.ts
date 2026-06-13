/**
 * E2E regression test for the per-conversation read cursor (commit 5ea149f4).
 *
 * Scenario:
 *   1. A and B are cross-added as contacts.
 *   2. B sends 3 messages to A while A's chat with B is NOT open.
 *   3. A calls VMT `messages.getDialogs` — must report `unread_count === 3`
 *      and `read_inbox_max_id === 0` (cursor never advanced).
 *   4. A calls VMT `messages.readHistory` with `max_id = top_message`.
 *   5. A re-calls `getDialogs` — must report `unread_count === 0` and
 *      `read_inbox_max_id === top_message` (cursor advanced).
 *
 * Runs against an in-process strfry (LocalRelay helper). Deterministic; ~90s.
 *
 * Run: `pnpm start` in another terminal, then
 *      `npx tsx src/tests/e2e/e2e-read-cursor.ts`
 */
// @ts-nocheck
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = process.env.E2E_APP_URL || 'http://localhost:8080';

async function createIdentity(page: Page, displayName: string): Promise<string> {
  await page.goto(APP_URL, {waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load', timeout: 60000});
  await page.waitForTimeout(15000);
  await dismissOverlays(page);

  await page.getByRole('button', {name: 'Create New Identity'}).waitFor({state: 'visible', timeout: 30000});
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
  const nameInput = page.getByRole('textbox');
  if(await nameInput.isVisible()) {
    await nameInput.fill(displayName);
    await page.getByRole('button', {name: 'Get Started'}).click();
  }
  await page.waitForTimeout(8000);
  return npub;
}

async function addPeerAsContact(page: Page, peerNpub: string, peerName: string): Promise<void> {
  await page.evaluate(async({pk, nm}) => {
    if(typeof (0 as any).toPeerId !== 'function') {
      // eslint-disable-next-line no-extend-native
      (Number.prototype as any).toPeerId = function(isChat?: boolean) {
        return isChat === undefined ? +this : (isChat ? -Math.abs(+this) : +this);
      };
      (Number.prototype as any).toChatId = function() { return Math.abs(+this); };
      (Number.prototype as any).isPeerId = function() { return true; };
    }
    const {addP2PContact} = await import('/src/lib/nostra/add-p2p-contact.ts');
    await addP2PContact({pubkey: pk, nickname: nm, source: 'e2e-read-cursor'});
  }, {pk: peerNpub, nm: peerName});
}

async function readFirstP2PPeerId(page: Page): Promise<number> {
  const deadline = Date.now() + 15000;
  while(Date.now() < deadline) {
    const pid = await page.evaluate(() => {
      const proxy = (window as any).apiManagerProxy;
      const peers = proxy?.mirrors?.peers || {};
      for(const k of Object.keys(peers)) {
        if(Number(k) >= 1e15) return Number(k);
      }
      return 0;
    });
    if(pid) return pid;
    await page.waitForTimeout(500);
  }
  return 0;
}

async function openChatAndSend(page: Page, peerId: number, text: string): Promise<void> {
  await page.evaluate(async({pid, t}) => {
    (window as any).appImManager?.setPeer?.({peerId: pid});
    await new Promise((r) => setTimeout(r, 500));
    const input = document.querySelector('.chat-input [contenteditable="true"]') as HTMLElement;
    input.focus();
    document.execCommand('insertText', false, t);
    (document.querySelector('.chat-input button.btn-send') as HTMLElement).click();
  }, {pid: peerId, t: text});
}

async function queryDialog(page: Page, peerId: number): Promise<{unread_count: number; read_inbox_max_id: number; top_message: number} | null> {
  return await page.evaluate(async(pid) => {
    const rs = (window as any).rootScope;
    const result = await rs.managers.apiManager.invokeApi('messages.getDialogs', {
      offset_date: 0,
      offset_id: 0,
      offset_peer: {_: 'inputPeerEmpty'},
      limit: 100,
      hash: 0
    });
    const dialogs = result?.dialogs || [];
    const match = dialogs.find((d: any) => d.peerId === pid) || null;
    return match ? {
      unread_count: match.unread_count,
      read_inbox_max_id: match.read_inbox_max_id,
      top_message: match.top_message
    } : null;
  }, peerId);
}

async function callReadHistory(page: Page, peerId: number, maxId: number): Promise<void> {
  await page.evaluate(async({pid, mid}) => {
    const rs = (window as any).rootScope;
    await rs.managers.apiManager.invokeApi('messages.readHistory', {
      peer: {_: 'inputPeerUser', user_id: pid},
      max_id: mid
    });
  }, {pid: peerId, mid: maxId});
}

async function countArrivedMessages(page: Page, contents: string[]): Promise<number> {
  return await page.evaluate(async(expected) => {
    const req = indexedDB.open('nostra-messages');
    const db: IDBDatabase = await new Promise((r, rj) => {
      req.onsuccess = () => r(req.result);
      req.onerror = () => rj(req.error);
    });
    const tx = db.transaction('messages', 'readonly');
    const all: any[] = await new Promise((r, rj) => {
      const ga = tx.objectStore('messages').getAll();
      ga.onsuccess = () => r(ga.result);
      ga.onerror = () => rj(ga.error);
    });
    db.close();
    const set = new Set(expected);
    return all.filter((m: any) => set.has(m.content) && !m.isOutgoing).length;
  }, contents);
}

async function main() {
  const relay = new LocalRelay();
  await relay.start();
  console.log('[e2e] local relay up at', relay.url);

  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await ctxA.addInitScript((url) => { (window as any).__nostraTestRelays = [{url, read: true, write: true}]; }, relay.url);
  await ctxB.addInitScript((url) => { (window as any).__nostraTestRelays = [{url, read: true, write: true}]; }, relay.url);

  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  console.log('[e2e] creating identities');
  const [npubA, npubB] = await Promise.all([
    createIdentity(pageA, 'Alice'),
    createIdentity(pageB, 'Bob')
  ]);
  console.log('[e2e] Alice:', npubA.slice(0, 20) + '…');
  console.log('[e2e]   Bob:', npubB.slice(0, 20) + '…');

  console.log('[e2e] cross-adding contacts');
  await Promise.all([
    addPeerAsContact(pageA, npubB, 'Bob'),
    addPeerAsContact(pageB, npubA, 'Alice')
  ]);
  await Promise.all([pageA.waitForTimeout(1500), pageB.waitForTimeout(1500)]);

  const peerIdBOnA = await readFirstP2PPeerId(pageA);
  const peerIdAOnB = await readFirstP2PPeerId(pageB);
  if(!peerIdBOnA || !peerIdAOnB) throw new Error('peer ids not in mirror after contact add');

  // Bob sends 3 messages while Alice's chat with Bob is NOT open
  const bobMessages = ['m1-read-cursor', 'm2-read-cursor', 'm3-read-cursor'];
  for(const text of bobMessages) {
    await openChatAndSend(pageB, peerIdAOnB, text);
    await pageB.waitForTimeout(1200);
  }

  // Wait for all 3 to land in A's store
  const arrivalDeadline = Date.now() + 20000;
  let arrived = 0;
  while(Date.now() < arrivalDeadline) {
    arrived = await countArrivedMessages(pageA, bobMessages);
    if(arrived >= 3) break;
    await pageA.waitForTimeout(500);
  }
  if(arrived < 3) throw new Error(`only ${arrived}/3 messages arrived at A within 20s`);
  console.log('[e2e] all 3 messages arrived at A');

  // Dialog should report unread_count=3, cursor=0
  const before = await queryDialog(pageA, peerIdBOnA);
  console.log('[e2e] A dialog BEFORE readHistory:', before);
  if(!before) throw new Error('A has no dialog for Bob');
  if(before.unread_count !== 3) {
    throw new Error(`Expected unread_count=3 before readHistory, got ${before.unread_count}`);
  }
  if(before.read_inbox_max_id !== 0) {
    throw new Error(`Expected read_inbox_max_id=0 before readHistory, got ${before.read_inbox_max_id}`);
  }
  if(!before.top_message || before.top_message <= 0) {
    throw new Error(`Expected top_message > 0, got ${before.top_message}`);
  }

  // Advance cursor to the newest message
  console.log('[e2e] calling readHistory with max_id =', before.top_message);
  await callReadHistory(pageA, peerIdBOnA, before.top_message);
  await pageA.waitForTimeout(500);

  // Dialog should now report unread_count=0, cursor=top_message
  const after = await queryDialog(pageA, peerIdBOnA);
  console.log('[e2e] A dialog AFTER readHistory:', after);
  if(!after) throw new Error('dialog vanished after readHistory');
  if(after.unread_count !== 0) {
    throw new Error(`Expected unread_count=0 after readHistory, got ${after.unread_count}`);
  }
  if(after.read_inbox_max_id !== before.top_message) {
    throw new Error(
      `Expected read_inbox_max_id=${before.top_message}, got ${after.read_inbox_max_id}`
    );
  }

  // Monotonicity guard: a second readHistory with lower max_id must NOT
  // rewind the cursor.
  console.log('[e2e] asserting monotonic cursor (lower max_id must be no-op)');
  await callReadHistory(pageA, peerIdBOnA, 1);
  await pageA.waitForTimeout(300);
  const afterLow = await queryDialog(pageA, peerIdBOnA);
  if(afterLow?.read_inbox_max_id !== before.top_message) {
    throw new Error(
      `Cursor walked backwards: expected ${before.top_message}, got ${afterLow?.read_inbox_max_id}`
    );
  }

  console.log('[e2e] PASS — read cursor test cleared');
  console.log('       before:', before);
  console.log('       after: ', after);

  await ctxA.close();
  await ctxB.close();
  await browser.close();
  await relay.stop();
}

main().catch(async(err) => {
  console.error('[e2e] FAIL:', err?.stack || err);
  process.exit(1);
});
