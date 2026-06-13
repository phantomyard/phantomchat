/**
 * E2E test for P2P image send (encrypted Blossom upload + kind 15 rumor).
 *
 * Flow:
 *   1. Alice and Bob onboard, exchange pubkeys, open chat.
 *   2. Alice injects a 1×1 JPEG Blob via window.appImManager.chat.input.sendFile.
 *   3. Alice's sender bubble appears (optimistic, local blob: URL preview).
 *   4. A kind 15 rumor reaches Bob via LocalRelay; receiver bubble renders
 *      the DECRYPTED image (fetched from MockBlossom and AES-GCM decrypted).
 *
 * Prereqs:
 *   - Dev server on APP_URL (default http://localhost:8090)
 *   - Docker (for LocalRelay strfry)
 */

// @ts-nocheck
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';
import {MockBlossom} from './helpers/mock-blossom';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = process.env.APP_URL || process.env.E2E_APP_URL || 'http://localhost:8090';
const RELAY_PROPAGATION_MS = 5000;

// 1×1 red JPEG. Tiny valid JPEG that browsers can decode.
const TINY_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
  'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
  'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
  'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB' +
  'AAIRAxEAPwD3+iiigD//2Q==';

async function createIdentity(page: Page, displayName: string): Promise<string> {
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await dismissOverlays(page);
  await page.reload({waitUntil: 'load'});
  await page.waitForTimeout(15000);
  await dismissOverlays(page);
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
    const skip = page.getByText('SKIP');
    if(await skip.isVisible().catch(() => false)) {
      await skip.click();
    } else {
      await page.getByRole('button', {name: 'Get Started'}).click();
    }
  }
  await page.waitForTimeout(8000);
  return npub;
}

async function addContact(page: Page, npub: string, nickname: string) {
  await dismissOverlays(page);
  await page.locator('#new-menu').click({timeout: 10000});
  await page.waitForTimeout(500);
  await page.locator('text=New Private Chat').click();
  await page.waitForTimeout(1000);
  await page.locator('button.btn-corner.is-visible').click();
  await page.waitForTimeout(1000);
  await page.getByRole('textbox', {name: 'Nickname (optional)'}).fill(nickname);
  await page.getByRole('textbox', {name: 'npub1...'}).fill(npub);
  await page.getByRole('button', {name: 'Add'}).click();
  await page.waitForTimeout(5000);
  const backBtn = page.locator('.sidebar-close-button, button.btn-icon.tgico-back, button.btn-icon.tgico-arrow_back').first();
  if(await backBtn.isVisible()) {
    await backBtn.click();
    await page.waitForTimeout(2000);
  }
}

async function openChatByName(page: Page, name: string): Promise<boolean> {
  const peerId = await page.evaluate((n) => {
    const chats = document.querySelectorAll('.chatlist-chat');
    for(const c of chats) {
      if(c.textContent?.includes(n)) return c.getAttribute('data-peer-id');
    }
    return chats[0]?.getAttribute('data-peer-id') || null;
  }, name);
  if(!peerId) return false;
  const ok = await page.evaluate((pid) => {
    const im = (window as any).appImManager;
    if(!im?.setPeer) return false;
    im.setPeer({peerId: pid});
    return true;
  }, peerId);
  await page.waitForTimeout(5000);
  return ok;
}

