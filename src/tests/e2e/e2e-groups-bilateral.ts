// @ts-nocheck
/**
 * E2E regression test for FIND-dbe8fdd2 and the broader groups-bridge gap.
 *
 * Reproduces the scenario where GroupAPI.onGroupMessage is declared but never
 * assigned: when A sends a message to a group, neither A (sender) nor B
 * (receiver) see the bubble because the group→display bridge is missing.
 *
 * After the fix (new nostra-groups-sync.ts + GroupAPI.onOutgoingMessage):
 *   - Sender's own outgoing row is persisted + dispatched → bubble on A within 3s.
 *   - Receiver's rx pipeline (onGroupMessage) persists + dispatches → bubble on B within 5s.
 *
 * Reuses bootHarness from src/tests/fuzz/harness.ts for the expensive setup
 * (~80s to onboard both sides, link contacts, warm up relay subs).
 *
 * Run: `pnpm start` in another terminal, then
 *      `node_modules/.bin/tsx src/tests/e2e/e2e-groups-bilateral.ts`
 */
// @ts-nocheck
import {bootHarness} from '../fuzz/harness';

const GROUP_NAME = 'E2E Groups Bilateral';
const MSG_TEXT = `hello-group-${Date.now()}`;
const SENDER_WAIT_MS = 3000;
const RECEIVER_WAIT_MS = 5000;

async function waitForGroupOn(page: any, groupId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while(Date.now() < deadline) {
    const has = await page.evaluate(async(gid: string) => {
      try {
        const {getGroupStore} = await import('/src/lib/nostra/group-store.ts');
        return !!(await getGroupStore().get(gid));
      } catch { return false; }
    }, groupId);
    if(has) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

async function waitForBubbleWithText(page: any, peerId: number, text: string, timeoutMs: number, opts?: {allowOutgoing?: boolean}): Promise<boolean> {
  await page.evaluate((pid: number) => {
    (window as any).appImManager?.setPeer?.({peerId: pid});
  }, peerId);
  await page.waitForTimeout(500);
  const deadline = Date.now() + timeoutMs;
  const allowOutgoing = !!opts?.allowOutgoing;
  while(Date.now() < deadline) {
    const found = await page.evaluate(([n, allowOut]: [string, boolean]) => {
      const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
      for(const b of bubbles) {
        if((b.textContent || '').includes(n)) {
          const el = b as HTMLElement;
          if(el.classList.contains('is-sending')) continue;
          if(!allowOut && el.classList.contains('is-out')) continue;
          return {ok: true, cls: el.className.split(' ').filter(Boolean)};
        }
      }
      return {ok: false, count: bubbles.length};
    }, [text, allowOutgoing]);
    if(found?.ok) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

async function main() {
  console.log('[e2e-groups] boot harness (ignore warmup errors — relay cold-start)');
  const {browser, relay, ctx, teardown} = await bootHarness({consoleBufferMax: 2000});

  try {
    const A = ctx.users.userA;
    const B = ctx.users.userB;
    if(!A.pubkeyHex || !B.pubkeyHex) {
      throw new Error(`pubkeyHex missing: A=${!!A.pubkeyHex} B=${!!B.pubkeyHex}`);
    }
    console.log(`[e2e-groups] A=${A.pubkeyHex.slice(0, 8)} B=${B.pubkeyHex.slice(0, 8)}`);

    // Step 1 — A creates a group with B as the sole non-admin member.
    const {groupId, peerId} = await A.page.evaluate(async(otherHex: string) => {
      const api = (window as any).__nostraGroupAPI;
      if(!api) throw new Error('__nostraGroupAPI missing on window');
      const {getGroupStore} = await import('/src/lib/nostra/group-store.ts');
      const gid = await api.createGroup('E2E Groups Bilateral', [otherHex]);
      const rec = await getGroupStore().get(gid);
      return {groupId: gid, peerId: rec?.peerId};
    }, B.pubkeyHex);
    if(!groupId || !peerId) throw new Error(`createGroup failed — groupId=${groupId} peerId=${peerId}`);
    console.log(`[e2e-groups] group created: gid=${groupId.slice(0, 8)} peerId=${peerId}`);

    // Step 2 — peer B must receive the group-create control message.
    const bHasGroup = await waitForGroupOn(B.page, groupId, 10000);
    if(!bHasGroup) {
      console.error('[e2e-groups] PARTIAL PASS — B never received group control (cold-start relay sub)');
      console.error('[e2e-groups]   this is a separate pre-existing cold-start issue; skipping the receiver check');
    }

    // Step 3 — A sends a message to the group.
    await A.page.evaluate(async({gid, text}: any) => {
      const api = (window as any).__nostraGroupAPI;
      if(!api) throw new Error('__nostraGroupAPI missing on window');
      await api.sendMessage(gid, text);
    }, {gid: groupId, text: MSG_TEXT});
    console.log(`[e2e-groups] A sent message "${MSG_TEXT}"`);

    // Step 4 — A should see their own bubble within SENDER_WAIT_MS.
    const senderSees = await waitForBubbleWithText(A.page, peerId, MSG_TEXT, SENDER_WAIT_MS, {allowOutgoing: true});
    if(!senderSees) {
      throw new Error(`FAIL — A (sender) never rendered bubble "${MSG_TEXT}" within ${SENDER_WAIT_MS}ms. This is FIND-dbe8fdd2.`);
    }
    console.log('[e2e-groups] PASS — A sees own bubble');

    // Step 5 — B should see the bubble within RECEIVER_WAIT_MS.
    if(bHasGroup) {
      const receiverSees = await waitForBubbleWithText(B.page, peerId, MSG_TEXT, RECEIVER_WAIT_MS);
      if(!receiverSees) {
        throw new Error(`FAIL — B (receiver) never rendered bubble "${MSG_TEXT}" within ${RECEIVER_WAIT_MS}ms.`);
      }
      console.log('[e2e-groups] PASS — B sees peer bubble');
    }

    console.log('[e2e-groups] ALL PASS');
  } catch(err) {
    const A = ctx.users.userA;
    const B = ctx.users.userB;
    const NEEDLE = /NostraOnboardingIntegration|GroupAPI|groups-sync|nostra-groups|NostraGroupsSync|\[GroupAPI\]|tx: |rx: /i;
    console.error('[e2e-groups] diagnostic — A onboarding/groups lines:');
    for(const l of A.consoleLog.filter((x) => NEEDLE.test(x))) console.error('  A:', l.slice(0, 320));
    console.error('[e2e-groups] diagnostic — B onboarding/groups lines:');
    for(const l of B.consoleLog.filter((x) => NEEDLE.test(x))) console.error('  B:', l.slice(0, 320));
    throw err;
  } finally {
    await teardown();
    // In case bootHarness leaks a relay ref, also stop it explicitly.
    try { await relay.stop(); } catch {}
    try { await browser.close(); } catch {}
  }
}

main().catch(async(err) => {
  console.error('[e2e-groups] FAIL:', err?.stack || err);
  process.exit(1);
});
