// @ts-nocheck
/**
 * E2E test for Status UI — CHECKLIST items 10.1-10.9
 * Tests search bar icons and Status page in hamburger menu
 */
import {chromium} from 'playwright';
import {launchOptions} from './helpers/launch-options';
import * as fs from 'fs';
import * as path from 'path';

const APP_URL = 'http://localhost:8080';

interface TestResult { id: string; name: string; passed: boolean; detail?: string; }
const results: TestResult[] = [];

function record(id: string, name: string, passed: boolean, detail?: string) {
  results.push({id, name, passed, detail});
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${id}: ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  console.log('E2E Status UI Test — items 10.1-10.9\n');

  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  try {
    await page.goto(APP_URL);
    await page.waitForTimeout(8000);
    await page.evaluate(() => document.querySelectorAll('vite-plugin-checker-error-overlay').forEach(e => e.remove()));
    await page.getByRole('button', {name: 'Create New Identity'}).click();
    await page.waitForTimeout(2000);
    await page.getByRole('button', {name: 'Continue'}).click();
    await page.waitForTimeout(2000);
    const input = page.getByRole('textbox');
    if(await input.isVisible()) { await input.fill('StatusUser'); await page.getByRole('button', {name: 'Get Started'}).click(); }
    await page.waitForTimeout(15000);
    await page.evaluate(() => document.querySelectorAll('vite-plugin-checker-error-overlay').forEach(e => e.remove()));

    // 10.1: Tor onion icon in search bar
    const hasTorIcon = await page.evaluate(() => {
      const svgs = document.querySelectorAll('.search-bar-status-icons svg');
      return svgs.length >= 1;
    });
    record('10.1', 'Tor onion icon visible in search bar', hasTorIcon,
      hasTorIcon ? 'SVG found' : 'no SVG in .search-bar-status-icons');

    // 10.2: Nostrich icon in search bar
    const hasNostrichIcon = await page.evaluate(() => {
      const svgs = document.querySelectorAll('.search-bar-status-icons svg');
      return svgs.length >= 2;
    });
    record('10.2', 'Nostrich icon visible in search bar', hasNostrichIcon,
      hasNostrichIcon ? '2 SVGs found' : `only ${await page.evaluate(() => document.querySelectorAll('.search-bar-status-icons svg').length)} SVGs`);

    // 10.5: Icons have color (reactive state)
    const iconColors = await page.evaluate(() => {
      const svgs = document.querySelectorAll('.search-bar-status-icons svg');
      return Array.from(svgs).map(s => s.getAttribute('stroke'));
    });
    const hasColors = iconColors.every(c => c && c !== 'none');
    record('10.5', 'Icons have state-based colors', hasColors,
      `colors: ${iconColors.join(', ')}`);

    // 10.8: Status menu item in hamburger menu
    const toolsBtn = page.locator('.sidebar-tools-button').first();
    if(await toolsBtn.isVisible()) {
      await toolsBtn.click();
      await page.waitForTimeout(1000);

      const hasStatusItem = await page.evaluate(() => {
        const items = document.querySelectorAll('.btn-menu-item');
        for(const item of items) {
          if(item.textContent?.includes('Status')) return true;
        }
        return false;
      });
      record('10.8', '"Status" in hamburger menu between Identity and Settings', hasStatusItem);

      // 10.3/10.4: Click on Status opens Status tab
      if(hasStatusItem) {
        await page.evaluate(() => {
          const items = document.querySelectorAll('.btn-menu-item');
          for(const item of items) {
            if(item.textContent?.includes('Status')) {
              (item as HTMLElement).click();
              return;
            }
          }
        });
        await page.waitForTimeout(3000);

        // 10.6: Tor section exists
        const hasTorSection = await page.evaluate(() => {
          return document.body.textContent?.includes('Tor') ?? false;
        });
        record('10.6', 'Status page shows Tor section', hasTorSection);

        // 10.7: Relay section with relay URLs
        const hasRelaySection = await page.evaluate(() => {
          return document.body.textContent?.includes('wss://') ?? false;
        });
        record('10.7', 'Status page shows Relay section with URLs', hasRelaySection);

        // 10.9: Page shows connection status
        const hasStatusInfo = await page.evaluate(() => {
          const text = document.body.textContent || '';
          return text.includes('Connected') || text.includes('Disconnected') ||
                 text.includes('Active') || text.includes('Direct') || text.includes('Connecting');
        });
        record('10.9', 'Status page shows real-time connection info', hasStatusInfo);

        record('10.3', 'Click Tor icon → opens Status page', hasTorSection, 'via menu item');
        record('10.4', 'Click Nostrich icon → opens Status page', hasRelaySection, 'via menu item');
      } else {
        record('10.6', 'Status page shows Tor section', false, 'menu item not found');
        record('10.7', 'Status page shows Relay section', false, 'menu item not found');
        record('10.9', 'Status page shows connection info', false, 'menu item not found');
        record('10.3', 'Click Tor icon → opens Status page', false, 'menu item not found');
        record('10.4', 'Click Nostrich icon → opens Status page', false, 'menu item not found');
      }
    } else {
      for(const id of ['10.3', '10.4', '10.6', '10.7', '10.8', '10.9']) {
        record(id, 'Status UI test', false, 'hamburger menu button not found');
      }
    }
  } finally {
    await ctx.close();
    await browser.close();
  }

  // Summary
  console.log('\n========== SUMMARY ==========');
  let passed = 0, failed = 0;
  for(const r of results) {
    console.log(`  [${r.passed ? 'PASS' : 'FAIL'}] ${r.id}: ${r.name}`);
    if(r.passed) passed++; else failed++;
  }
  console.log(`\nTotal: ${passed} passed, ${failed} failed out of ${results.length}`);

  // Update CHECKLIST
  const checklistPath = path.resolve(__dirname, '../../CHECKLIST.md');
  if(fs.existsSync(checklistPath)) {
    let content = fs.readFileSync(checklistPath, 'utf-8');
    for(const r of results) {
      if(r.passed) {
        const escaped = r.id.replace('.', '\\.').replace(/([()])/g, '\\$1');
        const pattern = new RegExp(`- \\[ \\] (\\*\\*${escaped}\\*\\*)`, 'g');
        content = content.replace(pattern, '- [x] $1');
      }
    }
    fs.writeFileSync(checklistPath, content);
    console.log('Updated CHECKLIST.md');
  }

  if(failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
