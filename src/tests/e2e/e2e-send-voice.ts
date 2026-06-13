/**
 * E2E test for P2P voice note send (encrypted Blossom upload + kind 15 rumor).
 *
 * Flow mirrors e2e-send-image but the payload is a stub Opus Blob with
 * documentAttributeAudio {voice, duration, waveform}. Asserts that the
 * receiver bubble contains the voice-rendering wrapper (AudioElement).
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

// Minimal valid OggS stream header (just "OggS" + version + flags + position).
// AudioElement doesn't decode the bytes during rendering — it only needs the
// doc shape + duration attribute — so a stub is enough to verify the bubble
// path. A real playback test would need a full Opus file.
const OGG_STUB_BASE64 = 'T2dnUwACAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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
  console.log('E2E P2P Voice Note Send');
  console.log('=======================\n');

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
  pageA.on('console', (msg) => {
    const t = msg.text();
    if(/\[ChatAPI\]|\[NostraSync\]|\[VirtualMTProto|nostra_file_upload|\[sendFile\]|blossom/i.test(t)) logs.push(`[A] ${t}`);
  });
  pageB.on('console', (msg) => {
    const t = msg.text();
    if(/\[ChatAPI\]|\[NostraSync\]|\[VirtualMTProto|nostra_file_upload|\[sendFile\]|blossom/i.test(t)) logs.push(`[B] ${t}`);
  });

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

    console.log('\n=== Alice sends voice note ===');
    const sendResult = await pageA.evaluate(async(b64) => {
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], {type: 'audio/ogg;codecs=opus'});
        const im = (window as any).appImManager;
        const peerId = im?.chat?.peerId;
        if(!peerId) return {ok: false, reason: 'no active peer'};
        const mgr = (window as any).MOUNT_CLASS_TO?.apiManagerProxy?.managers?.appMessagesManager ||
          (window as any).rootScope?.managers?.appMessagesManager;
        if(!mgr) return {ok: false, reason: 'no appMessagesManager'};
        await mgr.sendFile({
          peerId,
          file: blob,
          isVoiceMessage: true,
          duration: 2.5,
          waveform: new Uint8Array([1, 2, 3, 4, 5, 4, 3, 2, 1]),
          caption: ''
        });
        return {ok: true, peerId};
      } catch(err: any) {
        return {ok: false, reason: err?.message || String(err)};
      }
    }, OGG_STUB_BASE64);

    if(!sendResult.ok) {
      record('V1', 'Alice invokes sendFile(voice)', 'FAIL', sendResult.reason);
      throw new Error('send failed: ' + sendResult.reason);
    }
    record('V1', 'Alice invokes sendFile(voice)', 'PASS');

    // Wait for Blossom upload
    await pageA.waitForTimeout(4000);
    console.log(`  MockBlossom object count: ${blossom.size()}`);
    if(blossom.size() >= 1) {
      record('V2', 'Voice ciphertext uploaded to MockBlossom', 'PASS');
    } else {
      record('V2', 'Voice ciphertext uploaded to MockBlossom', 'FAIL', 'mock got 0 objects');
    }

    // Wait for receiver
    console.log('\n=== Bob receives voice note ===');
    await pageB.waitForTimeout(RELAY_PROPAGATION_MS);

    // Diagnostic: Bob's store should have a file row with duration
    const bStore = await pageB.evaluate(async() => {
      const req = indexedDB.open('nostra-messages');
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
                mime: r.fileMetadata?.mimeType,
                hasFm: !!r.fileMetadata,
                duration: r.fileMetadata?.duration,
                waveform: r.fileMetadata?.waveform?.slice?.(0, 20),
                keyHexLen: r.fileMetadata?.keyHex?.length
              }));
            resolve({count: rows.length, rows});
          };
          all.onerror = () => resolve({error: all.error?.message});
        };
        req.onerror = () => resolve({error: 'open failed'});
      });
    });
    console.log('  Bob nostra-messages store:', JSON.stringify(bStore));

    if(bStore.count === 1 && bStore.rows[0].hasFm && bStore.rows[0].duration === 2.5) {
      record('V3', 'Receiver store has voice row with duration', 'PASS');
    } else {
      record('V3', 'Receiver store has voice row with duration', 'FAIL', JSON.stringify(bStore));
    }

    // Poll for receiver bubble with audio element (AudioElement mounts as
    // <audio-element> custom element; under the hood there's no <audio> tag
    // until the user hits play, but the .audio class on the bubble wrapper
    // is the reliable marker).
    const bBubble = await (async() => {
      const deadline = Date.now() + 20000;
      while(Date.now() < deadline) {
        const found = await pageB.evaluate(() => {
          const bubbles = document.querySelectorAll('.bubble[data-mid]');
          for(const b of bubbles) {
            if(b.classList.contains('is-in')) {
              // tweb wraps voice notes in an <audio-element> custom element
              // or .audio class container; also accept an <audio> tag.
              const audioEl = b.querySelector('audio-element, .audio, audio');
              if(audioEl) {
                return {
                  has: true,
                  tag: audioEl.tagName.toLowerCase(),
                  mid: b.getAttribute('data-mid')
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

    if(bBubble) {
      record('V4', 'Receiver bubble renders voice note', 'PASS', `tag=${bBubble.tag}`);
    } else {
      const diag = await pageB.evaluate(() => {
        const bubbles = [...document.querySelectorAll('.bubble[data-mid]')].map(b => ({
          mid: b.getAttribute('data-mid'),
          out: b.classList.contains('is-out'),
          inCls: b.classList.contains('is-in'),
          html: b.innerHTML.slice(0, 200)
        }));
        return {bubbleCount: bubbles.length, bubbles};
      });
      record('V4', 'Receiver bubble renders voice note', 'FAIL', JSON.stringify(diag).slice(0, 500));
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
