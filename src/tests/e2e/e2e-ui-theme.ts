// @ts-nocheck
/**
 * E2E: the UI theme selector (#317), through the real Interface Settings row.
 *
 *  - Fun and Relaxed is the default: no data-ui-theme attribute on <html>.
 *  - Picking Boring Corporate persists per device and reloads into the costume.
 *  - The costume beats ThemeController's inline colours, on <html> and in Day and Night.
 *  - The saved accent and wallpaper are never rewritten: switching back restores them.
 *  - An unknown stored value falls back to Fun and Relaxed.
 *  - A failing localStorage write still reloads, onto the theme the app can read.
 *
 * Start Vite separately, then run:
 * E2E_APP_URL=http://127.0.0.1:8080 pnpm exec tsx src/tests/e2e/e2e-ui-theme.ts
 * CHROMIUM_PATH overrides the browser when Playwright's pinned build is absent.
 */
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import {dismissOverlays} from './helpers/dismiss-overlays';

const APP_URL = process.env.E2E_APP_URL || 'http://localhost:8080';
const KEY = 'phantomchat:ui-theme';

const attribute = (page) => page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'));
const stored = (page) => page.evaluate((key) => localStorage.getItem(key), KEY);
const colour = (page, name) => page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
const savedThemes = (page) => page.evaluate(() => JSON.stringify(window.rootScope.settings.themes));
const ready = (page) => page.waitForFunction(() => window.rootScope?.settings?.themes?.length && document.querySelector('.folders-sidebar, .sidebar-header'), undefined, {timeout: 60000});

async function createIdentity(page) {
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(8000);
  await dismissOverlays(page);
  await page.getByRole('button', {name: /create new identity/i}).click();
  await page.waitForTimeout(2000);
  await page.getByRole('button', {name: 'Continue'}).click();
  await page.waitForTimeout(2000);
  const input = page.getByRole('textbox');
  if(await input.isVisible()) {
    await input.fill('ThemeTest');
    await page.getByRole('button', {name: 'Get Started'}).click();
  }
  await page.waitForTimeout(10000);
  await dismissOverlays(page);
  await ready(page);
}

async function openInterfaceSettings(page) {
  const menuButton = page.locator('.folders-sidebar__menu-button, .btn-menu-toggle').first();
  await menuButton.waitFor({state: 'visible'});
  const box = await menuButton.boundingBox();
  const settingsItem = page.locator('.btn-menu.active .btn-menu-item', {hasText: 'Settings'}).first();
  // Straight after a reload the button paints before its handler is attached,
  // so a click can land on nothing: click again until the menu actually opens.
  for(let attempt = 1; ; attempt++) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    try {
      await settingsItem.waitFor({state: 'visible', timeout: 3000});
      break;
    } catch(err) {
      if(attempt === 10) throw err;
    }
  }
  await settingsItem.click();
  await page.waitForTimeout(1200);
  await page.locator('#column-left .row', {hasText: 'Interface Settings'}).first().click();
  await page.waitForTimeout(1200);
}

async function pick(page, name) {
  await openInterfaceSettings(page);
  const row = page.locator('#column-left .row', {hasText: name}).first();
  const navigation = page.waitForEvent('load', {timeout: 60000});
  await row.click();
  await navigation;
  await page.waitForTimeout(4000);
  await ready(page);
}

async function main() {
  const browser = await chromium.launch({
    ...launchOptions,
    ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})
  });
  const context = await browser.newContext({viewport: {width: 1280, height: 800}});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    await createIdentity(page);
    assert.equal(await attribute(page), null, 'Fun and Relaxed is the default');
    assert.equal(await stored(page), null, 'nothing is written until the user picks a theme');
    const funPrimary = await colour(page, '--primary-color');
    const themes = await savedThemes(page);

    await pick(page, 'Boring Corporate');
    assert.equal(await stored(page), 'boring-corporate');
    assert.equal(await attribute(page), 'boring-corporate');
    const night = await page.evaluate(() => document.documentElement.classList.contains('night'));
    assert.equal((await colour(page, '--primary-color')).toLowerCase(), night ? '#346bf1' : '#1b4ed8', 'the costume beats the inline accent');
    assert.equal(await savedThemes(page), themes, 'saved accent and wallpaper are not rewritten');

    await page.evaluate(async() => {
      const {default: themeController} = await import('/src/helpers/themeController.ts');
      await themeController.switchTheme(themeController.isNight() ? 'day' : 'night');
    });
    await page.waitForTimeout(1500);
    assert.equal((await colour(page, '--primary-color')).toLowerCase(), night ? '#1b4ed8' : '#346bf1', 'the costume follows Day and Night');
    await page.evaluate(async(wasNight) => {
      const {default: themeController} = await import('/src/helpers/themeController.ts');
      await themeController.switchTheme(wasNight ? 'night' : 'day');
    }, night);
    await page.waitForTimeout(1500);

    await pick(page, 'Fun and Relaxed');
    assert.equal(await attribute(page), null, 'switching back removes the costume');
    assert.equal(await colour(page, '--primary-color'), funPrimary, 'switching back restores the accent');
    assert.equal(await savedThemes(page), themes, 'saved accent and wallpaper survive the round trip');

    const storedBefore = await stored(page);
    await page.evaluate((key) => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function(name, value) {
        if(name === key) throw new DOMException('blocked', 'QuotaExceededError');
        return setItem.call(this, name, value);
      };
    }, KEY);
    await pick(page, 'Boring Corporate');
    assert.equal(await stored(page), storedBefore, 'a failed write persists nothing');
    assert.equal(await attribute(page), null, 'a failed write comes back on the readable theme');

    await page.evaluate((key) => localStorage.setItem(key, 'neon-disco'), KEY);
    await page.reload({waitUntil: 'load'});
    assert.equal(await attribute(page), null, 'an unknown value falls back to Fun and Relaxed');

    assert.deepEqual(errors, [], 'no page errors');
    console.log('PASS UI theme selector round trip');
  } finally {
    await browser.close();
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('FAIL', error);
  process.exit(1);
});