interface TestResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  detail?: string;
}
const results: TestResult[] = [];
function record(id: string, name: string, status: 'PASS' | 'FAIL', detail?: string) {
  results.push({id, name, status, detail});
  console.log(`  [${status}] ${id}: ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log('E2E P2P Image Send');
  console.log('==================\n');

  const relay = new LocalRelay();
  await relay.start();
  const blossom = new MockBlossom();
  await blossom.start();
  console.log(`  LocalRelay: ${relay.url}`);
  console.log(`  MockBlossom: ${blossom.url}`);

  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await relay.injectInto(ctxA);
  await relay.injectInto(ctxB);
  await blossom.injectInto(ctxA);
  await blossom.injectInto(ctxB);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const logs: string[] = [];
  const logFilter = (tag: string) => (msg: any) => {
    const t = msg.text();
    if(/\[ChatAPI\]|\[PhantomChatSync\]|\[VirtualMTProto|phantomchat_file_upload|\[sendFile\]|blossom/i.test(t)) {
      logs.push(`${tag} ${t}`);
    }
  };
  pageA.on('console', logFilter('[A]'));
  pageB.on('console', logFilter('[B]'));

  try {
    console.log('=== Setup: identities ===');
    const npubA = await createIdentity(pageA, 'Alice');
    const npubB = await createIdentity(pageB, 'Bobby');
    console.log(`  A: ${npubA.slice(0, 24)}...`);
    console.log(`  B: ${npubB.slice(0, 24)}...`);

    console.log('\n=== Setup: contacts ===');
    await addContact(pageB, npubA, 'Alice');
    await addContact(pageA, npubB, 'Bob');

    console.log('\n=== Open chats on both sides ===');
    await openChatByName(pageA, 'Bob');
    await openChatByName(pageB, 'Alice');
    await pageA.waitForTimeout(4000);
    await pageB.waitForTimeout(4000);

    console.log('\n=== Alice sends image ===');
    const sendResult = await pageA.evaluate(async(b64) => {
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], {type: 'image/jpeg'});
        const im = (window as any).appImManager;
        const peerId = im?.chat?.peerId;
        if(!peerId) return {ok: false, reason: 'no active peer'};
        const mgr = (window as any).MOUNT_CLASS_TO?.apiManagerProxy?.managers?.appMessagesManager ||
          (window as any).rootScope?.managers?.appMessagesManager;
        if(!mgr) return {ok: false, reason: 'no appMessagesManager'};
        await mgr.sendFile({
          peerId,
          file: blob,
          isMedia: true,
          width: 1,
          height: 1,
          caption: 'IMG_CAPTION_E2E_7f3a'
        });
        return {ok: true, peerId};
      } catch(err: any) {
        return {ok: false, reason: err?.message || String(err)};
      }
    }, TINY_JPEG_BASE64);

    if(!sendResult.ok) {
      record('I1', 'Alice invokes sendFile(image)', 'FAIL', sendResult.reason);
      throw new Error('send failed: ' + sendResult.reason);
    }
    record('I1', 'Alice invokes sendFile(image)', 'PASS');

    // Wait for Alice's own bubble with an <img>
    await pageA.waitForTimeout(3000);
    const aBubble = await pageA.evaluate(() => {
      const bubbles = document.querySelectorAll('.bubble[data-mid]');
      for(const b of bubbles) {
        if(b.classList.contains('is-out')) {
          const img = b.querySelector('img');
          const audio = b.querySelector('audio');
          return {
            has: true,
            hasImg: !!img,
            imgSrc: img?.src?.slice(0, 50) || null,
            hasAudio: !!audio,
            mid: b.getAttribute('data-mid')
          };
        }
      }
      return {has: false};
    });
    console.log('  sender bubble:', JSON.stringify(aBubble));
    if(aBubble.has && aBubble.hasImg) {
      record('I2', 'Sender bubble renders image', 'PASS');
    } else {
      record('I2', 'Sender bubble renders image', 'FAIL', JSON.stringify(aBubble));
    }

    // Wait for Blossom upload to complete (short — local mock, no network)
    await pageA.waitForTimeout(3000);
    console.log(`  MockBlossom object count: ${blossom.size()}`);
    if(blossom.size() >= 1) {
      record('I3', 'Ciphertext uploaded to MockBlossom', 'PASS');
    } else {
      record('I3', 'Ciphertext uploaded to MockBlossom', 'FAIL', 'mock got 0 objects');
    }

    // Wait for receiver
    console.log('\n=== Bob receives image ===');
    await pageB.waitForTimeout(RELAY_PROPAGATION_MS);

    // Diagnostic: does the message-store on Bob have the file row?
    const bStore = await pageB.evaluate(async() => {
      const req = indexedDB.open('phantomchat-messages');
      return new Promise<any>((resolve) => {
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('messages', 'readonly');
          const store = tx.objectStore('messages');
          const all = store.getAll();
          all.onsuccess = () => {
            const rows = (all.result as any[])
              .filter(r => r.type === 'file')
              .map(r => ({
                eventId: r.eventId?.slice?.(0, 20),
                type: r.type,
                hasFm: !!r.fileMetadata,
                url: r.fileMetadata?.url?.slice?.(0, 40),
                keyHexLen: r.fileMetadata?.keyHex?.length
              }));
            resolve({count: rows.length, rows});
          };
          all.onerror = () => resolve({error: all.error?.message});
        };
        req.onerror = () => resolve({error: 'open failed'});
      });
    });
    console.log('  Bob phantomchat-messages store:', JSON.stringify(bStore));

    const bMirror = await pageB.evaluate(() => {
      const proxy = (window as any).apiManagerProxy || (window as any).MOUNT_CLASS_TO?.apiManagerProxy;
      const im = (window as any).appImManager;
      const storageKey = `${im?.chat?.peerId}_history`;
      const mirror = proxy?.mirrors?.messages?.[storageKey] || {};
      const entries = Object.entries(mirror).map(([k, v]: [string, any]) => ({
        mid: k,
        hasMedia: !!v.media,
        mediaType: v.media?._,
        docType: v.media?.document?.type,
        hasFm: !!(v.media?.document?.phantomchatFileMetadata || v.media?.photo?.phantomchatFileMetadata),
        message: (v.message || '').slice(0, 40)
      }));
      return {peerId: im?.chat?.peerId, storageKey, count: entries.length, entries};
    });
    console.log('  Bob mirror:', JSON.stringify(bMirror));

    // Poll for receiver bubble with an <img> (receiver rendering is async —
    // fetch ciphertext from MockBlossom → decrypt → blob: URL → img.src)
    const bBubble = await (async() => {
      const deadline = Date.now() + 20000;
      while(Date.now() < deadline) {
        const found = await pageB.evaluate(() => {
          const bubbles = document.querySelectorAll('.bubble[data-mid]');
          for(const b of bubbles) {
            if(b.classList.contains('is-in')) {
              const img = b.querySelector('img');
              if(img && img.src && img.src !== '') {
                return {
                  has: true,
                  imgSrc: img.src.slice(0, 60),
                  isBlobUrl: img.src.startsWith('blob:'),
                  mid: b.getAttribute('data-mid'),
                  caption: ((b.querySelector('.message') || b).textContent || '').trim()
                };
              }
            }
          }
          return null;
        });
        if(found) return found;
        await pageB.waitForTimeout(500);
      }
      return null;
    })();

    // #11: the caption typed with the image must reach the receiver bubble.
    if(bBubble && bBubble.caption && bBubble.caption.includes('IMG_CAPTION_E2E_7f3a')) {
      record('I5', 'Receiver bubble shows the image caption (#11)', 'PASS', bBubble.caption);
    } else {
      record('I5', 'Receiver bubble shows the image caption (#11)', 'FAIL', 'caption=' + JSON.stringify(bBubble?.caption));
    }

    if(bBubble && bBubble.isBlobUrl) {
      record('I4', 'Receiver bubble renders decrypted image (blob: URL)', 'PASS', bBubble.imgSrc);
    } else if(bBubble) {
      record('I4', 'Receiver bubble renders decrypted image (blob: URL)', 'FAIL',
        'img found but src is not blob: — ' + JSON.stringify(bBubble));
    } else {
      const diag = await pageB.evaluate(() => {
        const bubbles = [...document.querySelectorAll('.bubble[data-mid]')].map(b => ({
          mid: b.getAttribute('data-mid'),
          out: b.classList.contains('is-out'),
          inCls: b.classList.contains('is-in'),
          hasImg: !!b.querySelector('img'),
          hasDoc: !!b.querySelector('.document')
        }));
        return {bubbleCount: bubbles.length, bubbles};
      });
      record('I4', 'Receiver bubble renders decrypted image (blob: URL)', 'FAIL',
        JSON.stringify(diag).slice(0, 400));
    }
  } catch(err) {
    console.error('Test error:', err);
  } finally {
    console.log('\n=== Console logs ===');
    logs.slice(-40).forEach((l) => console.log('  ' + l));

    await relay.stop();
    await blossom.stop();
    await ctxA.close();
    await ctxB.close();
    await browser.close();
  }

  console.log('\n========== SUMMARY ==========');
  let passed = 0, failed = 0;
  for(const r of results) {
    if(r.status === 'PASS') passed++; else failed++;
  }
  for(const r of results) {
    console.log(`  [${r.status}] ${r.id}: ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  }
  console.log(`\nTotal: ${passed} passed, ${failed} failed out of ${results.length}`);
  if(failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
