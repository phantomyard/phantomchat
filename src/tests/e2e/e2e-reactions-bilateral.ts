/**
 * E2E regression test for Bug #3 (FIND-4e18d35d).
 *
 * Reproduces the scenario where a kind-7 reaction fails to bilateral-propagate
 * because sender and receiver used to key their own-message rows by divergent
 * eventIds (sender: app-level chat-XXX-N, receiver: rumor hex). After the fix
 * both sides key by the 64-hex rumor id so the reactor's e-tag is NIP-01-valid
 * AND the target resolver on the other side finds the row.
 *
 * Scenario (named after the memory note that requested this coverage):
 *   1. A sends "hello" → B.
 *   2. B opens the chat and reacts with 😂 on A's message.
 *   3. Within 5 seconds A's reactions store MUST contain a row whose
 *      `targetEventId` matches A's saved row eventId (the rumor id).
 *
 * Runs against an in-process strfry (LocalRelay helper). Deterministic; ~80s.
 *
 * Run: `pnpm start` in another terminal, then
 *      `npx tsx src/tests/e2e/e2e-reactions-bilateral.ts`
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
    // Dev-mode guard: `Number.prototype.toPeerId` is installed by
    // `src/helpers/peerIdPolyfill.ts` at app boot. If Vite HMR replaced the
    // main chunk mid-test the prototype extension may have been lost — in
    // that case re-install a minimal shim so `addP2PContact` can resolve.
    if(typeof (0 as any).toPeerId !== 'function') {
      // eslint-disable-next-line no-extend-native
      (Number.prototype as any).toPeerId = function(isChat?: boolean) {
        return isChat === undefined ? +this : (isChat ? -Math.abs(+this) : +this);
      };
      (Number.prototype as any).toChatId = function() { return Math.abs(+this); };
      (Number.prototype as any).isPeerId = function() { return true; };
    }
    const {addP2PContact} = await import('/src/lib/nostra/add-p2p-contact.ts');
    await addP2PContact({pubkey: pk, nickname: nm, source: 'e2e-reactions-bilateral'});
  }, {pk: peerNpub, nm: peerName});
}

async function readFirstP2PPeerId(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const proxy = (window as any).apiManagerProxy;
    const peers = proxy?.mirrors?.peers || {};
    for(const pid of Object.keys(peers)) {
      if(Number(pid) >= 1e15) return Number(pid);
    }
    return 0;
  });
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
  console.log('[e2e] Alice:', npubA.slice(0, 20) + '...');
  console.log('[e2e]   Bob:', npubB.slice(0, 20) + '...');

  console.log('[e2e] cross-adding contacts');
  await Promise.all([
    addPeerAsContact(pageA, npubB, 'Bob'),
    addPeerAsContact(pageB, npubA, 'Alice')
  ]);
  await Promise.all([pageA.waitForTimeout(1500), pageB.waitForTimeout(1500)]);

  const peerIdBOnA = await readFirstP2PPeerId(pageA);
  const peerIdAOnB = await readFirstP2PPeerId(pageB);
  if(!peerIdBOnA || !peerIdAOnB) throw new Error('peer ids not in mirror after contact add');

  // 1. A sends "hello" to B.
  console.log('[e2e] A sends "hello"');
  await openChatAndSend(pageA, peerIdBOnA, 'hello');
  await pageA.waitForTimeout(4000);

  // Snapshot A's row id (should now be rumor hex after the fix, not chat-XXX-N).
  // Walk every message in the single "messages" object store so we don't have
  // to reconstruct the conversationId from the UI state — cross-cutting over
  // the IDB directly is resilient to mirror/worker race.
  const aRowInfo = await pageA.evaluate(async() => {
    const req = indexedDB.open('nostra-messages');
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const tx = db.transaction('messages', 'readonly');
    const store = tx.objectStore('messages');
    const all: any[] = await new Promise((resolve, reject) => {
      const getAll = store.getAll();
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    db.close();
    const own = all.find((m: any) => m.isOutgoing && m.content === 'hello');
    return own ? {eventId: own.eventId, appMessageId: own.appMessageId, mid: own.mid, total: all.length} : {eventId: null, total: all.length};
  });
  console.log('[e2e] A row:', aRowInfo);
  if(!aRowInfo.eventId) throw new Error(`A never stored the outgoing row (${aRowInfo.total} rows visible in nostra-messages)`);
  if(!/^[0-9a-f]{64}$/.test(aRowInfo.eventId)) {
    throw new Error(`A row.eventId is not 64-hex rumor id: ${aRowInfo.eventId}`);
  }
  if(!aRowInfo.appMessageId?.startsWith('chat-')) {
    throw new Error(`A row.appMessageId missing/invalid: ${aRowInfo.appMessageId}`);
  }

  // 2. B opens the chat and reacts 😂 on A's message. Poll up to 10s for the
  // incoming bubble because relay round-trip + bubble render is async.
  console.log('[e2e] B opens chat and reacts');
  await pageB.evaluate(async(pid) => {
    (window as any).appImManager?.setPeer?.({peerId: pid});
  }, peerIdAOnB);

  const bMidDeadline = Date.now() + 10000;
  let targetMidOnB = 0;
  while(Date.now() < bMidDeadline) {
    targetMidOnB = await pageB.evaluate(() => {
      const b = document.querySelector('.bubbles-inner .bubble[data-mid].is-in') as HTMLElement;
      return b ? Number(b.dataset.mid) : 0;
    });
    if(targetMidOnB) break;
    await pageB.waitForTimeout(250);
  }
  if(!targetMidOnB) throw new Error('B sees no incoming bubble to react to (waited 10s)');

  await pageB.evaluate(async(mid) => {
    const rs = (window as any).rootScope;
    const peerId = (window as any).appImManager?.chat?.peerId;
    await rs.managers.appReactionsManager.sendReaction({
      message: {peerId, mid},
      reaction: {_: 'reactionEmoji', emoticon: '😂'}
    });
  }, targetMidOnB);

  // 3. Within 5s, A's reactions store must contain the kind-7 row.
  const deadline = Date.now() + 5000;
  let aReactionRow: any = null;
  while(Date.now() < deadline) {
    aReactionRow = await pageA.evaluate(async() => {
      const store = (window as any).__nostraReactionsStore;
      if(!store) return null;
      const all = await store.getAll();
      return all.find((r: any) => r.emoji === '😂') || null;
    });
    if(aReactionRow) break;
    await pageA.waitForTimeout(250);
  }
  if(!aReactionRow) {
    throw new Error('A never received the kind-7 reaction within 5s (Bug #3 NOT fixed)');
  }
  if(aReactionRow.targetEventId !== aRowInfo.eventId) {
    throw new Error(
      `Reaction targetEventId ${aReactionRow.targetEventId} does not match A row.eventId ${aRowInfo.eventId}`
    );
  }

  console.log('[e2e] PASS — Bug #3 regression cleared');
  console.log('       reaction targetEventId:', aReactionRow.targetEventId);
  console.log('       A row.eventId         :', aRowInfo.eventId);

  await ctxA.close();
  await ctxB.close();
  await browser.close();
  await relay.stop();
}

main().catch(async(err) => {
  console.error('[e2e] FAIL:', err?.stack || err);
  process.exit(1);
});
