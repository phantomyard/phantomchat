// @ts-nocheck
/** FUZZ_APP_URL=http://localhost:8147 pnpm exec tsx src/tests/e2e/e2e-forward-picker-stalled-dialog.ts
 * Forward's picker opens only after its first chat-list walk resolves. A dialog
 * with no top message has index 0 and sorts last; used as the next page offset
 * it restarted the walk from the top forever, so right-click → Forward did
 * nothing. Feed the picker such a page and require it to open and forward. */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {bootHarness, sendTextViaUI} from '../fuzz/harness';

async function main() {
  const {ctx, teardown} = await bootHarness({consoleBufferMax: 1500});
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  try {
    const groupId = await A.page.evaluate(async(other) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      return getGroupAPI().createGroup('Forward stall E2E', [other]);
    }, B.pubkeyHex);
    const groupPeer = await A.page.evaluate(async(groupId) => {
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      return (await getGroupStore().getAll()).find((g) => g.groupId === groupId).peerId;
    }, groupId);

    const text = 'FWD_STALL_' + Date.now();
    await sendTextViaUI(A, text);
    const bubble = A.page.locator('.bubble[data-mid] .message').filter({hasText: text}).first();
    await bubble.waitFor({state: 'visible', timeout: 15000});

    // Every Chats page now ends with a dialog that has no top message (index 0)
    // and never reports the end — what a dateless dialog does to the real walk.
    const calls = await A.page.evaluate(async() => {
      const {default: apiManagerProxy} = await import('/src/lib/apiManagerProxy.ts');
      const original = apiManagerProxy.invoke.bind(apiManagerProxy);
      window.__stallCalls = 0;
      apiManagerProxy.invoke = (type, payload, ...rest) => {
        const result = original(type, payload, ...rest);
        const options = payload?.args?.[0];
        if(type !== 'manager' || payload.name !== 'dialogsStorage' || payload.method !== 'getDialogs' || options?.filterId) {
          return result;
        }
        window.__stallCalls++;
        return Promise.resolve(result).then((value) => {
          const ghost = {_: 'dialog', peerId: 999999999, top_message: 0, index_0: 0, folder_id: 0, pFlags: {}};
          return {...value, dialogs: [...value.dialogs, ghost], isEnd: false};
        });
      };
      return true;
    });
    assert.ok(calls, 'stall injection installed');

    await bubble.click({button: 'right'});
    await A.page.locator('#bubble-contextmenu .btn-menu-item').filter({hasText: 'Forward'}).first().click();
    await A.page.locator(`.popup [data-peer-id="${groupPeer}"]`).first().click({timeout: 10000});
    const walks = await A.page.evaluate(() => window.__stallCalls);
    assert.ok(walks < 10, `picker walk terminated (${walks} Chats pages)`);
    await A.page.waitForFunction((peerId) => +window.appImManager.chat.peerId === peerId && !!window.appImManager.chat.input.forwarding, groupPeer, {timeout: 10000});
    const sendButton = await A.page.evaluateHandle(() => window.appImManager.chat.input.btnSend);
    await sendButton.asElement().click();
    await A.page.locator('.bubble[data-mid] .message').filter({hasText: text}).first().waitFor({state: 'visible', timeout: 20000});
    console.log(`PASS: Forward picker opens past a dateless dialog (${walks} Chats pages) and the forward lands`);
  } catch(error) {
    console.error('stall calls:', await A.page.evaluate(() => window.__stallCalls).catch(() => '?'));
    await A.page.screenshot({path: path.join(os.tmpdir(), 'forward-stall-e2e-failure.png')}).catch(() => {});
    console.error(A.consoleLog.slice(-40).join('\n'));
    throw error;
  } finally {
    await teardown();
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
