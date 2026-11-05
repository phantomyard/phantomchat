// @ts-nocheck
/**
 * First message to a brand-new contact must paint ONE own bubble.
 *
 * Repro of the duplicate own bubble: with the peer's chat open (as a bot's is),
 * the sender's empty chat keeps re-running its history load, which pulled the
 * Worker's temp copy of the in-flight send back out and drew it next to the
 * bubble VMT had already painted. `message_sent` then renamed the temp bubble
 * onto the same mid, leaving two. Later sends were fine; leaving and re-entering
 * the chat showed one.
 *
 * Run against Vite with FUZZ_APP_URL; disposable identities and an isolated relay.
 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {useIsolatedNetwork} from './helpers/isolated-network';
import {LocalRelay} from './helpers/local-relay';
import {launchOptions} from './helpers/launch-options';
import {createUser, linkContacts, sendTextViaUI} from '../fuzz/harness';

useIsolatedNetwork();

const bubblesWith = (page, text) => page.evaluate((text) => {
  return Array.from(document.querySelectorAll('.bubbles .bubble'))
  .filter((b) => (b.textContent || '').includes(text))
  .map((b) => b.dataset.mid);
}, text);

async function main() {
  const relay = new LocalRelay();
  await relay.start();
  const browser = await chromium.launch(launchOptions);
  try {
    const A = await createUser(browser, 'userA', 'Alice-First', relay, {});
    const B = await createUser(browser, 'userB', 'Bob-First', relay, {});
    await linkContacts(A, B);

    // The peer has the chat open and replies straight away, like a bot.
    await B.page.evaluate((peerId) => window.appImManager.setPeer({peerId}), B.remotePeerId);
    await A.page.evaluate((peerId) => window.appImManager.setPeer({peerId}), A.remotePeerId);
    await A.page.waitForTimeout(1500);

    // A cold first send to a new peer waits on relay dials and ACKs; hold the
    // sender's publish for a moment so the race window is as wide as it is on a
    // real network instead of a few ms on the in-process relay.
    await A.page.evaluate(() => {
      const pool = window.__phantomchatChatAPI.relayPool;
      const publish = pool.publish.bind(pool);
      pool.publish = async(...args) => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return publish(...args);
      };
    });

    const first = `first-${Date.now()}`;
    await sendTextViaUI(A, first);
    for(const ms of [300, 1000]) {
      await A.page.waitForTimeout(ms);
      const mids = await bubblesWith(A.page, first);
      assert.equal(mids.length, 1, `first send in flight: expected 1 own bubble after +${ms}ms, got ${mids.length} (${mids.join(', ')})`);
    }

    await B.page.locator('.bubbles .bubble').filter({hasText: first}).first().waitFor({timeout: 15000});
    await sendTextViaUI(B, 'pong from peer');

    for(const ms of [300, 1500, 4000]) {
      await A.page.waitForTimeout(ms);
      const mids = await bubblesWith(A.page, first);
      assert.equal(mids.length, 1, `first send: expected 1 own bubble after +${ms}ms, got ${mids.length} (${mids.join(', ')})`);
    }

    const second = `second-${Date.now()}`;
    await sendTextViaUI(A, second);
    await A.page.waitForTimeout(3000);
    assert.equal((await bubblesWith(A.page, second)).length, 1, 'second send: expected 1 own bubble');
    console.log('PASS e2e-first-send-no-duplicate');
  } finally {
    await browser.close();
    await relay.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
