// @ts-nocheck
/**
 * Run Vite, then FUZZ_APP_URL=http://localhost:8080 pnpm exec tsx
 * src/tests/e2e/e2e-sidebar-message-search.ts.
 * Uses fresh identities and an isolated relay; no live account or public service.
 * Drive the visible input through the actual worker bridge, not a mocked manager.
 */
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect} from '@playwright/test';
import {chromium} from 'playwright';
import {generateSecretKey, getPublicKey} from 'nostr-tools';
import {createUser, sendTextViaUI} from '../fuzz/harness';
import {LocalRelay} from './helpers/local-relay';
import {useIsolatedNetwork} from './helpers/isolated-network';

useIsolatedNetwork();
const artifacts = process.env.PHANTOMBOT_SCRATCH || tmpdir();

async function main() {
  const relay = new LocalRelay();
  await relay.start();
  const browser = await chromium.launch({headless: true});
  let user;
  try {
    user = await createUser(browser, 'userA', 'Search Tester', relay, {});
    const page = user.page;
    await page.setViewportSize({width: 1280, height: 900});
    await page.waitForFunction(() => !!window.appSidebarLeft && !!window.__phantomchatGroupAPI);
    // Real APIs mint modern 96-hex group/session ids and persist their messages.
    const groups = await page.evaluate(async() => {
      const {getGroupAPI} = await import('/src/lib/phantomchat/group-api.ts');
      const {getGroupStore} = await import('/src/lib/phantomchat/group-store.ts');
      const api = getGroupAPI();
      const groupId = await api.createGroup('Search Group', []);
      const sessionId = await api.createGroup('Search Session', [], undefined, {kind: 'session'});
      for(let i = 0; i < 22; i++) await api.sendMessage(groupId, `hartle group match ${i}`);
      await api.sendMessage(sessionId, 'hartle session match');
      return {group: (await getGroupStore().get(groupId)).peerId, session: (await getGroupStore().get(sessionId)).peerId};
    });
    user.remotePeerId = await page.evaluate(async(pubkey) => {
      const {addP2PContact} = await import('/src/lib/phantomchat/add-p2p-contact.ts');
      return (await addP2PContact({pubkey, nickname: 'Unrelated Contact', source: 'search-e2e'})).peerId;
    }, getPublicKey(generateSecretKey()));
    await sendTextViaUI(user, 'hartle private match');

    const input = page.locator('#column-left .input-search-input').first();
    const group = page.locator('#search-container .search-group-messages');
    const rows = group.locator('[data-mid]');
    await input.fill('hartle');
    await expect(rows).toHaveCount(20, {timeout: 15000});
    await expect(group).toContainText('24 messages found');
    await expect(page.locator('#search-container .search-group-contacts:visible [data-peer-id]')).toHaveCount(0);
    await group.locator('.search-group__show-more').click();
    await expect(rows).toHaveCount(24);
    const hits = await rows.evaluateAll(els => els.map(el => ({peer: +el.dataset.peerId, mid: el.dataset.mid, text: el.textContent})));
    assert.equal(new Set(hits.map(hit => `${hit.peer}:${hit.mid}`)).size, 24, 'no duplicate results');
    assert.deepEqual(new Set(hits.map(hit => hit.peer)), new Set([groups.group, groups.session, user.remotePeerId]));
    await expect(group.locator('.search-group__show-more')).toHaveCount(0);
    await group.locator('.search-group__name').scrollIntoViewIfNeeded();
    await page.screenshot({path: join(artifacts, 'search-desktop.png')});
    console.log('PASS: typing finds DM, modern group and session; Show more returns 24 unique hits');

    const sessionRow = rows.filter({hasText: 'hartle session match'});
    const sessionMid = await sessionRow.getAttribute('data-mid');
    await sessionRow.click();
    await page.waitForFunction(peer => +window.appImManager.chat.peerId === peer, groups.session);
    await expect(page.locator(`.bubble[data-mid="${sessionMid}"] .message`).first()).toContainText('hartle session match', {timeout: 15000});
    console.log('PASS: clicking a result opens the session at its matching message');

    await input.fill('no-such-message-xyz');
    await expect(group).toBeVisible();
    await expect(group).toContainText('No messages found');
    await expect(rows).toHaveCount(0);
    await input.fill('hartle');
    await expect(rows).toHaveCount(20);
    // Clearing invalidates outstanding requests and removes message results.
    await input.fill('hartle group');
    await page.locator('#column-left .input-search-clear').first().click();
    await expect(input).toHaveValue('');
    await expect(group).toBeHidden();
    await page.waitForTimeout(500);
    await expect(group).toBeHidden();
    console.log('PASS: no-match state, replacement query and clearing');

    await page.setViewportSize({width: 390, height: 844});
    await page.evaluate(() => window.appImManager.selectTab(0)); // back to the chat list on phone
    await expect(input).toBeInViewport();
    await input.fill('hartle session');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toBeInViewport();
    await page.screenshot({path: join(artifacts, 'search-mobile.png')});
    assert.deepEqual(user.consoleLog.filter(line => line.startsWith('[pageerror]')), [], 'no browser errors');
    console.log('PASS: phone input shows the session match; no browser errors');
  } finally {
    if(user) writeFileSync(join(artifacts, 'search-console.log'), user.consoleLog.join('\n'));
    await browser.close();
    await relay.stop();
  }
}
main().then(() => process.exit(0)).catch(error => {console.error(error); process.exit(1);});
