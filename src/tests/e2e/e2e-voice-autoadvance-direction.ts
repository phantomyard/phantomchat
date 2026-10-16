/**
 * E2E regression test for issue #231: voice auto-advance must play DOWN only.
 *
 * Alice sends 15 voice notes (real 1s Opus silence) to Bob in rapid succession
 * (same-second mids, like the original Megan's-chat report). Bob clicks play
 * on voice #2 — the clicked voice has 13 voices BELOW it, more than the
 * playback controller's loadCount (10), so a store that answered a
 * newer-direction fetch with the newest page instead of the window next to
 * the anchor would be visible at this scale (small fixtures can't tell
 * "next window" from "newest window"). Before the fix, after the below-voices finished, the playback
 * queue wrapped around to the TOP of the chat and looped the whole chat
 * forever: the newer-direction history fetch anchored on a non-existent mid
 * (`anchor.mid + 1`), the store's unknown-anchor fallback returned the whole
 * recent window, and SearchListLoader re-queued it (above-voices + dups).
 *
 * Asserts:
 *   - voices below the clicked one play, in order: exactly [1..14]
 *   - NO voice above the clicked one ever plays
 *   - playback STOPS (no wrap, no loop)
 *
 * Prereqs:
 *   - Dev server on APP_URL (default http://localhost:8090)
 *   - Docker (for LocalRelay strfry)
 *   - E2E_CHROME_PATH when the host Chrome is unsupported by Playwright
 */
// @ts-nocheck
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';
import {MockBlossom} from './helpers/mock-blossom';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = process.env.APP_URL || process.env.E2E_APP_URL || 'http://localhost:8090';

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
  await page.waitForTimeout(4000);
  return ok;
}

// In-page: synthesize a real 1s Opus voice blob (silence) via MediaRecorder.
async function makeVoiceBlob(page: Page): Promise<string> {
  return page.evaluate(async() => {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    osc.start();
    const rec = new MediaRecorder(dest.stream);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise<Blob>((resolve) => {
      rec.onstop = () => resolve(new Blob(chunks, {type: 'audio/ogg;codecs=opus'}));
    });
    rec.start();
    await new Promise((r) => setTimeout(r, 1100));
    rec.stop();
    osc.stop();
    ctx.close();
    const blob = await done;
    const buf = await blob.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    for(let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  });
}

async function sendVoice(page: Page, b64: string, duration: number) {
  return page.evaluate(async({b64, duration}) => {
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
        duration,
        waveform: new Uint8Array([1, 2, 3, 4, 5, 4, 3, 2, 1]),
        caption: ''
      });
      return {ok: true, peerId};
    } catch(err: any) {
      return {ok: false, reason: err?.message || String(err)};
    }
  }, {b64, duration});
}

async function main() {
  console.log('=== e2e-voice-autoadvance-direction (#231) ===');
  const relay = new LocalRelay();
  await relay.start();
  const blossom = new MockBlossom();
  await blossom.start();

  const launchOpts: any = {...launchOptions};
  if(process.env.E2E_CHROME_PATH) launchOpts.executablePath = process.env.E2E_CHROME_PATH;

  const browser = await chromium.launch(launchOpts);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await relay.injectInto(ctxA);
  await relay.injectInto(ctxB);
  await blossom.injectInto(ctxA);
  await blossom.injectInto(ctxB);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const npubA = await createIdentity(pageA, 'Alice');
  const npubB = await createIdentity(pageB, 'Bobby');
  console.log(`  A: ${npubA.slice(0, 20)}...  B: ${npubB.slice(0, 20)}...`);

  await addContact(pageB, npubA, 'Alice');
  await addContact(pageA, npubB, 'Bob');
  await openChatByName(pageA, 'Bob');
  await openChatByName(pageB, 'Alice');
  await pageA.waitForTimeout(3000);

  const b64 = await makeVoiceBlob(pageA);
  const VOICES = 15;
  for(let i = 0; i < VOICES; i++) {
    const r = await sendVoice(pageA, b64, 1);
    if(!r.ok) { console.log(`  send ${i} FAILED: ${r.reason}`); process.exit(2); }
    await pageA.waitForTimeout(600); // burst — mostly same-second mids
  }
  console.log(`  ${VOICES} voice notes sent`);

  await pageB.waitForTimeout(12000);
  const count = await pageB.locator('.bubble .audio.is-voice').count();
  console.log(`  Bob sees ${count} voice bubbles`);
  if(count < VOICES) { console.log(`FAIL: fewer than ${VOICES} voice bubbles on receiver`); process.exit(2); }

  // Map every play event to a voice-bubble DOM index via the controller's
  // mediaDetails (the <audio> lives outside the bubble host).
  await pageB.evaluate(() => {
    (window as any).__playLog = [];
    const bubbles = Array.from(document.querySelectorAll('.bubble .audio.is-voice')) as HTMLElement[];
    const midToIdx = new Map(bubbles.map((el, i) => [el.dataset.mid, i]));
    const ctl = (window as any).appMediaPlaybackController;
    if(!ctl) throw new Error('appMediaPlaybackController missing');
    window.addEventListener('play', (e: any) => {
      const media = e.target;
      const details = ctl?.mediaDetails?.get(media);
      const mid = details ? String(details.mid) : undefined;
      (window as any).__playLog.push({
        idx: mid !== undefined ? (midToIdx.get(mid) ?? -2) : -1,
        mid,
        t: Date.now()
      });
    }, true);
  });

  // Click play on the 2nd voice bubble (idx 1)
  await pageB.locator('.bubble .audio.is-voice').nth(1).locator('.audio-toggle').click();
  console.log('  clicked play on voice #2');

  // Wait for the chain to finish: poll the log until it stops growing
  let prev = -1;
  let stable = 0;
  for(let i = 0; i < 40; i++) {
    await pageB.waitForTimeout(2000);
    const n = await pageB.evaluate(() => (window as any).__playLog.length);
    console.log(`  [t+${(i + 1) * 2}s] play events: ${n}`);
    if(n === prev && n > 0) {
      if(++stable >= 3) break;
    } else {
      stable = 0;
    }
    prev = n;
  }

  const idxes = await pageB.evaluate(() => (window as any).__playLog.map((l: any) => l.idx));
  let pass = true;
  const expected = Array.from({length: VOICES - 1}, (_, i) => i + 1);
  if(JSON.stringify(idxes) !== JSON.stringify(expected)) {
    pass = false;
    console.log(`  ✗ expected exact sequence [1..${VOICES - 1}], got ${JSON.stringify(idxes)}`);
  } else {
    console.log(`  ✓ played exactly [1..${VOICES - 1}] in order (below only, then STOP)`);
  }
  const above = idxes.filter((i: number) => i < 1);
  if(above.length) {
    pass = false;
    console.log(`  ✗ played ABOVE the clicked bubble: ${JSON.stringify(above)}`);
  }

  await browser.close();
  await relay.stop();
  console.log(pass ? '=== PASS ===' : '=== FAIL ===');
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
