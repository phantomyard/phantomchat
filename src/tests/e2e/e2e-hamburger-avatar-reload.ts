// @ts-nocheck
/**
 * E2E regression: hamburger-menu avatar after reload.
 *
 * Root-cause bug: nostra-onboarding-integration.ts used to republish a
 * bare kind 0 (`display_name` + `name` only) on every boot, wiping
 * picture/about/website/lud16/nip05 from the relay. On the next boot
 * refreshOwnProfileFromRelays fetched the bare kind 0, saw it was newer
 * than the cache, and overwrote the cached picture with nothing — so the
 * hamburger avatar fell back to dicebear.
 *
 * Reproduction strategy:
 *   1. Onboard a fresh identity.
 *   2. Seed the profile cache with a known picture URL (mimics a completed
 *      profile save via saveOwnProfileLocal).
 *   3. Reload twice to trigger the republish → relay-clobber → cache-
 *      overwrite progression that used to happen.
 *   4. Open the hamburger WITHOUT visiting the profile tab and assert the
 *      avatar img src is the seeded picture URL.
 */
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = process.env.E2E_APP_URL || 'http://localhost:8080';
const MOCKED_AVATAR_URL = 'https://mocked-blossom.example/avatar-reload-test.png';

async function onboard(page) {
  await page.goto(APP_URL);
  await page.waitForTimeout(10000);
  await dismissOverlays(page);
  await page.getByRole('button', {name: 'Create New Identity'}).click();
  await page.waitForTimeout(2000);
  await page.getByRole('button', {name: 'Continue'}).click();
  await page.waitForTimeout(2000);
  const input = page.getByRole('textbox');
  if(await input.isVisible()) {
    await input.fill('AvatarReloadTest');
    await page.getByRole('button', {name: 'Get Started'}).click();
  }
  await page.waitForTimeout(12000);
  await dismissOverlays(page);
}

async function clickHamburger(page) {
  await dismissOverlays(page);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.querySelectorAll('.btn-menu.active').forEach((m) => m.classList.remove('active'));
    document.querySelectorAll('.btn-menu-toggle.menu-open').forEach((t) => t.classList.remove('menu-open'));
  });
  await page.waitForTimeout(200);
  // Dispatch a synthetic click directly to the button. The ButtonMenuToggle
  // handler uses standard addEventListener, not Solid.js event delegation,
  // so synthetic events fire the handler. hasMouseMovedSinceDown requires
  // mousedown and click to share the same target, so dispatch both on the
  // same element.
  await page.evaluate(() => {
    const btn = document.querySelector('.sidebar-header .btn-menu-toggle') as HTMLElement;
    if(!btn) return;
    btn.dispatchEvent(new MouseEvent('mousedown', {bubbles: true, cancelable: true, view: window}));
    btn.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true, view: window}));
  });
  await page.waitForTimeout(1000);
}

