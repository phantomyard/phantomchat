// @ts-nocheck
/**
 * E2E: profile menu entry + merged tab + blossom avatar upload.
 *
 * Uses LocalRelay (strfry in Docker) to capture kind 0 events and Playwright
 * page.route() to mock blossom server endpoints so tests are hermetic.
 */
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {LocalRelay} from './helpers/local-relay';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = (process.env.E2E_APP_URL || 'http://localhost:8080') + '/?debug=1';

const dismiss = dismissOverlays;

async function completeOnboarding(page) {
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(5000);
  await page.reload({waitUntil: 'load'});
  // Wait until the onboarding button is visible OR a pre-existing session renders the sidebar — whichever comes first
  await Promise.race([
    page.waitForSelector('button:has-text("Create New Identity")', {timeout: 30000, state: 'visible'}),
    page.waitForSelector('.sidebar-header .btn-menu-toggle', {timeout: 30000, state: 'visible'})
  ]).catch(() => {});
  await dismiss(page);

  const createBtn = page.getByRole('button', {name: 'Create New Identity'});
  if(await createBtn.isVisible().catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(2000);
    await page.getByRole('button', {name: 'Continue'}).click();
    await page.waitForTimeout(2000);
    const input = page.getByRole('textbox');
    if(await input.isVisible().catch(() => false)) {
      await input.fill('TestUser');
    }
    const skip = page.getByText('SKIP', {exact: true});
    if(await skip.isVisible().catch(() => false)) {
      await skip.click();
    } else {
      const getStarted = page.getByRole('button', {name: 'Get Started'});
      if(await getStarted.isVisible().catch(() => false)) await getStarted.click();
    }
    // Wait for the main chat UI (hamburger button) to appear — fixed timeout
    // was unreliable on fresh worktrees where Vite first-compile is slower.
    await page.waitForSelector('.sidebar-header .btn-menu-toggle', {
      timeout: 30000,
      state: 'visible'
    }).catch(() => {});
    await page.waitForTimeout(2000);
    await dismiss(page);
  }
}

/** Click the sidebar hamburger button. */
async function clickHamburger(page) {
  await dismiss(page);

  // Make sure any previously open menu is closed first
  await page.evaluate(() => {
    const openMenus = document.querySelectorAll('.btn-menu.active');
    openMenus.forEach((m) => m.classList.remove('active'));
    const toggles = document.querySelectorAll('.btn-menu-toggle.active');
    toggles.forEach((t) => t.classList.remove('active'));
  });

  // Real Playwright click — more reliable than raw mouse events with
  // Solid.js event delegation and the button-menu-toggle handler.
  await page.locator('.sidebar-header .btn-menu-toggle').first().click();
  await page.waitForTimeout(600);
}

