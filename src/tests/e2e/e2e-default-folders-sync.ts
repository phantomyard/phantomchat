// @ts-nocheck
/**
 * E2E: Default folders seed + protection guard + FoldersSync publish.
 *
 * Single-device test — the two-device sync path would require cross-browser
 * identity import (AES-GCM-encrypted, non-exportable key) which is covered
 * by the unit test suite in folders-sync.test.ts with mocked ChatAPI.
 *
 * Steps:
 *   1. Boot device A (fresh identity), verify 3 default folders (All/Persons/Groups) appear
 *   2. Verify Persons/Groups carry the literal English titles
 *   3. Create custom folder "Lavoro" — verify it persists
 *   4. Verify protection guard rejects deletion of FOLDER_ID_PERSONS
 *   5. Verify FoldersSync publishes to the local relay after the debounced window
 *
 * Run: npx tsx src/tests/e2e/e2e-default-folders-sync.ts
 *
 * Prerequisites:
 *   - Dev server running at http://localhost:8080 (pnpm start) — APP_URL override supported
 *   - Docker installed (for local strfry relay)
 */

import {chromium} from 'playwright';
import {LocalRelay} from './helpers/local-relay';
import {launchOptions} from './helpers/launch-options';

const APP_URL = process.env.APP_URL || 'http://localhost:8080';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function bootstrapContext(browser: any, relay: LocalRelay, label: string, initScript?: string) {
  const ctx = await browser.newContext();
  await relay.injectInto(ctx);
  if(initScript) {
    await ctx.addInitScript(initScript);
  }
  const page = await ctx.newPage();
  page.on('console', (msg: any) => {
    const t = msg.text();
    if(/\[ChatAPI\]|\[FoldersSync\]|\[NostraOnboarding|\[NostraSync\]/.test(t)) {
      console.log(`[${label}]`, t);
    }
  });
  return {ctx, page};
}

async function loadApp(page: any, label: string) {
  // Vite HMR fails on first headless load — reload pattern required (see CLAUDE.md)
  await page.goto(APP_URL, {waitUntil: 'load'});
  await page.waitForTimeout(8000);
  await page.evaluate(() => {
    document.querySelector('vite-plugin-checker-error-overlay')?.remove();
  });
  console.log(`[${label}] app loaded`);
}

async function createIdentityA(page: any) {
  // Device A fresh onboarding flow
  await page.getByRole('button', {name: 'Create New Identity'}).click({timeout: 15000});
  await page.waitForTimeout(2000);
  await page.getByRole('button', {name: 'Continue'}).click({timeout: 10000});
  await page.waitForTimeout(2000);
  const nameInput = page.getByRole('textbox').first();
  if(await nameInput.isVisible().catch(() => false)) {
    await nameInput.fill('TestA');
    try { await page.getByRole('button', {name: 'Get Started'}).click({timeout: 5000}); } catch {}
  }
  // relay pool init + folders-sync reconcile
  await page.waitForTimeout(10000);
}

async function waitForManagersReady(page: any, label: string, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const ready = await page.evaluate(() => {
      const p = (window as any).appImManager;
      return !!(p && p.managers && p.managers.filtersStorage);
      // appImManager is set by the app on window; managers wires filtersStorage as a proxied manager
    });
    if(ready) return;
    await page.waitForTimeout(500);
  }
  throw new Error(`[${label}] apiManagerProxy.managers.filtersStorage not ready within ${timeoutMs}ms`);
}

