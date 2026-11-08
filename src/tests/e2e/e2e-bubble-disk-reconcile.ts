// @ts-nocheck
/**
 * An own bubble missing from the open chat is repainted from the local store.
 *
 * Field bug (desktop + PWA): send in a session, switch to another chat while
 * replies arrive, come back, and the own bubble is gone until Ctrl+R. The row
 * is always in IndexedDB; only the in-memory history the chat re-renders from
 * on switch-back is missing the mid, which #467's heal cannot see (it only
 * repairs mids that ARE listed). bubble-disk-reconcile.ts compares the open
 * chat with the store on every open and on window focus.
 *
 * Two shapes are forced, for a 1:1 chat and for a group (sessions are groups):
 *   1. switch-back render whose history omits the middle own message;
 *   2. a bubble dropped from the open chat, then the window regains focus.
 * Each must come back exactly once, in order, with the heal logged.
 *
 * Run against Vite with FUZZ_APP_URL; disposable identities and an isolated relay.
 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {useIsolatedNetwork} from './helpers/isolated-network';
import {LocalRelay} from './helpers/local-relay';
import {launchOptions} from './helpers/launch-options';
import {createUser, linkContacts} from '../fuzz/harness';

useIsolatedNetwork();

async function open(page, peerId) {
  const deadline = Date.now() + 15000;
  while(Date.now() < deadline) {
    const at = await page.evaluate((peerId) => {
      if(window.appImManager.chat?.peerId !== peerId) window.appImManager.setPeer({peerId});
      return window.appImManager.chat?.peerId === peerId && !window.appImManager.chat?.setPeerPromise;
    }, peerId);
    if(at) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`could not open chat ${peerId}`);
}

const bubbleMids = (page, text) => page.evaluate((text) => {
  return Array.from(document.querySelectorAll('.bubbles .bubble[data-mid]'))
  .filter((b) => (b.querySelector('.message')?.textContent || '').includes(text))
  .map((b) => Number(b.dataset.mid));
}, text);

const orderOf = (page, texts) => page.evaluate((texts) => {
  const bubbles = Array.from(document.querySelectorAll('.bubbles .bubble[data-mid]'));
  return texts.map((t) => bubbles.findIndex((b) => (b.querySelector('.message')?.textContent || '').includes(t)));
}, texts);

// The harness sendTextViaUI always re-opens the DM; this sends into the chat
// that is open now (same selectors).
async function sendHere(page, text) {
  const input = page.locator('.chat-input [contenteditable="true"]').first();
  await input.waitFor({state: 'visible', timeout: 10000});
  await input.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
  await page.locator('.chat-input button.btn-send').first().click();
}

async function waitFor(fn, what, ms = 15000) {
  const deadline = Date.now() + ms;
  let last;
  while(Date.now() < deadline) {
    last = await fn();
    if(last) return last;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what} (last=${JSON.stringify(last)})`);
}

async function exercise(A, label, target, other, heals) {
  await open(A.page, target);
  await A.page.waitForTimeout(1500);
  const tag = `${label}-${Date.now()}`;
  const texts = [`${tag}-one`, `${tag}-two`, `${tag}-three`];
  for(const t of texts) {
    await sendHere(A.page, t);
    await waitFor(async() => (await bubbleMids(A.page, t)).length === 1, `${t} painted`);
    // P2P bubbles order by message.date (whole seconds); keep the sends in
    // distinct seconds, as real ones are, so order is well defined.
    await A.page.waitForTimeout(1100);
  }
  const [mid2] = await bubbleMids(A.page, texts[1]);
  const [mid3] = await bubbleMids(A.page, texts[2]);
  // Let the sends settle (persisted, temp bubbles resolved) before switching.
  await A.page.waitForTimeout(2500);

  // 1. Switch away, then come back with the middle own message missing from
  //    the history the chat re-renders from.
  await open(A.page, other);
  await A.page.waitForTimeout(1500);
  // A string, not a function: tsx wraps named helpers in __name(), which the
  // page does not define.
  await A.page.evaluate(`(() => {
    const mid = ${mid2};
    const bubbles = window.appImManager.chat.bubbles;
    const original = bubbles.performHistoryResult;
    window.__restoreHistory = () => { bubbles.performHistoryResult = original; };
    bubbles.performHistoryResult = function(result, reverse) {
      const keep = (m) => (typeof(m) === 'number' ? m : m && m.mid) !== mid;
      return original.call(this, Object.assign({}, result, {
        messages: result.messages && result.messages.filter(keep),
        history: result.history && result.history.filter(keep)
      }), reverse);
    };
  })()`);
  const before = heals.length;
  await open(A.page, target);
  await waitFor(async() => (await bubbleMids(A.page, texts[1])).length >= 1, `${label}: stripped bubble repainted on switch-back`);
  await A.page.evaluate(() => window.__restoreHistory());
  await A.page.waitForTimeout(1000);
  for(const t of texts) assert.equal((await bubbleMids(A.page, t)).length, 1, `${label}: exactly one bubble for ${t} after switch-back`);
  const order = await orderOf(A.page, texts);
  assert.ok(order[0] < order[1] && order[1] < order[2], `${label}: bubbles out of order after heal ${order}`);
  assert.ok(heals.slice(before).some((h) => h.includes(String(mid2)) && h.includes('open')), `${label}: switch-back heal logged (${heals.slice(before)})`);

  // 2. A bubble dropped from the open chat comes back when the window regains focus.
  await A.page.evaluate((mid) => {
    const bubbles = window.appImManager.chat.bubbles;
    const peerId = bubbles.peerId;
    bubbles.getBubble(peerId, mid)?.remove();
    delete bubbles.bubbles[`${peerId}_${mid}`];
  }, mid3);
  assert.equal((await bubbleMids(A.page, texts[2])).length, 0, `${label}: test setup removed the bubble`);
  const beforeFocus = heals.length;
  await A.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await waitFor(async() => (await bubbleMids(A.page, texts[2])).length === 1, `${label}: dropped bubble repainted on focus`);
  assert.ok(heals.slice(beforeFocus).some((h) => h.includes(String(mid3)) && h.includes('focus')), `${label}: focus heal logged`);

  // 3. A clean chat stays clean: focus again, nothing healed, nothing doubled.
  const beforeClean = heals.length;
  await A.page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await A.page.waitForTimeout(1500);
  assert.equal(heals.length, beforeClean, `${label}: no heal on a complete chat`);
  for(const t of texts) assert.equal((await bubbleMids(A.page, t)).length, 1, `${label}: still one bubble for ${t}`);
}

async function main() {
  const relay = new LocalRelay();
  await relay.start();
  const browser = await chromium.launch(launchOptions);
  try {
    const A = await createUser(browser, 'userA', 'Alice-Reconcile', relay, {});
    const B = await createUser(browser, 'userB', 'Bob-Reconcile', relay, {});
    await linkContacts(A, B);

    const heals = [];
    A.page.on('console', (msg) => {
      const text = msg.text();
      if(msg.type() === 'error' && text.includes('bubble-reconcile')) heals.push(text);
    });

    const gid = await A.page.evaluate(async(other) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      return getGroupAPI().createGroup('Reconcile session', [other]);
    }, B.pubkeyHex);
    const groupPeerId = await waitFor(() => A.page.evaluate(async(g) => {
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      return (await getGroupStore().get(g))?.peerId;
    }, gid).catch(() => undefined), 'group peer');

    await exercise(A, 'dm', A.remotePeerId, groupPeerId, heals);
    await exercise(A, 'group', groupPeerId, A.remotePeerId, heals);
    console.log('PASS e2e-bubble-disk-reconcile');
  } finally {
    await browser.close();
    await relay.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