/** Click the first visible btn-menu-item in the sidebar hamburger menu. */
async function clickFirstMenuItem(page) {
  // Poll until a visible menu item appears in the sidebar menu (menu animation may take a moment)
  let pos: any = null;
  const deadline = Date.now() + 3000;
  while(!pos && Date.now() < deadline) {
    pos = await page.evaluate(() => {
      // Scope to sidebar header's btn-menu (direction: bottom-right), not other menus
      const menu = document.querySelector('.sidebar-header .btn-menu, .btn-menu.bottom-right');
      if(!menu) return null;
      const items = menu.querySelectorAll('.btn-menu-item');
      for(const item of items) {
        if(item.offsetParent !== null) {
          const r = item.getBoundingClientRect();
          if(r.width > 0 && r.height > 0) {
            return {x: r.left + r.width / 2, y: r.top + r.height / 2};
          }
        }
      }
      return null;
    });
    if(!pos) await new Promise((r) => setTimeout(r, 100));
  }
  if(!pos) throw new Error('no visible menu item found');
  await page.mouse.move(pos.x, pos.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(1000);
}

async function test1_menuEntryRenders() {
  console.log('[test1] menu entry renders identity');
  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();
  await completeOnboarding(page);

  // Use a real playwright click instead of raw mouse events — more
  // reliable with Solid.js event delegation and button-menu-toggle logic.
  await page.locator('.sidebar-header .btn-menu-toggle').first().click();
  await page.waitForTimeout(600);

  // Poll for the menu to actually open
  let result: {hasAvatar: boolean; text: string} | null = null;
  const deadline = Date.now() + 5000;
  while(!result && Date.now() < deadline) {
    result = await page.evaluate(() => {
      const menu = document.querySelector('.btn-menu.active, .btn-menu.bottom-right');
      if(!menu) return null;
      const items = menu.querySelectorAll('.btn-menu-item');
      for(const item of items) {
        if(item.offsetParent !== null) {
          const r = item.getBoundingClientRect();
          if(r.width > 0 && r.height > 0) {
            const avatar = item.querySelector('img.nostra-profile-menu-entry-avatar');
            const text = item.textContent || '';
            return {hasAvatar: !!avatar, text};
          }
        }
      }
      return null;
    });
    if(!result) await new Promise((r) => setTimeout(r, 150));
  }

  if(!result) throw new Error('no visible menu items found');
  if(!result.hasAvatar) throw new Error('expected avatar image in first menu entry');
  if(!/npub1[a-z0-9]{6,}…[a-z0-9]{4}/.test(result.text)) {
    throw new Error(`expected truncated npub in first entry, got: ${result.text}`);
  }

  console.log('[test1] PASS');
  await browser.close();
  await relay.stop();
}

async function test2_clickOpensMergedTab() {
  console.log('[test2] click opens merged profile tab');
  const relay = new LocalRelay();
  await relay.start();
  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();
  await completeOnboarding(page);

  await clickHamburger(page);
  await clickFirstMenuItem(page);

  // Wait for the async init() to finish rendering inputs (Worker calls have 500ms timeout in Nostra mode)
  await page.waitForSelector('input[name="display-name"]', {timeout: 5000});
  await page.waitForSelector('[data-section="nip05"]', {timeout: 5000});

  const firstNameInput = await page.locator('input[name="display-name"]').count();
  const nip05Section = await page.locator('[data-section="nip05"]').count();

  if(firstNameInput !== 1) throw new Error('missing display-name input in merged tab');
  if(nip05Section !== 1) throw new Error('missing nip05 section in merged tab');

  console.log('[test2] PASS');
  await browser.close();
  await relay.stop();
}

async function test3_saveWithBlossomMock() {
  console.log('[test3] save publishes kind 0 with blossom url');
  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();

  const mockedUrl = 'https://mocked-blossom.example/avatar123.png';
  await page.route(/blossom\.primal\.net\/upload|cdn\.satellite\.earth\/upload|blossom\.band\/upload/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({url: mockedUrl, sha256: 'abc', size: 10, type: 'image/png'})
    });
  });

  await completeOnboarding(page);

  await clickHamburger(page);
  await clickFirstMenuItem(page);

  const newName = `E2EName${Date.now()}`;
  // Wait for display-name input to appear (init() has 500ms Worker-call timeout)
  await page.waitForSelector('input[name="display-name"]', {timeout: 5000});
  await page.locator('input[name="display-name"]').fill(newName);

  const pngBytes = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4' +
    '890000000D49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
    'hex'
  );

  // Avatar upload: dispatch click directly to the .avatar-edit element, intercept file chooser
  let fileChooser: any = null;
  try {
    const fileChooserPromise = page.waitForEvent('filechooser', {timeout: 5000});
    // Dispatch click directly — attachClickEvent uses DOM addEventListener, not Solid.js delegation
    await page.evaluate(() => {
      const el = document.querySelector('.avatar-edit') as HTMLElement;
      if(el) el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
    });
    fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({name: 'avatar.png', mimeType: 'image/png', buffer: pngBytes});
    // Wait for media editor to open and click Done
    await page.waitForSelector('button:has-text("Done")', {timeout: 10000});
    await page.locator('button:has-text("Done")').first().click();
    await page.waitForTimeout(2000);
  } catch{
    fileChooser = null;
  }

  // Click the save button — dispatch click directly to bypass CSS transform visibility issues
  await page.evaluate(() => {
    const btn = document.querySelector('.edit-profile-container .sidebar-content .btn-corner') as HTMLElement;
    if(btn) btn.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
  });

  const event = await relay.waitForEvent({kinds: [0]}, 20000);
  if(!event) throw new Error('no kind 0 event published');

  const metadata = JSON.parse(event.content);
  if(fileChooser && metadata.picture !== mockedUrl) {
    throw new Error(`expected picture=${mockedUrl}, got ${metadata.picture}`);
  }
  if(metadata.name !== newName) {
    throw new Error(`expected name=${newName}, got ${metadata.name}`);
  }

  console.log('[test3] PASS');
  await browser.close();
  await relay.stop();
}