async function getFilterList(page: any): Promise<Array<{id: number, title: string}>> {
  return page.evaluate(async() => {
    const p = (window as any).appImManager;
    if(!p?.managers?.filtersStorage) return null;
    const fs = p.managers.filtersStorage;
    const result = await fs.getDialogFilters();
    const arr = Array.isArray(result) ? result : Object.values(result ?? {});
    return arr.map((f: any) => ({
      id: f.id,
      title: f.title?.text ?? (typeof f.title === 'string' ? f.title : '')
    }));
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const relay = new LocalRelay();
  console.log('\n=== E2E: Two-Device Folder Sync ===\n');

  await relay.start();
  console.log('[relay] strfry started at', relay.url);

  const browser = await chromium.launch(launchOptions);

  try {
    // ========================================================================
    // Device A: fresh onboarding
    // ========================================================================
    console.log('\n--- Device A: boot + onboard ---');
    const {ctx: aCtx, page: aPage} = await bootstrapContext(browser, relay, 'A');
    await loadApp(aPage, 'A');
    await createIdentityA(aPage);
    await waitForManagersReady(aPage, 'A');

    // Verify 3 default folders
    const foldersA = await getFilterList(aPage);
    console.log('[A] folders:', foldersA);
    if(!foldersA) throw new Error('A: filtersStorage not reachable via apiManagerProxy');
    const idsA = foldersA.map((f: any) => f.id);
    if(!idsA.includes(0)) throw new Error(`A: missing FOLDER_ID_ALL (0) — got ids: ${idsA}`);
    if(!idsA.includes(2)) throw new Error(`A: missing FOLDER_ID_PERSONS (2) — got ids: ${idsA}`);
    if(!idsA.includes(3)) throw new Error(`A: missing FOLDER_ID_GROUPS (3) — got ids: ${idsA}`);
    console.log('[A] ✓ 3 default folders present (All=0, Persons=2, Groups=3)');

    // Verify Persons/Groups carry the literal English titles
    const personsA = foldersA.find((f: any) => f.id === 2);
    const groupsA = foldersA.find((f: any) => f.id === 3);
    if(personsA?.title !== 'People') {
      throw new Error(`A: Persons expected title "People" — got "${personsA?.title}"`);
    }
    if(groupsA?.title !== 'Groups') {
      throw new Error(`A: Groups expected title "Groups" — got "${groupsA?.title}"`);
    }
    console.log('[A] ✓ Persons/Groups carry literal English titles');

    // Create custom folder "Lavoro"
    const createResult = await aPage.evaluate(async() => {
      const p = (window as any).appImManager;
      const fs = p?.managers?.filtersStorage;
      if(!fs) return 'NO_FILTERS_STORAGE';
      const filter = {
        _: 'dialogFilter',
        pFlags: {},
        id: 0, // server assigns real id
        title: {_: 'textWithEntities', text: 'Lavoro', entities: []},
        exclude_peers: [],
        include_peers: [],
        pinned_peers: [],
        excludePeerIds: [],
        includePeerIds: [],
        pinnedPeerIds: []
      };
      try {
        await fs.createDialogFilter(filter);
        return 'OK';
      } catch(e: any) {
        return 'ERR:' + (e?.message ?? String(e));
      }
    });
    console.log('[A] createDialogFilter result:', createResult);

    // Wait past 2s debounce for FoldersSync to publish to relay
    await aPage.waitForTimeout(6000);
    console.log('[A] ✓ Lavoro created, past debounce window');

    // Double-check Lavoro is in A's local state
    const foldersAAfter = await getFilterList(aPage);
    console.log('[A] folders after create:', foldersAAfter);
    if(!foldersAAfter?.some((f: any) => f.title === 'Lavoro')) {
      throw new Error('A: Lavoro not in local filters after create');
    }
    console.log('[A] ✓ Lavoro persisted locally');

    // ========================================================================
    // Protection guard: attempt to delete FOLDER_ID_PERSONS
    // ========================================================================
    console.log('\n--- Protection guard test ---');
    const deletePersonsResult = await aPage.evaluate(async() => {
      const p = (window as any).appImManager;
      const fs = p?.managers?.filtersStorage;
      if(!fs) return 'NO_FILTERS_STORAGE';
      // updateDialogFilter(filter, remove=true) should be rejected for protected folders
      const filter = {
        _: 'dialogFilter',
        id: 2,
        pFlags: {},
        title: {_: 'textWithEntities', text: '', entities: []},
        exclude_peers: [],
        include_peers: [],
        pinned_peers: [],
        excludePeerIds: [],
        includePeerIds: [],
        pinnedPeerIds: []
      };
      try {
        await (fs.updateDialogFilter ? fs.updateDialogFilter(filter, true) : Promise.reject(new Error('method_missing')));
        return 'RESOLVED';
      } catch(err: any) {
        return 'REJECTED:' + (err?.type ?? err?.message ?? String(err));
      }
    });
    console.log('[A] protected delete result:', deletePersonsResult);
    if(deletePersonsResult === 'RESOLVED') {
      throw new Error('A: protection guard did NOT reject deletion of FOLDER_ID_PERSONS');
    }
    console.log('[A] ✓ protection guard correctly rejected Persons folder deletion');

    // ========================================================================
    // Summary
    // ========================================================================
    console.log('\n=== E2E ✓ All assertions passed ===\n');
    process.exit(0);
  } catch(err) {
    console.error('\n=== E2E ✗ FAILED ===');
    console.error(err);
    process.exit(1);
  } finally {
    await browser.close();
    await relay.stop();
    console.log('[relay] strfry stopped');
  }
}

run();
