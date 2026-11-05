// @ts-nocheck
/** FUZZ_APP_URL=http://localhost:8147 pnpm exec tsx src/tests/e2e/e2e-forward-messages.ts
 * Real Worker/MessagePort/IDB + encrypted local relay. Blossom uploads are mocked
 * by the harness; downloads return those actual ciphertext bytes. */
import assert from 'node:assert/strict';
import {bootHarness, sendTextViaUI} from '../fuzz/harness';

async function rows(page, peerId, text) {
  return page.evaluate(async({peerId, text}) => {
    const {getMessageStore} = await import('/src/lib/phantomchat/message-store.ts');
    const store = getMessageStore();
    const all = (await Promise.all((await store.getAllConversationIds()).map((id) => store.getMessages(id, 100)))).flat();
    return all.filter((r) => r.twebPeerId === peerId && r.content === text);
  }, {peerId, text});
}

async function waitRows(page, peerId, text, count = 1) {
  const end = Date.now() + 20000;
  while(Date.now() < end) {
    const found = await rows(page, peerId, text);
    if(found.length === count) return found;
    await page.waitForTimeout(200);
  }
  throw new Error(`Expected ${count} rows at ${peerId}: ${text}`);
}

async function forward(page, fromPeerId, mid, peerId, dropCaptions = false) {
  return page.evaluate(async(args) => {
    const {default: rootScope} = await import('/src/lib/rootScope.ts');
    await rootScope.managers.appMessagesManager.forwardMessages({...args, mids: [args.mid]});
  }, {fromPeerId, mid, peerId, dropCaptions});
}

async function main() {
  const {ctx, teardown} = await bootHarness({consoleBufferMax: 1500});
  const A = ctx.users.userA;
  const B = ctx.users.userB;
  try {
    for(const user of [A, B]) {
      await user.context.route('https://blossom.fuzz/**', async(route) => {
        const sha = new URL(route.request().url()).pathname.slice(1).split('.')[0];
        for(const owner of [A, B]) {
          const data = await owner.page.evaluate((sha) => {
            const b = window.__fuzzBlossomUploads.get(sha);
            return b ? Array.from(b) : null;
          }, sha);
          if(data) return route.fulfill({status: 200, body: Buffer.from(data), contentType: 'application/octet-stream'});
        }
        return route.fulfill({status: 404});
      });
    }
    const groupId = await A.page.evaluate(async(other) => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      return getGroupAPI().createGroup('Forward E2E', [other]);
    }, B.pubkeyHex);
    const groupPeer = await A.page.evaluate(async(groupId) => {
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      return (await getGroupStore().getAll()).find((g) => g.groupId === groupId).peerId;
    }, groupId);
    await B.page.waitForTimeout(2000);

    // Exercise the actual context menu, destination picker and composer Send.
    const text = 'FORWARD_CONTEXT_' + Date.now();
    await sendTextViaUI(A, text);
    const [source] = await waitRows(A.page, A.remotePeerId, text);
    await waitRows(B.page, B.remotePeerId, text);
    const bubble = A.page.locator(`.bubble[data-mid="${source.mid}"] .message`).first();
    await bubble.click({button: 'right'});
    await A.page.locator('#bubble-contextmenu .btn-menu-item').filter({hasText: 'Forward'}).first().click();
    await A.page.locator(`.popup [data-peer-id="${groupPeer}"]`).first().click();
    await A.page.waitForFunction((peerId) => +window.appImManager.chat.peerId === peerId && !!window.appImManager.chat.input.forwarding, groupPeer);
    const sendButton = await A.page.evaluateHandle(() => window.appImManager.chat.input.btnSend);
    await sendButton.asElement().click();
    const [groupText] = await waitRows(A.page, groupPeer, text);
    await waitRows(B.page, groupPeer, text);
    assert.notEqual(groupText.eventId, source.eventId);
    await forward(A.page, groupPeer, groupText.mid, A.remotePeerId);
    await waitRows(A.page, A.remotePeerId, text, 2);
    await waitRows(B.page, B.remotePeerId, text, 2);
    console.log('PASS: context-menu DM → group, group → DM text; one persisted row per send');

    const caption = 'FORWARD_FILE_' + Date.now();
    await A.page.evaluate(async({peerId, caption}) => {
      const {default: rootScope} = await import('/src/lib/rootScope.ts');
      await rootScope.managers.appMessagesManager.sendPhantomChatAttachment({
        peerId, file: new Blob(['forward attachment bytes'], {type: 'audio/ogg'}),
        caption, isVoiceMessage: true, duration: 2, waveform: new Uint8Array([1, 2, 3])
      });
    }, {peerId: A.remotePeerId, caption});
    const [file] = await waitRows(A.page, A.remotePeerId, caption);
    await forward(A.page, A.remotePeerId, file.mid, groupPeer);
    const [groupFile] = await waitRows(A.page, groupPeer, caption);
    const [receivedGroupFile] = await waitRows(B.page, groupPeer, caption);
    assert.notEqual(groupFile.fileMetadata.keyHex, file.fileMetadata.keyHex, 'fresh attachment encryption');
    assert.equal(receivedGroupFile.fileMetadata.mimeType, 'audio/ogg');
    assert.equal(receivedGroupFile.fileMetadata.duration, 2);
    assert.equal(receivedGroupFile.fileMetadata.waveform, 'AQID');
    await forward(A.page, groupPeer, groupFile.mid, A.remotePeerId);
    const receivedDM = await waitRows(B.page, B.remotePeerId, caption, 2);
    const forwarded = receivedDM.find((r) => r.eventId !== file.eventId);
    assert.ok(forwarded?.fileMetadata, 'forwarded attachment reaches DM');
    const bytes = await B.page.evaluate(async(fm) => {
      const {fetchAndDecryptPhantomChatFile} = await import('/src/lib/phantomchat/phantomchat-file-fetch.ts');
      return (await fetchAndDecryptPhantomChatFile(fm.url, fm.keyHex, fm.ivHex, {sha256: fm.sha256})).text();
    }, forwarded.fileMetadata);
    assert.equal(bytes, 'forward attachment bytes');
    console.log('PASS: DM ↔ group voice attachment, caption/waveform preserved, receiver decrypts fresh ciphertext');
  } catch(error) {
    console.error('menus:', await A.page.locator('.btn-menu').allTextContents());
    await A.page.screenshot({path: '/home/supervisor/kai-scratch/forward-e2e-failure.png'});
    console.error(A.consoleLog.slice(-70).join('\n'));
    console.error(B.consoleLog.slice(-35).join('\n'));
    throw error;
  } finally {
    await teardown();
  }
}

main().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
