// @ts-nocheck
/**
 * E2E — Group send via UI + reload-attribution regression.
 *
 * Drives the entire group create + send + reload flow using ONLY real UI
 * interactions (clicks + keyboard). No `page.evaluate(() => window.X.method())`
 * to invoke internal APIs — DOM reads are used solely to assert state.
 *
 * Covers three recently fixed defects:
 *   1. Chat input must be visible in groups (synthetic Chat.chat with
 *      empty `default_banned_rights`).
 *   2. Outgoing group bubbles must render on the right with a real
 *      sender (handleGroupOutgoing passes `fromPeerId` + own User
 *      injected via the shared helper).
 *   3. After reload the same bubble stays on the right and the sender
 *      resolves correctly (handleGroupIncoming preserves
 *      `isOutgoing: senderPubkey === ownPubkey` so own-self relay
 *      echoes don't flip the persisted row to incoming;
 *      getGroupHistory rebuilds outgoing rows with `from_id`).
 *
 * Run: `pnpm start` in another terminal, then
 *      `node_modules/.bin/tsx src/tests/e2e/e2e-groups-ui-attribution.ts`
 *
 * Prereqs: dev server on http://localhost:8080.
 */
import {bootHarness} from '../fuzz/harness';

const GROUP_NAME = `UI-Group-${Date.now()}`;
const MSG_TEXT = `ui-msg-${Date.now()}`;
const STEP_TIMEOUT_MS = 15000;
const RELOAD_SETTLE_MS = 12000;

const log = (m: string) => console.log(`[e2e-groups-ui] ${m}`);

async function clickNewGroupViaUI(page: any): Promise<void> {
  const fab = page.locator('.btn-new-menu, .sidebar-tools-button').first();
  await fab.waitFor({state: 'visible', timeout: STEP_TIMEOUT_MS});
  await fab.click();
  await page.waitForTimeout(400);

  const newGroup = page.getByText('New Group', {exact: true}).first();
  await newGroup.waitFor({state: 'visible', timeout: STEP_TIMEOUT_MS});
  await newGroup.click();
  log('clicked New Group menu item');
}

async function selectMemberAndContinue(page: any, memberDisplayName: string): Promise<void> {
  await page.locator('.add-members-container, [data-tab="add-members"], .new-group-container').first()
    .or(page.getByText(memberDisplayName, {exact: false}).first())
    .waitFor({state: 'visible', timeout: STEP_TIMEOUT_MS});

  const memberRow = page.getByText(memberDisplayName, {exact: false}).first();
  await memberRow.waitFor({state: 'visible', timeout: STEP_TIMEOUT_MS});
  await memberRow.click();
  log(`selected member "${memberDisplayName}"`);

  await page.waitForTimeout(300);

  const nextBtn = page.locator('.btn-corner.tgico-arrow_next, .btn-corner [data-icon="arrow_next"], .btn-corner.is-visible').first();
  await nextBtn.waitFor({state: 'visible', timeout: STEP_TIMEOUT_MS});
  await nextBtn.click();
  log('clicked next');
}

async function fillNameAndCreate(page: any, groupName: string): Promise<void> {
  const container = page.locator('.new-group-container').first();
  await container.waitFor({state: 'visible', timeout: STEP_TIMEOUT_MS});

  const nameInput = container.locator('.input-field-input').first();
  await nameInput.waitFor({state: 'visible', timeout: STEP_TIMEOUT_MS});
  await nameInput.click();
  await nameInput.fill(groupName);
  log(`typed group name "${groupName}"`);

  await page.waitForTimeout(300);

  const createBtn = container.locator('.btn-corner.is-visible').first();
  await createBtn.waitFor({state: 'visible', timeout: STEP_TIMEOUT_MS});
  await createBtn.click();
  log('clicked create');
}

async function assertChatInputVisible(page: any): Promise<void> {
  const input = page.locator('.chat-input [contenteditable="true"]').first();
  await input.waitFor({state: 'visible', timeout: STEP_TIMEOUT_MS});
  // Confirm the wrapping `.chat-input` does NOT carry the `hide` or `is-hidden`
  // class — the regression for fix #1 was an entirely hidden input element.
  const hidden = await page.evaluate(() => {
    const el = document.querySelector('.chat-input');
    if(!el) return 'missing';
    const classes = el.className || '';
    return /\bhide\b|\bis-hidden\b/.test(classes) ? `hidden(${classes})` : 'ok';
  });
  if(hidden !== 'ok') throw new Error(`FAIL — chat input is hidden in group: ${hidden}`);
  log('PASS — chat input visible in group');
}

