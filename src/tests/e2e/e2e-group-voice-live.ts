// @ts-nocheck
/**
 * A voice note sent by the OTHER side of an open group chat must paint live.
 *
 * Reported shape: I recorded a voice note, my bubble appeared right away, then
 * the peer's "recording voice" tick showed up, then nothing — the peer's voice
 * note only appeared after switching to another chat and back.
 *
 * Cause: the group receive path persisted the row and dispatched
 * `phantomchat_new_message` without the file metadata, so the shared projection
 * handler appended a SECOND, media-less tweb message for the same mid. When
 * bubbles rendered from that copy, wrapDocument threw on `message.media.document`
 * and the bubble was dropped until the chat was reopened from IndexedDB.
 *
 * The dispatch race makes this probabilistic at the browser level (it failed
 * roughly 3 of 4 runs before the fix); the deterministic coverage lives in
 * src/tests/phantomchat/group-incoming-media-projection.test.ts. This test is
 * the end-to-end proof that the whole pipeline renders, with the receiving
 * side's chat OPEN and settled.
 *
 * Run against Vite with FUZZ_APP_URL; disposable identities and an isolated relay.
 */
import assert from 'node:assert/strict';
import {bootHarness} from '../fuzz/harness';
import {useIsolatedNetwork} from './helpers/isolated-network';
import {MockBlossom} from './helpers/mock-blossom';

useIsolatedNetwork();

const BUBBLES = '.bubbles-inner .bubble[data-mid]';
const PEER_NOTES = 3;

async function main() {
  const blossom = new MockBlossom();
  await blossom.start();
  const {ctx, teardown} = await bootHarness();
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  const page = A.page;
  const peerPage = B.page;

  const sendVoice = (target, peerId) => target.evaluate(async(pid) => {
    await window.rootScope.managers.appMessagesManager.sendFile({
      peerId: pid,
      file: new Blob([new Uint8Array(4096).map((_, i) => i % 251)], {type: 'audio/ogg'}),
      isVoiceMessage: true,
      isMedia: true,
      duration: 3,
      waveform: new Uint8Array(63).fill(7),
      clearDraft: true
    });
  }, peerId);

  const audioCount = (target) => target.locator(`${BUBBLES} audio-element`).count();

  try {
    await blossom.injectInto(page.context());
    await blossom.injectInto(peerPage.context());
    await page.reload({waitUntil: 'domcontentloaded'});
    await peerPage.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !!window.appImManager?.setPeer);
    await peerPage.waitForFunction(() => !!window.appImManager?.setPeer);

    await page.waitForFunction(async() => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      try { getGroupAPI(); return true; } catch{ return false; }
    }, undefined, {timeout: 90000});

    const {groupId, peerId} = await page.evaluate(async(member) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      const gid = await getGroupAPI().createGroup('voice-live', [member]);
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      const rec = await getGroupStore().get(gid);
      return {groupId: gid, peerId: rec.peerId};
    }, B.pubkeyHex);
    console.log('group', groupId.slice(0, 8), 'peer', peerId);

    // B must hold the group record before it can send into it.
    const deadline = Date.now() + 15000;
    while(Date.now() < deadline) {
      const has = await peerPage.evaluate(async(gid) => {
        const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
        return !!(await getGroupStore().get(gid));
      }, groupId);
      if(has) break;
      await peerPage.waitForTimeout(250);
    }

    // A opens the group the way a person does: Groups folder, then the row.
    await page.locator('.folders-sidebar__folder-item').filter({hasText: 'Groups'}).first().click();
    await page.locator(`.chatlist-chat[data-peer-id="${peerId}"]`).first().click({timeout: 15000});
    await page.waitForFunction(() => !!window.appImManager?.chat?.bubbles, undefined, {timeout: 45000});
    await page.waitForTimeout(3000);

    // A sends its own note first — the state the report starts from.
    await sendVoice(page, peerId);
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length >= 1,
      `${BUBBLES} audio-element`,
      {timeout: 20000}
    );
    console.log('PASS own voice note painted');
    await page.waitForTimeout(2500);

    // Then the peer's notes, chat still open and settled.
    for(let i = 1; i <= PEER_NOTES; i++) {
      const before = await audioCount(page);
      await sendVoice(peerPage, peerId);
      await page.waitForFunction(
        ([sel, n]) => document.querySelectorAll(sel).length > n,
        [`${BUBBLES} audio-element`, before],
        {timeout: 15000}
      ).catch(async() => {
        const bubbles = await page.locator(BUBBLES).count();
        const mids = await page.evaluate(() => [...document.querySelectorAll('.bubbles-inner .bubble[data-mid]')].map((el) => el.dataset.mid));
        assert.fail(`peer voice note ${i} never painted live (bubbles=${bubbles}, audio=${await audioCount(page)}, mids=${mids.join(',')})`);
      });
      console.log(`PASS peer voice note ${i} painted live`);
      await page.waitForTimeout(1500);
    }

    assert.equal(await page.locator(BUBBLES).count(), 1 + PEER_NOTES, 'every note rendered as its own bubble');
  } catch(error) {
    console.error('USER A console', A.consoleLog.slice(-80).join('\n'));
    throw error;
  } finally {
    await teardown();
    await blossom.stop?.();
  }
}
main().then(() => process.exit(0)).catch((error) => {console.error(error); process.exit(1);});
