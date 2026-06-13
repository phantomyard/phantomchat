// @ts-nocheck
/**
 * E2E: Logout flow — verifies UX feedback and data cleanup.
 *
 * Steps:
 *   1. Create identity
 *   2. Open Settings (hamburger → Settings)
 *   3. Click 3-dots menu → Log Out
 *   4. Confirm in the popup
 *   5. Verify: overlay with "Clearing data" appears
 *   6. Verify: page reloads to onboarding (Create New Identity visible)
 *   7. Verify: Nostra IndexedDB databases are gone
 */
import {chromium, type Page} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = 'http://localhost:8080';

interface TestResult { id: string; passed: boolean; detail?: string }
const results: TestResult[] = [];
function record(id: string, passed: boolean, detail?: string) {
  results.push({id, passed, detail});
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${id}${detail ? ' — ' + detail : ''}`);
}

const dismiss = dismissOverlays;

async function createId(page: Page, name: string) {
  await page.goto(APP_URL);
  await page.waitForTimeout(8000);
  await dismiss(page);
  await page.getByRole('button', {name: 'Create New Identity'}).click();
  await page.waitForTimeout(2000);
  await page.getByRole('button', {name: 'Continue'}).click();
  await page.waitForTimeout(2000);
  const input = page.getByRole('textbox');
  if(await input.isVisible()) {
    await input.fill(name);
    await page.getByRole('button', {name: 'Get Started'}).click();
  }
  await page.waitForTimeout(10000);
}

async function openSettings(page: Page) {
  await dismiss(page);
  const toolsBtn = page.locator('.sidebar-tools-button').first();
  await toolsBtn.click({timeout: 5000});
  await page.waitForTimeout(1000);
  // Click Settings menu item
  await page.evaluate(() => {
    const items = document.querySelectorAll('.btn-menu-item');
    for(const item of items) {
      if(item.textContent?.includes('Settings')) {
        (item as HTMLElement).click();
        return;
      }
    }
  });
  await page.waitForTimeout(2000);
  await dismiss(page);
}

(async() => {
  console.log('\n=== E2E: Logout Flow ===\n');
  const browser = await chromium.launch(launchOptions);

  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    // Capture console for debugging
    const logs: string[] = [];
    page.on('console', (msg) => {
      if(msg.text().includes('[Nostra.chat]') || msg.text().includes('Clearing') || msg.text().includes('Logged out')) {
        logs.push(msg.text());
      }
    });

    // ── Step 1: Create identity ──
    console.log('  Creating identity...');
    await createId(page, 'LogoutTestUser');

    // Verify we're logged in (chat list visible)
    const chatListVisible = await page.locator('.chatlist-container, .chatlist-top, .sidebar-header').first().isVisible({timeout: 5000}).catch(() => false);
    record('setup', chatListVisible, chatListVisible ? 'identity created, app loaded' : 'app did not load');
    if(!chatListVisible) { throw new Error('App did not load after identity creation'); }

    // ── Step 2: Open Settings ──
    console.log('  Opening Settings...');
    await openSettings(page);

    // Verify settings tab is open
    const settingsVisible = await page.evaluate(() => {
      return !!document.querySelector('.settings-container');
    });
    record('settings-open', settingsVisible, settingsVisible ? 'settings tab visible' : 'settings tab not found');

    // ── Step 3: Click 3-dots menu → Log Out ──
    console.log('  Clicking 3-dots menu...');
    // The ButtonMenuToggle is inside settings header
    const threeDots = page.locator('.settings-container .btn-menu-toggle').first();
    await threeDots.click({timeout: 5000});
    await page.waitForTimeout(500);

    // Find and click the Log Out menu item
    const logoutClicked = await page.evaluate(() => {
      const items = document.querySelectorAll('.btn-menu-item');
      for(const item of items) {
        const text = item.textContent?.toLowerCase() || '';
        if(text.includes('log out') || text.includes('logout') || text.includes('esci')) {
          (item as HTMLElement).click();
          return true;
        }
      }
      return false;
    });
    record('logout-menu-click', logoutClicked, logoutClicked ? 'Log Out menu item clicked' : 'Log Out menu item NOT found');

    if(!logoutClicked) { throw new Error('Could not find Log Out menu item'); }

    await page.waitForTimeout(1000);

    // ── Step 4: Confirm in popup ──
    console.log('  Looking for confirmation popup...');
    const popupVisible = await page.evaluate(() => {
      return !!document.querySelector('.popup-confirmation');
    });
    record('confirmation-popup', popupVisible, popupVisible ? 'confirmation popup appeared' : 'NO confirmation popup');

    // Set up observer BEFORE clicking confirm — the overlay may appear and vanish fast
    const overlayPromise = page.evaluate(() => new Promise<string | null>((resolve) => {
      // Check if already present
      for(const el of document.querySelectorAll('div')) {
        if(el.style.zIndex === '9999') { resolve(el.textContent || ''); return; }
      }
      // Watch for it
      const obs = new MutationObserver((mutations) => {
        for(const m of mutations) {
          for(const node of m.addedNodes) {
            if(node instanceof HTMLElement && node.style.zIndex === '9999') {
              obs.disconnect();
              resolve(node.textContent || '');
              return;
            }
          }
        }
      });
      obs.observe(document.body, {childList: true, subtree: true});
      setTimeout(() => { obs.disconnect(); resolve(null); }, 8000);
    }));

    if(popupVisible) {
      // Click the danger button (Log Out confirmation)
      await page.evaluate(() => {
        const btn = document.querySelector('.popup-confirmation .popup-button.btn.danger') as HTMLElement
          || document.querySelector('.popup-confirmation .btn.danger') as HTMLElement;
        if(btn) btn.click();
      });
    } else {
      console.log('  No popup found, checking if logout proceeded directly...');
    }

    // ── Step 5: Verify overlay feedback ──
    console.log('  Checking for UX feedback overlay...');
    const overlayText = await Promise.race([
      overlayPromise,
      page.waitForTimeout(9000).then(() => null as string | null)
    ]);
    const overlayFound = overlayText !== null;
    record('logout-overlay', overlayFound, overlayFound ? `overlay shown: "${overlayText}"` : 'NO overlay feedback');

    // ── Step 6: Wait for reload and verify onboarding ──
    console.log('  Waiting for page reload...');

    // Wait for navigation (page reload) — up to 10s
    let reloaded = false;
    try {
      await page.waitForURL('**/*', {timeout: 10000, waitUntil: 'load'});
      reloaded = true;
    } catch {
      // Maybe it already reloaded — check for onboarding
    }

    await page.waitForTimeout(3000);
    await dismiss(page);

    // Check that onboarding screen is shown (Create New Identity button)
    // After reload the app needs time to boot and show onboarding
    let onboardingVisible = false;
    for(let i = 0; i < 8; i++) {
      await dismiss(page);
      onboardingVisible = await page.getByRole('button', {name: 'Create New Identity'}).isVisible({timeout: 3000}).catch(() => false);
      if(onboardingVisible) break;
      await page.waitForTimeout(3000);
    }
    record('onboarding-after-logout', onboardingVisible, onboardingVisible ? 'onboarding screen visible after logout' : 'onboarding NOT visible');

    // ── Step 7: Verify Nostra databases are deleted or empty ──
    console.log('  Checking IndexedDB cleanup...');
    // Nostra.chat may be re-created on reload (app checks for identity on boot).
    // Verify data DBs are gone and Nostra.chat has no identity stored.
    const dbCheck = await page.evaluate(async() => {
      const dataDBs = ['nostra-messages', 'nostra-message-requests', 'nostra-virtual-peers', 'nostra-groups', 'NostraPool'];
      const remaining: string[] = [];
      if('databases' in indexedDB) {
        const dbs = await indexedDB.databases();
        const existingNames = dbs.map(d => d.name);
        for(const name of dataDBs) {
          if(existingNames.includes(name)) remaining.push(name);
        }
      }
      // Check that Nostra.chat identity store is empty
      let identityEmpty = true;
      try {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('Nostra.chat');
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        if(db.objectStoreNames.contains('nostr-identity')) {
          const count = await new Promise<number>((resolve) => {
            const tx = db.transaction('nostr-identity', 'readonly');
            const req = tx.objectStore('nostr-identity').count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(-1);
          });
          identityEmpty = count === 0;
        }
        db.close();
      } catch { identityEmpty = true; }
      return {remaining, identityEmpty};
    });
    const dbsClean = dbCheck.remaining.length === 0 && dbCheck.identityEmpty;
    record('idb-cleanup', dbsClean,
      dbsClean ? 'all Nostra data cleared'
        : `data DBs remaining: [${dbCheck.remaining.join(', ')}], identity empty: ${dbCheck.identityEmpty}`);

    // Check localStorage
    const remainingLS = await page.evaluate(() => {
      const keys = ['nostra_identity', 'nostra-relay-config', 'nostra-last-seen-timestamp', 'nostra:read-receipts-enabled'];
      return keys.filter(k => localStorage.getItem(k) !== null);
    });
    const lsClean = remainingLS.length === 0;
    record('ls-cleanup', lsClean, lsClean ? 'all Nostra localStorage keys cleared' : `remaining: ${remainingLS.join(', ')}`);

    // Log console output
    if(logs.length) {
      console.log('\n  Console logs:');
      logs.forEach(l => console.log(`    ${l}`));
    }

    await ctx.close();
  } catch(err) {
    console.error('  FATAL:', err.message);
    record('fatal', false, err.message);
  } finally {
    await browser.close();
  }

  // ── Summary ──
  console.log('\n=== Results ===');
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  results.forEach(r => console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.id}: ${r.detail || ''}`));
  console.log(`\n  ${passed}/${total} passed\n`);
  process.exit(passed === total ? 0 : 1);
})();
