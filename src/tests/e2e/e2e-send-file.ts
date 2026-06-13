/**
 * E2E test for P2P generic file send (PDF stub → encrypted Blossom → receiver).
 *
 * Asserts the receiver bubble renders the document wrapper (.document class)
 * and the AppDownloadManager hook produces a decrypted Blob when clicked —
 * verified by programmatically invoking downloadMediaURL with the receiver's
 * doc object and checking the returned URL is a blob: URL.
 */

// @ts-nocheck
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';
import {MockBlossom} from './helpers/mock-blossom';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = process.env.APP_URL || process.env.E2E_APP_URL || 'http://localhost:8090';
const RELAY_PROPAGATION_MS = 5000;

// Minimal valid PDF header ("%PDF-1.4\n") + a couple of bytes.
const PDF_STUB_BASE64 = 'JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PmVuZG9iagp0cmFpbGVyCg==';

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
    if(await skip.isVisible().catch(() => false)) await skip.click();
    else await page.getByRole('button', {name: 'Get Started'}).click();
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
  await page.evaluate((pid) => {
    const im = (window as any).appImManager;
    im?.setPeer?.({peerId: pid});
  }, peerId);
  await page.waitForTimeout(5000);
  return true;
}

interface TestResult { id: string; name: string; status: 'PASS' | 'FAIL'; detail?: string; }
const results: TestResult[] = [];
function record(id: string, name: string, status: 'PASS' | 'FAIL', detail?: string) {
  results.push({id, name, status, detail});
  console.log(`  [${status}] ${id}: ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log('E2E P2P File Send\n=================\n');

  const relay = new LocalRelay();
  await relay.start();
  const blossom = new MockBlossom();
  await blossom.start();

  const browser = await chromium.launch(launchOptions);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await relay.injectInto(ctxA);
  await relay.injectInto(ctxB);
  await blossom.injectInto(ctxA);
  await blossom.injectInto(ctxB);
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  try {
    const npubA = await createIdentity(pageA, 'Alice');
    const npubB = await createIdentity(pageB, 'Bobby');
    await addContact(pageB, npubA, 'Alice');
    await addContact(pageA, npubB, 'Bob');
    await openChatByName(pageA, 'Bob');
    await openChatByName(pageB, 'Alice');
    await pageA.waitForTimeout(4000);
    await pageB.waitForTimeout(4000);

    console.log('=== Alice sends PDF ===');
    const sendResult = await pageA.evaluate(async(b64) => {
      try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], {type: 'application/pdf'});
        const im = (window as any).appImManager;
        const peerId = im?.chat?.peerId;
        if(!peerId) return {ok: false, reason: 'no active peer'};
        const mgr = (window as any).MOUNT_CLASS_TO?.apiManagerProxy?.managers?.appMessagesManager ||
          (window as any).rootScope?.managers?.appMessagesManager ||
          (window as any).appImManager?.chat?.appMessagesManager;
        if(!mgr) {
          const w: any = window;
          const keys = Object.keys(w.MOUNT_CLASS_TO || {});
          return {ok: false, reason: 'no mgr — MOUNT keys=' + keys.join(',')};
        }
        await mgr.sendFile({peerId, file: blob, caption: ''});
        return {ok: true};
      } catch(err: any) {
        return {ok: false, reason: err?.message || String(err)};
      }
    }, PDF_STUB_BASE64);

    if(!sendResult.ok) {
      record('F1', 'Alice invokes sendFile(pdf)', 'FAIL', sendResult.reason);
      throw new Error('send failed');
    }
    record('F1', 'Alice invokes sendFile(pdf)', 'PASS');

    await pageA.waitForTimeout(3500);
    if(blossom.size() >= 1) record('F2', 'PDF ciphertext uploaded to MockBlossom', 'PASS');
    else record('F2', 'PDF ciphertext uploaded to MockBlossom', 'FAIL', `size=${blossom.size()}`);

    await pageB.waitForTimeout(RELAY_PROPAGATION_MS);

    // Bob should have a file row with mime application/pdf
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
              .map(r => ({mime: r.fileMetadata?.mimeType, hasFm: !!r.fileMetadata}));
            resolve({count: rows.length, rows});
          };
          all.onerror = () => resolve({error: 'store'});
        };
        req.onerror = () => resolve({error: 'open'});
      });
    });
    console.log('  Bob store:', JSON.stringify(bStore));
    if(bStore.count === 1 && bStore.rows[0].mime === 'application/pdf') {
      record('F3', 'Receiver store has pdf row', 'PASS');
    } else {
      record('F3', 'Receiver store has pdf row', 'FAIL', JSON.stringify(bStore));
    }

    // Bob bubble should render a .document element
    const bBubble = await (async() => {
      const deadline = Date.now() + 20000;
      while(Date.now() < deadline) {
        const found = await pageB.evaluate(() => {
          const bubbles = document.querySelectorAll('.bubble[data-mid]');
          for(const b of bubbles) {
            if(b.classList.contains('is-in')) {
              const doc = b.querySelector('.document');
              if(doc) return {has: true, mid: b.getAttribute('data-mid')};
            }
          }
          return null;
        });
        if(found) return found;
        await pageB.waitForTimeout(500);
      }
      return null;
    })();
    if(bBubble) record('F4', 'Receiver bubble renders document wrapper', 'PASS');
    else record('F4', 'Receiver bubble renders document wrapper', 'FAIL');

    // Programmatically invoke downloadMediaURL on Bob's doc and verify the
    // returned URL is a blob: — this proves the AES-GCM decrypt hook fires
    // for generic files (not just images/audio that auto-load).
    const decryptResult = await pageB.evaluate(async() => {
      try {
        const bubbles = document.querySelectorAll('.bubble.is-in[data-mid]');
        let docObj: any = null;
        for(const b of bubbles) {
          const docDiv: any = b.querySelector('.document');
          if(docDiv?.doc) { docObj = docDiv.doc; break; }
        }
        if(!docObj) return {ok: false, reason: 'no doc object on .document div'};
        const adm = (window as any).appDownloadManager ||
          (await import('/src/lib/appDownloadManager.ts')).default;
        if(!adm?.downloadMediaURL) return {ok: false, reason: 'no downloadMediaURL'};
        const url: string = await adm.downloadMediaURL({media: docObj});
        return {ok: true, url: (url || '').slice(0, 60), isBlob: url?.startsWith('blob:')};
      } catch(err: any) {
        return {ok: false, reason: err?.message || String(err)};
      }
    });
    console.log('  decrypt result:', JSON.stringify(decryptResult));
    if(decryptResult.ok && decryptResult.isBlob) {
      record('F5', 'downloadMediaURL returns blob: URL from decrypted ciphertext', 'PASS', decryptResult.url);
    } else {
      record('F5', 'downloadMediaURL returns blob: URL from decrypted ciphertext', 'FAIL', JSON.stringify(decryptResult));
    }
  } catch(err) {
    console.error('Test error:', err);
  } finally {
    await relay.stop();
    await blossom.stop();
    await ctxA.close();
    await ctxB.close();
    await browser.close();
  }

  console.log('\n========== SUMMARY ==========');
  let passed = 0, failed = 0;
  for(const r of results) { if(r.status === 'PASS') passed++; else failed++; }
  for(const r of results) console.log(`  [${r.status}] ${r.id}: ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
  console.log(`\nTotal: ${passed} passed, ${failed} failed out of ${results.length}`);
  if(failed > 0) process.exit(1);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
