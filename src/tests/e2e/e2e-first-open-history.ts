// @ts-nocheck
/**
 * #325: real Worker/IndexedDB history on the first open after a reload.
 * Run against Vite with FUZZ_APP_URL; disposable identities and an isolated relay.
 */
import assert from 'node:assert/strict';
import {bootHarness} from '../fuzz/harness';
import {useIsolatedNetwork} from './helpers/isolated-network';

useIsolatedNetwork();

async function main() {
  const {ctx, teardown} = await bootHarness();
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  const texts = Array.from({length: 6}, (_, i) => `history325-${i}`);
  try {
    await Promise.all([A, B].map((user) => user.page.waitForFunction(() => !!window.appImManager?.setPeer)));
    await B.page.evaluate((peerId) => window.appImManager.setPeer({peerId}), B.remotePeerId);
    const input = B.page.locator('.chat-input [contenteditable="true"]').first();
    await input.waitFor({state: 'visible'});
    for(const [i, text] of texts.entries()) {
      if(i === texts.length - 1) {
        const target = B.page.locator('.bubbles .bubble[data-mid]').filter({hasText: texts[0]}).first();
        await target.waitFor({state: 'visible'});
        const mid = Number(await target.getAttribute('data-mid'));
        await B.page.evaluate((mid) => window.appImManager.chat.input.initMessageReply({replyToMsgId: mid}), mid);
      }
      await input.fill(text);
      await B.page.locator('.chat-input button.btn-send').first().click();
      await B.page.waitForTimeout(500);
    }
    const persisted = async() => A.page.evaluate(async({own, other}) => {
      const {getMessageStore} = await import('/src/lib/phantomchat/message-store.ts');
      const store = getMessageStore();
      return store.getMessages(store.getConversationId(own, other), 50);
    }, {own: A.pubkeyHex, other: B.pubkeyHex});
    const deadline = Date.now() + 30000;
    let rows = [];
    while(Date.now() < deadline) {
      rows = await persisted();
      if(texts.every((text) => rows.some((r) => r.content === text))) break;
      await A.page.waitForTimeout(250);
    }
    assert.ok(texts.every((text) => rows.some((r) => r.content === text)), 'all six messages persisted before reload');
    const quoted = rows.find((r) => r.content === texts[0]);
    assert.equal(rows.find((r) => r.content === texts[5]).replyToMid, quoted.mid, 'persisted reply points at the first message');

    for(const mode of ['desktop auto-open', 'mobile row click', 'explicit setPeer']) {
      await A.page.setViewportSize(mode === 'desktop auto-open' ? {width: 1280, height: 900} : {width: 500, height: 900});
      await A.page.evaluate(() => history.replaceState(null, '', location.pathname + location.search));
      await A.page.reload({waitUntil: 'domcontentloaded'});
      await A.page.waitForFunction(() => !!window.appImManager?.setPeer);
      await A.page.waitForTimeout(5000);
      const row = A.page.locator(`.chatlist-chat[data-peer-id="${A.remotePeerId}"]`).first();
      await row.waitFor({state: 'visible', timeout: 30000});
      if(mode === 'mobile row click') await row.click();
      if(mode === 'explicit setPeer') await A.page.evaluate((peerId) => window.appImManager.setPeer({peerId}), A.remotePeerId);
      // The reporter sampled at 1.8 s. Poll within that budget; no reopen,
      // manual history fetch, or cache invalidation can make the test pass.
      const bubbles = A.page.locator('.bubbles .bubble[data-mid]');
      for(const text of texts) await bubbles.filter({hasText: text}).first().waitFor({state: 'visible', timeout: 1800});
      const reply = bubbles.filter({hasText: texts[5]}).first();
      const quote = await reply.locator('.reply').innerText();
      assert.ok(quote.includes(texts[0]), mode + ': correct quote on first open: ' + quote);
      assert.ok(!(await reply.innerText()).includes('Deleted message'), mode + ': quote must not be marked deleted');
      const state = await A.page.evaluate(() => {
        const s = window.appImManager.chat.getHistoryStorage();
        return {history: s.history.slices.flat(), maxId: s.maxId};
      });
      assert.ok(state.history.every((mid) => mid >= 1e15), mode + ': no truncated anchor in the cold history slice');
      console.log('PASS', mode, 'all messages and reply quote on first open');
    }
  } catch(error) {
    console.error('USER A console', A.consoleLog.slice(-100).join('\n'));
    throw error;
  } finally { await teardown(); }
}
main().then(() => process.exit(0)).catch((error) => {console.error(error); process.exit(1);});
