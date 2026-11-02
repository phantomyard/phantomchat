// @ts-nocheck
/**
 * #397: a voice note sent in a group or session must survive a page refresh.
 *
 * With top_message cut to mid % 2^32 on restore, a chat reopened from the URL
 * hash asked for history older than that number and rendered only its newest
 * bubble. Earlier messages stayed hidden until the chat was reopened.
 *
 * Run against Vite with FUZZ_APP_URL; disposable identities and an isolated relay.
 */
import assert from 'node:assert/strict';
import {bootHarness} from '../fuzz/harness';
import {useIsolatedNetwork} from './helpers/isolated-network';
import {MockBlossom} from './helpers/mock-blossom';

useIsolatedNetwork();

const BUBBLES = '.bubbles-inner .bubble[data-mid]';

async function main() {
  const blossom = new MockBlossom();
  await blossom.start();
  const {ctx, teardown} = await bootHarness();
  const A = ctx.users.userA;
  const page = A.page;
  const waitForChat = () => page.waitForFunction(() => !!window.appImManager?.chat?.bubbles, undefined, {timeout: 45000});

  // Bubbles painted after a refresh, without reopening the chat or asking for history.
  const expectAllVisible = async(label, texts, voiceNotes) => {
    const bubbles = page.locator(BUBBLES);
    for(const text of texts) await bubbles.filter({hasText: text}).first().waitFor({state: 'visible', timeout: 10000});
    await page.locator(`${BUBBLES} audio-element`).nth(voiceNotes - 1).waitFor({state: 'visible', timeout: 10000});
    assert.equal(await page.locator(`${BUBBLES} audio-element`).count(), voiceNotes, label + ': voice notes');
    const newestInView = () => {
      const all = [...document.querySelectorAll('.bubbles-inner .bubble[data-mid]')];
      const newest = all[all.length - 1];
      const view = window.appImManager.chat.bubbles.scrollable.container.getBoundingClientRect();
      const rect = newest.getBoundingClientRect();
      return !!newest.querySelector('audio-element') && rect.bottom > view.top && rect.top < view.bottom;
    };
    await page.waitForFunction(newestInView, undefined, {timeout: 10000}).catch(() => {
      assert.fail(label + ': the newest voice note must be last and in view');
    });
    console.log('PASS', label);
  };

  try {
    await blossom.injectInto(page.context());
    await page.reload({waitUntil: 'domcontentloaded'});
    await page.waitForFunction(() => !!window.appImManager?.setPeer);

    for(const kind of ['group', 'session']) {
      const texts = [0, 1, 2].map((i) => `${kind}397-${i}`);
      const {groupId, peerId} = await page.evaluate(async({kind, member}) => {
        const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
        for(let i = 0; i < 60; i++) {
          try { getGroupAPI(); break; } catch{ await new Promise((resolve) => setTimeout(resolve, 500)); }
        }
        const groupId = await getGroupAPI().createGroup(`voice-${kind}`, [member], undefined, {kind});
        const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
        const {peerId} = await getGroupStore().get(groupId);
        return {groupId, peerId};
      }, {kind, member: ctx.users.userB.pubkeyHex});

      // Open it the way a person does: its own rail folder, then its row.
      await page.locator('.folders-sidebar__folder-item').filter({hasText: kind === 'session' ? 'Sessions' : 'Groups'}).first().click();
      await page.locator(`.chatlist-chat[data-peer-id="${peerId}"]`).first().click({timeout: 15000});
      await page.waitForTimeout(3000);
      await page.evaluate(async({groupId, texts}) => {
        const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
        for(const text of texts) await getGroupAPI().sendMessage(groupId, text);
      }, {groupId, texts});
      await page.locator(BUBBLES).filter({hasText: texts[2]}).first().waitFor({state: 'visible', timeout: 15000});
      await page.waitForTimeout(3000); // bubbles settled, as they are before anyone records a note
      await page.evaluate(async(peerId) => {
        window.rootScope.managers.appMessagesManager.sendFile({
          peerId,
          file: new Blob([new Uint8Array(4096).map((_, i) => i % 251)], {type: 'audio/ogg'}),
          isVoiceMessage: true,
          isMedia: true,
          duration: 3,
          waveform: new Uint8Array(63).fill(7),
          clearDraft: true
        });
      }, peerId);
      await expectAllVisible(`${kind}: after sending`, texts, 1);
      await page.waitForTimeout(2500); // let the upload finish and the dialog row persist

      for(const pass of ['first', 'second']) {
        await page.reload({waitUntil: 'domcontentloaded'});
        await waitForChat();
        assert.equal(await page.evaluate(() => window.appImManager.chat.peerId), peerId, kind + ': refresh restored this chat');
        await expectAllVisible(`${kind}: ${pass} refresh`, texts, 1);
      }
    }
  } catch(error) {
    console.error('USER A console', A.consoleLog.slice(-100).join('\n'));
    throw error;
  } finally {
    await teardown();
    await blossom.stop?.();
  }
}
main().then(() => process.exit(0)).catch((error) => {console.error(error); process.exit(1);});
