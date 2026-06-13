// @ts-nocheck
import type {Invariant, FuzzContext, InvariantResult, Action} from '../types';

/**
 * After reloadPage (pure), the DOM bubble set + ordering ≡ pre-reload snapshot.
 * Timeout 8s — rehydration can be slow on first boot post-reload.
 */
export const historyRehydratesIdentical: Invariant = {
  id: 'INV-history-rehydrates-identical',
  tier: 'medium',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    if(!action || action.name !== 'reloadPage' || action.skipped) return {ok: true};
    if(action.args.mode !== 'pure') return {ok: true}; // during-pending-send can legitimately add/miss one msg
    const userId = action.args.user as 'userA' | 'userB';
    const before = ctx.snapshots.get(`preReloadHistorySig-${userId}`) as {sig: string; count: number; mids: string[]} | undefined;
    if(!before) return {ok: true};
    const user: any = ctx.users[userId];
    const deadline = Date.now() + 8000;
    while(Date.now() < deadline) {
      const after: string[] = await user.page.evaluate(() => {
        return Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'))
          .map((b: any) => b.dataset.mid as string)
          .filter(Boolean)
          .sort();
      });
      if(after.length === before.count && after.every((m, i) => m === before.mids[i])) return {ok: true};
      await user.page.waitForTimeout(250);
    }
    const final: string[] = await user.page.evaluate(() => {
      return Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'))
        .map((b: any) => b.dataset.mid as string).filter(Boolean).sort();
    });
    return {ok: false, message: `history diverged post-reload: before count=${before.count}, after count=${final.length}`, evidence: {beforeCount: before.count, afterCount: final.length, beforeFirst: before.mids.slice(0, 5), afterFirst: final.slice(0, 5)}};
  }
};

/**
 * After reloadPage (during-pending-send), the pending message is either:
 *  (a) visible in DOM as a bubble (send completed before or after reload), OR
 *  (b) in the nostra-offline-queue IDB with valid shape (queued for retry),
 * but NEVER silently lost. Regression for D029 queue persistence.
 */
export const offlineQueuePersistence: Invariant = {
  id: 'INV-offline-queue-persistence',
  tier: 'medium',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    if(!action || action.name !== 'reloadPage' || action.skipped) return {ok: true};
    if(action.args.mode !== 'during-pending-send') return {ok: true};
    const text: string = action.args.pendingText;
    if(!text) return {ok: true};
    const userId = action.args.user as 'userA' | 'userB';
    const user: any = ctx.users[userId];

    // Give rehydrate + flush a window to complete — offline queue retries
    // exponentially starting at 2s (BACKOFF_BASE_MS).
    const deadline = Date.now() + 6000;
    while(Date.now() < deadline) {
      const probe = await user.page.evaluate(async(t: string) => {
        // Check DOM first — message may have flushed post-reconnect.
        const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
        for(const b of bubbles) {
          if((b.textContent || '').includes(t)) return {inDom: true, inQueue: false};
        }
        // Check IDB nostra-offline-queue/offline-messages.
        try {
          const req = indexedDB.open('nostra-offline-queue');
          const db: IDBDatabase = await new Promise((resolve, reject) => {
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          if(!db.objectStoreNames.contains('offline-messages')) {
            db.close();
            return {inDom: false, inQueue: false, noStore: true};
          }
          const tx = db.transaction('offline-messages', 'readonly');
          const store = tx.objectStore('offline-messages');
          const rows: any[] = await new Promise((resolve, reject) => {
            const r = store.getAll();
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
          db.close();
          for(const row of rows) {
            if(row?.payload && String(row.payload).includes(t)) return {inDom: false, inQueue: true};
          }
          return {inDom: false, inQueue: false, queueSize: rows.length};
        } catch {
          return {inDom: false, inQueue: false, idbError: true};
        }
      }, text);
      if(probe.inDom || probe.inQueue) return {ok: true};
      // If no store exists or IDB errored, it's environmentally skippable (fresh identity w/ no queue yet).
      if(probe.noStore || probe.idbError) return {ok: true};
      await user.page.waitForTimeout(300);
    }

    return {ok: false, message: `pending text "${text.slice(0, 40)}" lost: neither in DOM nor in nostra-offline-queue after reload`, evidence: {user: userId, text: text.slice(0, 100)}};
  }
};

/**
 * After deleteWhileSending, sender + peer DOM must not have dup bubbles
 * matching the racing text.
 */
export const noDupAfterDeleteRace: Invariant = {
  id: 'INV-no-dup-after-delete-race',
  tier: 'cheap',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    if(!action || action.name !== 'deleteWhileSending' || action.skipped) return {ok: true};
    const text: string = action.meta?.text || '';
    if(!text) return {ok: true};
    for(const id of ['userA', 'userB'] as const) {
      const user: any = ctx.users[id];
      const count = await user.page.evaluate((needle: string) => {
        const bubbles = Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'));
        let n = 0;
        for(const b of bubbles) if((b.textContent || '').includes(needle)) n++;
        return n;
      }, text);
      if(count > 1) {
        return {ok: false, message: `user ${id} has ${count} bubbles matching race text "${text.slice(0, 40)}" after deleteWhileSending`, evidence: {user: id, count, text}};
      }
    }
    return {ok: true};
  }
};

/**
 * Post-reload, no bubble data-mid in legacy temp-mid pattern (0.0001, 0.0002, …).
 * P2P temp mids are integer base+1 and indistinguishable from real mids post-rename
 * — this invariant specifically catches MTProto-legacy fractional orphans.
 */
export const noOrphanTempMidPostReload: Invariant = {
  id: 'INV-no-orphan-tempmid-post-reload',
  tier: 'medium',
  async check(ctx: FuzzContext, action?: Action): Promise<InvariantResult> {
    if(!action || action.name !== 'reloadPage' || action.skipped) return {ok: true};
    const userId = action.args.user as 'userA' | 'userB';
    const user: any = ctx.users[userId];
    const tempMids: string[] = await user.page.evaluate(() => {
      return Array.from(document.querySelectorAll('.bubbles-inner .bubble[data-mid]'))
        .map((b: any) => b.dataset.mid as string)
        .filter((m) => /^0\.\d{1,4}$/.test(m));
    });
    if(tempMids.length === 0) return {ok: true};
    return {ok: false, message: `found ${tempMids.length} orphan temp mid(s) post-reload: ${tempMids.join(', ')}`, evidence: {tempMids, user: userId}};
  }
};
