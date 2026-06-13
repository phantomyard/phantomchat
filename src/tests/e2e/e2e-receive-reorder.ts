// @ts-nocheck
/**
 * Targeted E2E for the receive-reorder fix.
 *
 * When B sends a message to A, the chat-list virtual list re-sorts A's
 * row for B to the top. The sort key comes from
 * `dialogsStorage.getDialogIndex(peerId, ...)` (Worker-side). The send path
 * already updates this via `setDialogTopMessage`. Without the fix, the
 * receive path (handleIncomingMessage) only injected the message into
 * mirrors and did not bump `dialogsStorage.dialogs[peerId].index_0`, so
 * `sortedList.update(key)` queried the Worker, read the stale index, and
 * the row stayed put.
 *
 * This test asserts that on receive, A's `index_0` for B advances past
 * its prior value. Bypasses UI by sending via appMessagesManager
 * (UI clicks are flaky in headless and orthogonal to the sort logic).
 *
 * Run:
 *   FUZZ_APP_URL=http://localhost:8083 \
 *     node_modules/.bin/tsx src/tests/e2e/e2e-receive-reorder.ts
 */

import {bootHarness} from '../fuzz/harness';

async function readDialog(page: any, peerId: number) {
  return page.evaluate(async(pid: number) => {
    const rs: any = (window as any).rootScope;
    const index: any = await rs.managers.dialogsStorage.getDialogIndex(pid, 'index_0');
    const dialog: any = await rs.managers.dialogsStorage.getDialogOnly(pid);
    return {index, top_message: dialog?.top_message};
  }, peerId);
}

async function sendViaManager(user: any, peerId: number, text: string) {
  return user.page.evaluate(async ({pid, t}: any) => {
    const rs = (window as any).rootScope;
    return rs.managers.appMessagesManager.sendText({peerId: pid, text: t});
  }, {pid: peerId, t: text});
}

async function waitForDispatch(user: any, sinceIdx: number, timeoutMs = 30000) {
  const start = Date.now();
  while(Date.now() - start < timeoutMs) {
    for(let i = sinceIdx; i < user.consoleLog.length; i++) {
      if(user.consoleLog[i].includes('[NostraSync] dispatching nostra_new_message')) return user.consoleLog[i];
    }
    await user.page.waitForTimeout(400);
  }
  return null;
}

async function main() {
  const {ctx, teardown} = await bootHarness({headed: false});
  const A = ctx.users.userA, B = ctx.users.userB;

  try {
    // A.remotePeerId = peerId A uses for B; B.remotePeerId = peerId B uses for A.
    // From A's perspective, B's row is keyed by A.remotePeerId — that's where
    // the chat-list sort index lives.
    const peerBOnA = A.remotePeerId;

    // Seed the conversation so it's persisted in IndexedDB (message-store).
    // setDialogTopMessage no-ops if Worker.dialogsStorage[peerId] is missing,
    // which it always is on a fresh boot for new P2P peers. After reload
    // the Worker fetches dialogs via VMT.getDialogs and populates the storage,
    // mirroring the user's "I've been chatting, now reopened the app" scenario.
    console.log('[test] seed: A sends → B sends → reload A');
    await sendViaManager(A, A.remotePeerId, 'SEED-A-TO-B');
    await A.page.waitForTimeout(2000);
    await sendViaManager(B, B.remotePeerId, 'SEED-B-TO-A');
    await A.page.waitForTimeout(3500);

    // Reload A so Worker.dialogsStorage gets populated via VMT.getDialogs.
    await A.page.reload({waitUntil: 'load'});
    await A.page.waitForTimeout(8000);

    const idxBefore = await readDialog(A.page, peerBOnA);
    console.log('[test] idxBefore:', JSON.stringify(idxBefore));
    if(idxBefore.index === undefined) {
      throw new Error(`Setup failure: A still has no dialog for B (peerId=${peerBOnA}) after reload.`);
    }

    // Snapshot B's console position so we only count the upcoming dispatch.
    const sinceIdx = B.consoleLog.length;

    // Wait so the next message's `created_at` is at least 2s newer than the
    // last warmup message — Nostr created_at is second-precision.
    await new Promise((r) => setTimeout(r, 2500));

    // B sends a fresh message to A. B addresses A via B.remotePeerId.
    console.log('[test] B sending PROBE to A (peerId B uses for A=', B.remotePeerId, ')');
    await sendViaManager(B, B.remotePeerId, 'PROBE-RECEIVE-REORDER');

    const heard = await waitForDispatch(A, A.consoleLog.length /* don't care, we look forward */, 30000);
    if(!heard) {
      const log = A.consoleLog.filter((l: string) => l.includes('ChatAPI') || l.includes('NostraSync')).slice(-15).join('\n');
      throw new Error(`A never logged nostra_new_message in 30s.\nA's relay log tail:\n${log}`);
    }
    console.log('[test] A received nostra_new_message');

    // Allow the Worker round-trip: setDialogTopMessage → scheduleHandleNewDialogs
    // → handleNewDialogs → dispatch dialogs_multiupdate.
    await A.page.waitForTimeout(2500);

    const idxAfter = await readDialog(A.page, peerBOnA);
    console.log('[test] idxAfter: ', JSON.stringify(idxAfter));

    if(idxAfter.index === undefined) {
      throw new Error(`FAIL: idxAfter.index is undefined. dialog: ${JSON.stringify(idxAfter)}`);
    }
    if(idxAfter.index <= idxBefore.index) {
      throw new Error(
        `FAIL: index_0 did not advance on receive. before=${idxBefore.index} after=${idxAfter.index} ` +
        '(receive-reorder fix not active or not effective)'
      );
    }
    if(idxAfter.top_message === idxBefore.top_message) {
      throw new Error(
        `FAIL: top_message did not advance. before=${idxBefore.top_message} after=${idxAfter.top_message}`
      );
    }

    console.log(`[test] PASS  index_0:     ${idxBefore.index} → ${idxAfter.index}`);
    console.log(`[test] PASS  top_message: ${idxBefore.top_message} → ${idxAfter.top_message}`);
  } finally {
    await teardown();
  }
}

main().then(
  () => process.exit(0),
  (err) => { console.error('[test] error:', err?.message || err); process.exit(1); }
);