async function readHamburgerAvatarSrc(page): Promise<string> {
  const deadline = Date.now() + 5000;
  while(Date.now() < deadline) {
    const src = await page.evaluate(() => {
      const menu = document.querySelector('.btn-menu.active, .btn-menu.bottom-right');
      if(!menu) return null;
      const img = menu.querySelector('img.nostra-profile-menu-entry-avatar') as HTMLImageElement | null;
      return img?.src ?? null;
    });
    if(src) return src;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('hamburger avatar img not found in menu');
}

async function main() {
  console.log('[test] hamburger avatar after reload (regression)');

  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext({viewport: {width: 1920, height: 1080}});

  // Mock the mocked avatar URL so the browser doesn't try to fetch the
  // fake domain (mocked-blossom.example).
  await ctx.route(MOCKED_AVATAR_URL, (route) => {
    const pngBytes = Buffer.from(
      '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4' +
      '890000000D49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
      'hex'
    );
    route.fulfill({status: 200, contentType: 'image/png', body: pngBytes});
  });

  const page = await ctx.newPage();

  // Collect logs for debugging
  const logs: string[] = [];
  page.on('console', (msg) => {
    const t = msg.text();
    if(/OwnProfileSync|NostraOnboarding|sidebarLeft|hydrate|identity_updated|profile/i.test(t)) {
      logs.push('[console] ' + t);
    }
  });
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  await onboard(page);
  console.log('[test] onboarding complete');

  // ----- Seed the cache -----
  // Write the profile cache with a known picture URL. This mimics what
  // saveOwnProfileLocal would do after a successful profile save.
  await page.evaluate((url) => {
    const cached = {
      profile: {
        name: 'AvatarReloadTest',
        display_name: 'AvatarReloadTest',
        picture: url,
        about: '',
        website: '',
        lud16: ''
      },
      created_at: Math.floor(Date.now() / 1000)
    };
    localStorage.setItem('nostra-profile-cache', JSON.stringify(cached));
  }, MOCKED_AVATAR_URL);
  console.log('[test] seeded profile cache');

  // ----- THE REPRODUCTION -----
  // First reload: the boot-time republish (~3s after mount) used to wipe
  // picture from the relay. Give it plenty of time to run.
  await page.reload();
  await page.waitForTimeout(15000);
  await dismissOverlays(page);

  // Second reload: refreshOwnProfileFromRelays would see the clobbered
  // relay kind 0 as newer than the cache and overwrite the cache — losing
  // the picture entirely. This is the moment the bug becomes visible.
  await page.reload();
  await page.waitForTimeout(15000);
  await dismissOverlays(page);

  const pageState = await page.evaluate(() => {
    return {
      hasHamburger: !!document.querySelector('.sidebar-header .btn-menu-toggle'),
      onboardingText: document.body.textContent?.includes('Create New Identity') || false,
      sidebarPresent: !!document.querySelector('.sidebar-header'),
      url: location.href
    };
  });
  console.log('[debug] post-reload page state:', JSON.stringify(pageState));

  const cacheAfterReload = await page.evaluate(() => localStorage.getItem('nostra-profile-cache'));
  console.log('[test] post-reload cache:', cacheAfterReload?.slice(0, 180));

  // Open hamburger WITHOUT visiting profile
  await clickHamburger(page);
  const menuDebug = await page.evaluate(() => {
    const btn = document.querySelector('.sidebar-header .btn-menu-toggle') as HTMLElement;
    return {
      btnFound: !!btn,
      btnClass: btn?.className,
      menus: Array.from(document.querySelectorAll('.btn-menu')).map((m) => ({
        className: m.className,
        itemCount: m.querySelectorAll('.btn-menu-item').length,
        hasAvatar: !!m.querySelector('img.nostra-profile-menu-entry-avatar')
      }))
    };
  });
  console.log('[debug] post-reload hamburger state:', JSON.stringify(menuDebug));
  const avatarSrc = await readHamburgerAvatarSrc(page);
  console.log('[test] hamburger avatar src after reload:', avatarSrc.slice(0, 120));

  // Also capture whether hasRealPicture was set, by checking whether the
  // src matches our URL or is a data: dicebear.
  const srcKind =
    avatarSrc === MOCKED_AVATAR_URL ? 'REAL' :
      avatarSrc.startsWith('data:') ? 'DICEBEAR_DATA' :
        avatarSrc.startsWith('blob:') ? 'BLOB' :
          avatarSrc === '' ? 'EMPTY' :
            'OTHER';
  console.log('[test] src kind:', srcKind);

  for(const l of logs.slice(-30)) console.log(l);

  if(avatarSrc === MOCKED_AVATAR_URL) {
    console.log('\n[test] PASS — hamburger shows real avatar after reload');
    await browser.close();
    return;
  }

  console.log('\n[test] FAIL — hamburger avatar did NOT match expected URL');
  console.log('[test] expected:', MOCKED_AVATAR_URL);
  console.log('[test] actual:  ', avatarSrc);
  await browser.close();
  throw new Error('hamburger avatar did not render the real picture after reload');
}

(async() => {
  try {
    await main();
    process.exit(0);
  } catch(err) {
    console.error(err);
    process.exit(1);
  }
})();