async function typeAndSend(page: any, text: string): Promise<void> {
  const input = page.locator('.chat-input [contenteditable="true"]').first();
  await input.click();
  await input.fill(text);
  log(`typed message "${text}"`);

  const sendBtn = page.locator('.chat-input button.btn-send').first();
  await sendBtn.waitFor({state: 'visible', timeout: STEP_TIMEOUT_MS});
  await sendBtn.click();
  log('clicked send');
}

async function findOwnBubble(page: any, text: string, timeoutMs: number): Promise<{cls: string; nameTitle: string} | null> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const found = await page.evaluate((needle: string) => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
      for(const b of bubbles) {
        if((b.textContent || '').includes(needle)) {
          const el = b as HTMLElement;
          const titleEl = el.querySelector('.peer-title, .name');
          return {
            cls: el.className,
            nameTitle: (titleEl?.textContent || '').trim()
          };
        }
      }
      return null;
    }, text);
    if(found) return found;
    await page.waitForTimeout(250);
  }
  return null;
}

function assertOutgoingAttribution(label: string, found: {cls: string; nameTitle: string} | null): void {
  if(!found) throw new Error(`FAIL ${label} — bubble for "${MSG_TEXT}" not found`);
  const isOut = /\bis-out\b/.test(found.cls);
  const isIn = /\bis-in\b/.test(found.cls);
  if(!isOut || isIn) {
    throw new Error(`FAIL ${label} — bubble rendered on the LEFT (cls="${found.cls}"). Expected is-out, got is-in.`);
  }
  if(/^Deleted Account$/i.test(found.nameTitle)) {
    throw new Error(`FAIL ${label} — bubble sender title is "Deleted Account" (cls="${found.cls}").`);
  }
  log(`PASS ${label} — bubble on right (is-out), sender="${found.nameTitle || '(no title — own bubble)'}"`);
}

async function reopenGroupAfterReload(page: any, groupName: string): Promise<void> {
  await page.waitForTimeout(RELOAD_SETTLE_MS);
  // The group dialog row carries the title text. Click it to open the chat.
  const dialog = page.locator('.chatlist .row').filter({hasText: groupName}).first();
  await dialog.waitFor({state: 'visible', timeout: STEP_TIMEOUT_MS});
  await dialog.click();
  log(`re-opened group "${groupName}" after reload`);
  await page.waitForSelector('.chat-input [contenteditable="true"]', {state: 'visible', timeout: STEP_TIMEOUT_MS});
}

async function main(): Promise<void> {
  log('boot harness');
  const {ctx, teardown} = await bootHarness({consoleBufferMax: 2000});

  try {
    const A = ctx.users.userA;
    const B = ctx.users.userB;

    // Step 1 — open the new-group flow.
    await clickNewGroupViaUI(A.page);

    // Step 2 — pick B and continue.
    await selectMemberAndContinue(A.page, B.displayName);

    // Step 3 — fill name and confirm.
    await fillNameAndCreate(A.page, GROUP_NAME);

    // Step 4 — chat input must render (fix #1).
    await assertChatInputVisible(A.page);

    // Step 5 — type + send via the input.
    await typeAndSend(A.page, MSG_TEXT);

    // Step 6 — verify bubble attribution (fix #2).
    const beforeReload = await findOwnBubble(A.page, MSG_TEXT, STEP_TIMEOUT_MS);
    assertOutgoingAttribution('pre-reload', beforeReload);

    // Step 7 — reload and re-open the group.
    log('reloading page A');
    await A.page.reload({waitUntil: 'load', timeout: 60000});
    await reopenGroupAfterReload(A.page, GROUP_NAME);

    // Step 8 — verify same bubble still on the right with proper sender (fix #3).
    const afterReload = await findOwnBubble(A.page, MSG_TEXT, STEP_TIMEOUT_MS);
    assertOutgoingAttribution('post-reload', afterReload);

    log('ALL PASS');
  } finally {
    await teardown();
  }
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('[e2e-groups-ui] FAIL', err);
  process.exit(1);
});