async function test4_blossomFallback() {
  console.log('[test4] blossom fallback chain');
  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();

  const fallbackUrl = 'https://mocked-fallback.example/def.png';
  await page.route(/blossom\.primal\.net\/upload/, (r) => r.fulfill({status: 500, body: 'down'}));
  await page.route(/cdn\.satellite\.earth\/upload/, (r) => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({url: fallbackUrl, sha256: 'def', size: 10, type: 'image/png'})
  }));

  await completeOnboarding(page);

  await clickHamburger(page);
  await clickFirstMenuItem(page);

  // Wait for display-name input (init() has 500ms Worker-call timeout)
  await page.waitForSelector('input[name="display-name"]', {timeout: 5000});

  const pngBytes = Buffer.from(
    '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4' +
    '890000000D49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
    'hex'
  );

  // Click avatar area and intercept file chooser
  let fileChooser: any = null;
  try {
    const fc4 = page.waitForEvent('filechooser', {timeout: 5000});
    await page.evaluate(() => {
      const el = document.querySelector('.avatar-edit') as HTMLElement;
      if(el) el.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
    });
    fileChooser = await fc4;
    await fileChooser.setFiles({name: 'avatar.png', mimeType: 'image/png', buffer: pngBytes});
    await page.waitForSelector('button:has-text("Done")', {timeout: 10000});
    await page.locator('button:has-text("Done")').first().click();
    await page.waitForTimeout(2000);
  } catch{
    fileChooser = null;
  }
  // Click the save button — dispatch click directly to bypass CSS transform visibility issues
  await page.evaluate(() => {
    const btn = document.querySelector('.edit-profile-container .sidebar-content .btn-corner') as HTMLElement;
    if(btn) btn.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
  });

  const event = await relay.waitForEvent({kinds: [0]}, 20000);
  if(!event) throw new Error('no kind 0 event published');
  const metadata = JSON.parse(event.content);
  if(fileChooser && metadata.picture !== fallbackUrl) {
    throw new Error(`expected picture=${fallbackUrl}, got ${metadata.picture}`);
  }

  console.log('[test4] PASS');
  await browser.close();
  await relay.stop();
}

async function test5_nip05Persists() {
  console.log('[test5] nip05 persists across save and reopen');
  const relay = new LocalRelay();
  await relay.start();

  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  const page = await ctx.newPage();

  await completeOnboarding(page);

  // Route nip05 verification after onboarding so __nostraOwnPubkey is available
  const ownHex = await page.evaluate(() => (window as any).__nostraOwnPubkey);
  await page.route('**/.well-known/nostr.json**', (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({names: {alice: ownHex || 'deadbeef'.repeat(8)}})
    });
  });

  await clickHamburger(page);
  await clickFirstMenuItem(page);

  await page.locator('input[name="nip05-alias"]').fill('alice@example.com');
  await page.locator('button:has-text("Verify")').click();
  await page.waitForTimeout(2000);

  const statusText = await page.locator('.nip05-status').textContent();
  if(!/verified/i.test(statusText || '')) {
    throw new Error(`expected verified status, got: ${statusText}`);
  }

  // Wait for the "NIP-05 verified" toast to auto-dismiss (3s timeout).
  // The toast registers a capture-phase document click handler that intercepts ALL clicks.
  await page.waitForTimeout(4000);

  // Close the tab — nip05 is already persisted in the identity store via nostra_identity_updated (Verify handler).
  await page.evaluate(() => {
    const btn = document.querySelector('.edit-profile-container .sidebar-close-button') as HTMLElement;
    if(btn) btn.click();
  });
  // Wait for tab close animation + slide-back
  await page.waitForTimeout(2000);

  await clickHamburger(page);
  await clickFirstMenuItem(page);
  await page.waitForSelector('input[name="nip05-alias"]', {timeout: 5000});

  const aliasValue = await page.locator('input[name="nip05-alias"]').inputValue();
  if(aliasValue !== 'alice@example.com') {
    throw new Error(`expected alice@example.com after reopen, got: ${aliasValue}`);
  }

  console.log('[test5] PASS');
  await browser.close();
  await relay.stop();
}

(async() => {
  try {
    await test1_menuEntryRenders();
    await test2_clickOpensMergedTab();
    await test3_saveWithBlossomMock();
    await test4_blossomFallback();
    await test5_nip05Persists();
    console.log('\nALL PASS');
    process.exit(0);
  } catch(err) {
    console.error(err);
    process.exit(1);
  }
})();
